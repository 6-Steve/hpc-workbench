/**
 * 传输计划：扫描 → 推荐策略 → 生成任务清单。
 *
 * 这个模块存在的唯一理由就是「先给用户看一眼」（docs/02 §2.5 最后一段）。
 * 拖完直接开传是最容易误操作的实现——手滑拖错一个 200 GB 的数据集目录，
 * 等到发现时已经传了半小时。所以中间必须有这一步，且必须把"为什么这么选"说清楚。
 *
 * 计划会缓存下来，确认时按 id 取回，**不重新扫描**（大目录扫描一次已经不便宜）。
 */
import { stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Session } from '../ssh/session'
import { remoteKindOf, scanLocalPath, scanRemotePath, sumStats, type PathStats } from '../fs/scan'
import { decideStrategy, describeDecision, type StrategyDecision } from './engine'
import {
  describeDiff,
  diffTrees,
  listLocalTree,
  listRemoteTree,
  localJoin,
  SYNC_LIMITS,
  type SyncDiff
} from './sync'
import { shq } from '../ssh/shell'
import { existsSync } from 'node:fs'
import { SshError } from '../ssh/errors'

export type TransferDirection = 'upload' | 'download'

export interface PlanRequest {
  direction: TransferDirection
  /** 源路径：upload 时是本地，download 时是远端 */
  paths: string[]
  /** 目标目录：upload 时是远端，download 时是本地 */
  targetDir: string
  /**
   * `copy`（默认）= 原样传；`sync` = 先比对，只传新增/变更的文件。
   *
   * sync **只接受单个目录**，而且是"只增不删"的语义（见 `sync.ts` 顶部）。
   */
  mode?: 'copy' | 'sync'
  sync?: {
    /** 目标比源新时也覆盖（默认 false） */
    overwriteNewer?: boolean
    /** 忽略 size/mtime，全部重传 */
    force?: boolean
  }
}

/** 增量同步的摘要，随计划一起给界面显示（只放可结构化克隆的字段） */
export interface SyncSummary {
  counts: SyncDiff['counts']
  conflicts: Array<{ rel: string; reason?: string }>
  suggestFull: boolean
  suggestions: string[]
  sourceRoot: string
  targetRoot: string
}

export interface PlanItem {
  name: string
  kind: 'file' | 'dir'
  /** 源完整路径 */
  source: string
  /** 目标完整路径 */
  target: string
  stats: PathStats
}

export interface TransferPlan {
  id: string
  direction: TransferDirection
  targetDir: string
  items: PlanItem[]
  stats: PathStats
  decision: StrategyDecision
  /** 给确认框用的那一句 "检测到 … 将使用 …" */
  summary: string
  warnings: string[]
  /** 这次传不了的条目及原因，界面要显示出来而不是默默少传 */
  unsupported: Array<{ name: string; reason: string }>
  createdAt: number
  /** 计划类型。sync 时 `items` 里只有需要传的文件 */
  mode: 'copy' | 'sync'
  /** 仅 sync 有 */
  sync?: SyncSummary
}

const posixJoin = (dir: string, name: string): string => (dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`)

export async function planTransfer(session: Session, request: PlanRequest): Promise<TransferPlan> {
  if (request.mode === 'sync') return planSync(session, request)

  const items: PlanItem[] = []
  const unsupported: Array<{ name: string; reason: string }> = []
  const perPath: PathStats[] = []

  for (const source of request.paths) {
    const name = request.direction === 'upload' ? basename(source) : source.slice(source.lastIndexOf('/') + 1)

    if (request.direction === 'upload') {
      const stats = await scanLocalPath(source)
      // 判断是文件还是目录：单文件时 scan 返回 fileCount=1/dirCount=0，靠 dirCount 区分不了空目录
      const kind: 'file' | 'dir' = await isLocalDir(source) ? 'dir' : 'file'
      items.push({ name, kind, source, target: posixJoin(request.targetDir, name), stats })
      perPath.push(stats)
      continue
    }

    const kind = await remoteKindOf(session, source)
    if (kind === null) {
      unsupported.push({ name, reason: '远端的这个路径读不到' })
      continue
    }
    if (kind === 'other') {
      unsupported.push({ name, reason: '不是普通文件或目录' })
      continue
    }

    const stats = await scanRemotePath(session, source)
    items.push({ name, kind, source, target: join(request.targetDir, name), stats })
    perPath.push(stats)
  }

  const stats = sumStats(perPath)
  const hasDirectory = items.some((item) => item.kind === 'dir')

  // 含目录时 tar 是唯一能保持目录结构的路；其余按矩阵判断
  const decision: StrategyDecision = hasDirectory
    ? {
        strategy: 'tar',
        effective: 'tar',
        avgBytes: stats.fileCount > 0 ? stats.totalBytes / stats.fileCount : 0,
        reason:
          request.direction === 'upload'
            ? '选中项里包含目录，用 tar 才能保持目录结构'
            : '选中项里包含目录，用 tar 整包下载才能保持目录结构（本地无需安装 tar）',
        warnings: []
      }
    : decideStrategy({
        fileCount: stats.fileCount,
        totalBytes: stats.totalBytes,
        largestFileBytes: stats.largestFileBytes
      })

  const warnings = [...decision.warnings]
  if (stats.truncated) {
    warnings.push('条目太多，统计只覆盖了前 20000 项，实际体积可能更大')
  }
  if (unsupported.length > 0) {
    warnings.push(`有 ${unsupported.length} 项本次不会传输`)
  }

  return {
    id: `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    direction: request.direction,
    targetDir: request.targetDir,
    items,
    stats,
    decision,
    summary: `${describeDecision(decision, { fileCount: stats.fileCount, totalBytes: stats.totalBytes, largestFileBytes: stats.largestFileBytes })}，目标 ${request.targetDir}`,
    warnings,
    unsupported,
    createdAt: Date.now(),
    mode: 'copy'
  }
}

async function isLocalDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}


/**
 * 增量同步的计划。
 *
 * 和 `copy` 最大的区别：`items` 里**只有需要传的文件**，其余（未变、冲突、目标独有）
 * 只体现在 `sync` 摘要里。所以 `service.start()` 一行都不用改——
 * 它本来就是把 `plan.items` 逐条入队。
 */
async function planSync(session: Session, request: PlanRequest): Promise<TransferPlan> {
  if (request.paths.length !== 1) {
    throw new SshError({
      kind: 'config',
      message: '同步一次只能针对一个目录',
      hint: '在目录上右键选「同步到对面…」。',
      raw: JSON.stringify(request.paths)
    })
  }

  const source = request.paths[0]!
  const uploading = request.direction === 'upload'
  const name = uploading ? basename(source) : source.slice(source.lastIndexOf('/') + 1)

  // 源必须是目录：同步一个文件没有意义（单文件已有"覆盖/跳过"的流程）
  const sourceIsDir = uploading ? await isLocalDir(source) : (await remoteKindOf(session, source)) === 'dir'
  if (!sourceIsDir) {
    throw new SshError({
      kind: 'config',
      message: '只能同步目录',
      hint: '单个文件的传输请直接拖动，或右键「下载到…」。',
      raw: source
    })
  }

  const targetRoot = uploading ? posixJoin(request.targetDir, name) : join(request.targetDir, name)
  const warnings: string[] = []

  const sourceListing = uploading ? await listLocalTree(source) : await listRemoteTree(session, source)
  warnings.push(...sourceListing.warnings)
  if (sourceListing.truncated) {
    warnings.push(`条目超过 ${SYNC_LIMITS.maxEntries} 条，只比对了前一部分，建议改用整包传输`)
  }

  /*
   * 目标根目录存不存在要分开判断。
   * 不存在不是错误——第一次同步时必然不存在，那所有文件都算"新增"。
   * 但不能悄悄当成空的：界面上要说明白，否则用户以为比对过了。
   */
  let targetEntries: Awaited<ReturnType<typeof listLocalTree>>['entries'] = []
  if (uploading) {
    const probe = await session.exec(`test -d ${shq(targetRoot)} && echo yes || echo no`)
    if (probe.stdout.trim() === 'yes') {
      targetEntries = (await listRemoteTree(session, targetRoot)).entries
    } else {
      warnings.push(`目标目录 ${targetRoot} 还不存在，这次全部按新增处理`)
    }
  } else if (existsSync(targetRoot)) {
    targetEntries = (await listLocalTree(targetRoot)).entries
  } else {
    warnings.push(`本地目录 ${targetRoot} 还不存在，这次全部按新增处理`)
  }

  const diff = diffTrees(sourceListing.entries, targetEntries, request.sync ?? {})

  if (diff.toTransfer.length === 0) {
    throw new SshError({
      kind: 'config',
      message: `两边已经一致（${describeDiff(diff)}），没有需要传的文件`,
      hint: '如果确定内容变了但大小和修改时间都没变，勾选「强制全部重传」再试。',
      raw: JSON.stringify(diff.counts)
    })
  }

  const items: PlanItem[] = diff.toTransfer.map((entry) => ({
    name: entry.rel,
    kind: 'file' as const,
    source: uploading ? localJoin(source, entry.rel) : posixJoin(source, entry.rel),
    target: uploading ? posixJoin(targetRoot, entry.rel) : localJoin(targetRoot, entry.rel),
    stats: {
      fileCount: 1,
      dirCount: 0,
      totalBytes: entry.sourceSize,
      largestFileBytes: entry.sourceSize,
      truncated: false
    }
  }))

  const totalBytes = items.reduce((sum, item) => sum + item.stats.totalBytes, 0)
  const largestFileBytes = items.reduce((max, item) => Math.max(max, item.stats.largestFileBytes), 0)
  const stats: PathStats = {
    fileCount: items.length,
    dirCount: 0,
    totalBytes,
    largestFileBytes,
    truncated: sourceListing.truncated
  }

  const decision: StrategyDecision = {
    strategy: 'sftp',
    effective: 'sftp',
    avgBytes: items.length > 0 ? totalBytes / items.length : 0,
    reason: '增量同步：只传新增和变更的文件',
    warnings: []
  }

  const unsupported = [
    ...sourceListing.entries
      .filter((entry) => entry.kind === 'symlink')
      .map((entry) => ({ name: entry.rel, reason: '符号链接不参与同步（不跟随，避免跨出目录）' })),
    ...diff.conflicts.map((entry) => ({ name: entry.rel, reason: entry.reason ?? '冲突，已跳过' }))
  ]

  warnings.push(...diff.suggestions)

  return {
    id: `plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    direction: request.direction,
    targetDir: request.targetDir,
    items,
    stats,
    decision,
    summary: `同步 ${name}/ → ${targetRoot}：${describeDiff(diff)}`,
    warnings,
    unsupported,
    createdAt: Date.now(),
    mode: 'sync',
    sync: {
      counts: diff.counts,
      conflicts: diff.conflicts.map((entry) => ({ rel: entry.rel, reason: entry.reason })),
      suggestFull: diff.suggestFull,
      suggestions: diff.suggestions,
      sourceRoot: source,
      targetRoot
    }
  }
}
