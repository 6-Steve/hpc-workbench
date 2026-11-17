/**
 * 目录增量同步：比对两棵树的差异。
 *
 * ## 语义先说清（这是这个功能最危险的部分）
 *
 * "同步"在别的工具里有六种意思，其中一种会删掉你集群上的实验结果。这里定死三条：
 *
 * 1. **绝不删除目标端的文件**。目标端独有的文件只统计（`orphan`），不动。
 * 2. **目标更新时不覆盖**（`mtime_target > mtime_source + 容差`）。集群上刚改过的脚本
 *    不能被本地旧版本盖掉，而且盖掉之后没有回收站。
 * 3. **目录不参与覆盖**。类型冲突（文件 vs 目录）一律进 `conflict` 并跳过。
 *
 * ## 为什么用 size + mtime 而不是 hash
 *
 * 算 hash 要把两边全读一遍：远端那侧等于把几 GB 数据经 SSH 拉回本地——正是要省掉的那笔开销。
 * 代价是"同一秒内改过且大小不变"会漏，所以界面给一个「强制全部重传」的开关。
 * 这条边界写在这里，比藏在实现里诚实。
 */
import { lstat, readdir } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type { Session } from '../ssh/session'
import { shq } from '../ssh/shell'

/** 一条树节点。`rel` 一律用 `/` 分隔，和服务端的 `%P` 对齐 */
export interface TreeEntry {
  rel: string
  kind: 'file' | 'dir' | 'symlink'
  size: number
  /** 秒（可能带小数） */
  mtime: number
}

export type SyncAction = 'new' | 'update' | 'conflict'

export interface SyncItem {
  rel: string
  action: SyncAction
  sourceSize: number
  targetSize?: number
  sourceMtime: number
  targetMtime?: number
  /** 给界面显示的一句话原因（冲突时尤其需要） */
  reason?: string
}

export interface SyncDiff {
  /** 需要传的（new + update，勾了"覆盖更新的目标"时也包含那部分 conflict） */
  toTransfer: SyncItem[]
  /** 跳过但需要告诉用户的：目标更新 / 类型冲突 */
  conflicts: SyncItem[]
  /** 目标端独有的文件数（只统计，不处理） */
  orphanCount: number
  counts: { new: number; update: number; same: number; conflict: number; orphan: number }
  /** 变更占比过高时建议整包传 */
  suggestFull: boolean
  suggestions: string[]
}

export interface SyncOptions {
  /** 目标比源新时也覆盖（默认 false） */
  overwriteNewer?: boolean
  /** 忽略 size/mtime 全部重传 */
  force?: boolean
  /** mtime 容差，默认 2 秒 */
  toleranceSec?: number
}

export const SYNC_LIMITS = {
  /** 单次扫描条目上限，超过就截断并建议改用整包 */
  maxEntries: 50_000,
  /** 远端 find 超时。NFS home 上可能很慢，超时就降级整包 */
  findTimeoutMs: 30_000,
  /** mtime 容差：吸收 NTFS/ext4 精度差和 tar 往返掉精度 */
  toleranceSec: 2,
  /** 变更文件数超过这个值，整包更快 */
  suggestFullCount: 500,
  /** 变更占比超过这个值，整包更快 */
  suggestFullRatio: 0.4
} as const

/** 解析 `find -printf '%y\t%s\t%T@\t%P\0'` 的输出 */
export function parseFindOutput(stdout: string): { entries: TreeEntry[]; warnings: string[] } {
  const entries: TreeEntry[] = []
  const warnings: string[] = []

  for (const record of stdout.split('\0')) {
    if (!record) continue
    /*
     * 按 `\t` 切，但**文件名里可能有制表符**——只认前三个分隔符，后面全算路径。
     * 这就是为什么不能 `${type}\t...` 直接 split('\t') 取第 4 个。
     */
    const first = record.indexOf('\t')
    const second = first >= 0 ? record.indexOf('\t', first + 1) : -1
    const third = second >= 0 ? record.indexOf('\t', second + 1) : -1
    if (third < 0) {
      warnings.push(`有一行 find 输出格式不对，已跳过：${record.slice(0, 80)}`)
      continue
    }

    const type = record.slice(0, first)
    const size = Number(record.slice(first + 1, second))
    const mtime = Number(record.slice(second + 1, third))
    const rel = record.slice(third + 1)

    if ((type !== 'f' && type !== 'd' && type !== 'l') || !Number.isFinite(size) || !Number.isFinite(mtime) || !rel) {
      warnings.push(`有一行 find 输出看不懂，已跳过：${record.slice(0, 80)}`)
      continue
    }

    entries.push({
      rel,
      kind: type === 'f' ? 'file' : type === 'd' ? 'dir' : 'symlink',
      size,
      mtime
    })
  }

  return { entries, warnings }
}

/** 远端目录树。读不到就抛（调用方决定降级成整包） */
export async function listRemoteTree(
  session: Session,
  dir: string,
  options: { timeoutMs?: number } = {}
): Promise<{ entries: TreeEntry[]; warnings: string[]; truncated: boolean }> {
  /*
   * `%P` 给相对路径（和本地 walk 天然对齐）；`\0` 结尾让空格/中文/换行都安全；
   * `2>/dev/null` 让无权限的子目录不中断整次扫描（有读不到的地方会在 stderr 里丢，
   * 这里如实告诉用户"可能有目录没读到"）。
   */
  const command =
    `find ${shq(dir)} -mindepth 1 \\( -type f -o -type d -o -type l \\) ` +
    `-printf '%y\\t%s\\t%T@\\t%P\\0' 2>/dev/null`

  const result = await session.exec(command, { timeoutMs: options.timeoutMs ?? SYNC_LIMITS.findTimeoutMs })
  const { entries, warnings } = parseFindOutput(result.stdout)
  const truncated = entries.length > SYNC_LIMITS.maxEntries

  return {
    entries: truncated ? entries.slice(0, SYNC_LIMITS.maxEntries) : entries,
    warnings: result.stderr.trim() ? [...warnings, `扫描时有目录读不到：${result.stderr.trim().slice(0, 200)}`] : warnings,
    truncated
  }
}

/** 本地目录树（`rel` 用 `/`，跨平台一致） */
export async function listLocalTree(
  dir: string,
  options: { maxEntries?: number } = {}
): Promise<{ entries: TreeEntry[]; warnings: string[]; truncated: boolean }> {
  const limit = options.maxEntries ?? SYNC_LIMITS.maxEntries
  const entries: TreeEntry[] = []
  const warnings: string[] = []
  let truncated = false

  const walk = async (absolute: string, prefix: string): Promise<void> => {
    if (truncated) return
    let items
    try {
      items = await readdir(absolute, { withFileTypes: true })
    } catch (err) {
      warnings.push(`读不了 ${prefix || absolute}：${err instanceof Error ? err.message : String(err)}`)
      return
    }

    for (const item of items) {
      if (entries.length >= limit) {
        truncated = true
        return
      }
      const rel = prefix ? `${prefix}/${item.name}` : item.name
      const full = join(absolute, item.name)

      if (item.isSymbolicLink()) {
        // 不跟随：跟进去可能跨出目录、可能成环，也可能指向集群上没有的东西
        entries.push({ rel, kind: 'symlink', size: 0, mtime: 0 })
        continue
      }
      if (item.isDirectory()) {
        entries.push({ rel, kind: 'dir', size: 0, mtime: 0 })
        await walk(full, rel)
        continue
      }
      try {
        const info = await lstat(full)
        entries.push({ rel, kind: 'file', size: info.size, mtime: info.mtimeMs / 1000 })
      } catch (err) {
        warnings.push(`读不了 ${rel}：${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  await walk(dir, '')
  return { entries, warnings, truncated }
}

/**
 * 比对。
 *
 * `source` 是"应该长成什么样"的一侧（上传时是本地，下载时是远端），完全对称。
 */
export function diffTrees(
  source: readonly TreeEntry[],
  target: readonly TreeEntry[],
  options: SyncOptions = {}
): SyncDiff {
  const tolerance = options.toleranceSec ?? SYNC_LIMITS.toleranceSec
  const targetByRel = new Map(target.map((entry) => [entry.rel, entry]))
  const sourceRels = new Set(source.map((entry) => entry.rel))

  const toTransfer: SyncItem[] = []
  const conflicts: SyncItem[] = []
  const counts = { new: 0, update: 0, same: 0, conflict: 0, orphan: 0 }
  let sourceFiles = 0

  for (const entry of source) {
    if (entry.kind !== 'file') continue
    sourceFiles += 1
    const other = targetByRel.get(entry.rel)

    if (!other) {
      counts.new += 1
      toTransfer.push({
        rel: entry.rel,
        action: 'new',
        sourceSize: entry.size,
        sourceMtime: entry.mtime
      })
      continue
    }

    if (other.kind !== 'file') {
      // 源是文件、目标是目录（或符号链接）：绝不覆盖
      counts.conflict += 1
      const item: SyncItem = {
        rel: entry.rel,
        action: 'conflict',
        sourceSize: entry.size,
        sourceMtime: entry.mtime,
        targetSize: other.size,
        targetMtime: other.mtime,
        reason: other.kind === 'dir' ? '目标端同名的是一项目录，不能覆盖' : '目标端同名的是符号链接，不覆盖'
      }
      conflicts.push(item)
      if (options.overwriteNewer) toTransfer.push({ ...item, reason: '按你的选择覆盖' })
      continue
    }

    if (options.force) {
      counts.update += 1
      toTransfer.push({
        rel: entry.rel,
        action: 'update',
        sourceSize: entry.size,
        sourceMtime: entry.mtime,
        targetSize: other.size,
        targetMtime: other.mtime,
        reason: '强制重传'
      })
      continue
    }

    const delta = other.mtime - entry.mtime
    if (delta > tolerance) {
      /*
       * 目标比源新：默认不动。
       * 这是最容易被"同步"两个字骗到的地方——用户以为是镜像，其实这里会保护他。
       */
      counts.conflict += 1
      const item: SyncItem = {
        rel: entry.rel,
        action: 'conflict',
        sourceSize: entry.size,
        sourceMtime: entry.mtime,
        targetSize: other.size,
        targetMtime: other.mtime,
        reason: '目标端的文件更新，默认不覆盖'
      }
      conflicts.push(item)
      if (options.overwriteNewer) toTransfer.push({ ...item, reason: '按你的选择覆盖更新的目标' })
      continue
    }

    if (entry.size !== other.size || Math.abs(delta) > tolerance) {
      counts.update += 1
      toTransfer.push({
        rel: entry.rel,
        action: 'update',
        sourceSize: entry.size,
        sourceMtime: entry.mtime,
        targetSize: other.size,
        targetMtime: other.mtime,
        reason: entry.size !== other.size ? '大小不同' : '修改时间不同'
      })
      continue
    }

    counts.same += 1
  }

  const orphans = target.filter((entry) => entry.kind === 'file' && !sourceRels.has(entry.rel))
  counts.orphan = orphans.length

  const changed = counts.new + counts.update
  const suggestFull =
    changed > SYNC_LIMITS.suggestFullCount ||
    (sourceFiles > 0 && changed / sourceFiles > SYNC_LIMITS.suggestFullRatio)

  const suggestions: string[] = []
  if (suggestFull) {
    suggestions.push(
      `这次变动 ${changed}/${sourceFiles} 个文件，超过 ${Math.round(
        SYNC_LIMITS.suggestFullRatio * 100
      )}% 或 ${SYNC_LIMITS.suggestFullCount} 个——每传一个文件都要一次往返，整包传通常更快。`
    )
  }
  if (counts.conflict > 0) {
    suggestions.push(`有 ${counts.conflict} 个冲突默认跳过（目标端更新或类型不符），需要的话勾选"覆盖更新的目标"。`)
  }
  if (counts.orphan > 0) {
    suggestions.push(
      `目标端另有 ${counts.orphan} 个文件在这次同步范围里不存在——按设计**不会删除**它们，只在这里报数。`
    )
  }

  return { toTransfer, conflicts, orphanCount: counts.orphan, counts, suggestFull, suggestions }
}

/** 给确认框用的一句话 */
export function describeDiff(diff: SyncDiff): string {
  const { new: added, update, same, conflict } = diff.counts
  return `新增 ${added} · 更新 ${update} · 未变 ${same} · 冲突 ${conflict}`
}

/** 把相对路径拼成远端绝对路径（posix） */
export function posixJoin(dir: string, rel: string): string {
  const base = dir.endsWith('/') ? dir.slice(0, -1) : dir
  return `${base}/${rel.split('/').join('/')}`
}

/** 把相对路径拼成本地绝对路径 */
export function localJoin(dir: string, rel: string): string {
  return join(dir, ...rel.split('/'))
}

/** Windows 上 `relative()` 会给反斜杠，统一成 `/` 以便和服务端比对 */
export function normalizeRel(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/')
}
