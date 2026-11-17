/**
 * 目录列表：本地与远端各一份实现，输出同一种结构给界面。
 *
 * 两条不同来源的注意事项：
 * - **远端必须一次 `readdir` 拿全量属性**（SFTP 的 READDIR 响应里就带 attrs）。
 *   逐个文件 stat 会让 5000 个文件的目录变成 5000 次往返——这是同类工具最常见的性能事故。
 * - 本地反过来：`readdir` 只给类型不给大小，必须 stat；但本地 IO 便宜，加个并发上限就够。
 */
import { readdir, stat } from 'node:fs/promises'
import { dirname, sep as platformSep } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import { SshError } from '../ssh/errors'
import type { Session } from '../ssh/session'

export type EntryKind = 'file' | 'dir' | 'link' | 'other'

export interface DirEntry {
  name: string
  kind: EntryKind
  /** 目录为 null */
  size: number | null
  /** epoch 毫秒；未知为 null */
  mtime: number | null
}

export interface DirListing {
  side: 'local' | 'remote'
  path: string
  /** 上一级；已经是根目录时为 null。本地盘符根的上一级是「此电脑」 */
  parent: string | null
  /** 路径分隔符，界面拼子路径时用 */
  separator: string
  entries: DirEntry[]
  /** 条目过多被截断（不静默丢，界面要提示） */
  truncated: boolean
  /**
   * 虚拟根（「此电脑」）标记。
   *
   * 用显式字段而不是让界面去比对路径字符串：那个哨兵值定义在主进程，
   * 渲染层靠字面量复制一份迟早会不一致，而且不一致时是静默出错。
   */
  virtualRoot?: boolean
}

/** 单个目录最多返回多少条；超了截断并在界面上说明 */
export const MAX_ENTRIES = 5000
const LOCAL_STAT_CONCURRENCY = 32

function kindFromMode(mode: number): EntryKind {
  const type = mode & 0o170000
  if (type === 0o040000) return 'dir'
  if (type === 0o120000) return 'link'
  if (type === 0o100000) return 'file'
  return 'other'
}

/** 目录在前，然后按名字排（忽略大小写） */
function sortEntries(entries: DirEntry[]): DirEntry[] {
  return entries.sort((a, b) => {
    const aDir = a.kind === 'dir' ? 0 : 1
    const bDir = b.kind === 'dir' ? 0 : 1
    if (aDir !== bDir) return aDir - bDir
    return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
  })
}

// —————————————————————— 远端 ——————————————————————

function sftpCall<T>(label: string, run: (callback: (err: Error | null | undefined, value: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    run((err, value) => {
      if (err) {
        reject(
          new SshError({
            kind: 'remote',
            message: `${label}失败`,
            hint: '目录可能不存在，或当前账号没有读取权限。',
            raw: err.message
          })
        )
        return
      }
      resolve(value)
    })
  })
}

async function remoteRealpath(sftp: SFTPWrapper, path: string): Promise<string> {
  return sftpCall<string>('解析远端路径', (cb) => sftp.realpath(path, cb))
}

/**
 * 列远端目录。`path` 省略时用远端 home（`realpath('.')`），
 * 这样界面不需要提前知道 home 是多少（虽然能力探测里有，但两者可能不一致）。
 *
 * —— 为什么带缓存 ——
 * 实测：链路往返 59 ms，`readdir` 82 项 32 ms、
 * 429 项 210 ms。来回切目录时每一趟都要重付这份钱，而目录内容在几秒内
 * 几乎不会变。所以加一层很短的 TTL 缓存：返回上一级、重新进刚看过的目录
 * 都能秒开。
 *
 * 三条纪律：
 * 1. **写操作必须调 `invalidateListing`**，否则删完还能看到删掉的文件。
 * 2. **刷新按钮走 `noCache`**，用户要"现在立刻真实的样子"时必须给。
 * 3. TTL 只有几秒，宁可偶尔多读一次，也不要让用户看到过时的目录。
 */
const REMOTE_CACHE_TTL_MS = 8_000
const remoteCache = new Map<string, { listing: DirListing; at: number }>()

/** 缓存键带上 profile，避免切换主机时串味 */
function cacheKey(session: Session, path: string): string {
  return `${session.profile.id}:${path}`
}

/** 目录内容变了的路径要清掉；父目录也要清（增删都会改变父目录） */
export function invalidateListing(session: Session, path: string): void {
  remoteCache.delete(cacheKey(session, path))
  const parent = dirname(path)
  if (parent && parent !== path) remoteCache.delete(cacheKey(session, parent))
}

export function clearListingCache(): void {
  remoteCache.clear()
}

export async function listRemoteDir(
  session: Session,
  path?: string,
  options: { noCache?: boolean } = {}
): Promise<DirListing> {
  const sftp = await session.sftp()
  const target = path && path.trim().length > 0 ? path.trim() : await remoteRealpath(sftp, '.')

  if (!options.noCache) {
    const hit = remoteCache.get(cacheKey(session, target))
    if (hit && Date.now() - hit.at < REMOTE_CACHE_TTL_MS) return hit.listing
  }

  const raw = await sftpCall<Array<{ filename: string; attrs: { mode: number; size: number; mtime: number } }>>(
    `读取目录 ${target}`,
    (cb) => sftp.readdir(target, cb)
  )

  const truncated = raw.length > MAX_ENTRIES
  const entries: DirEntry[] = raw.slice(0, MAX_ENTRIES)
    .filter((item) => item.filename !== '.' && item.filename !== '..')
    .map((item) => {
      const kind = kindFromMode(item.attrs.mode)
      return {
        name: item.filename,
        kind,
        size: kind === 'dir' ? null : item.attrs.size,
        mtime: item.attrs.mtime > 0 ? item.attrs.mtime * 1000 : null
      }
    })

  const parent = target === '/' ? null : dirname(target)

  const listing: DirListing = {
    side: 'remote',
    path: target,
    parent,
    separator: '/',
    entries: sortEntries(entries),
    truncated
  }

  remoteCache.set(cacheKey(session, target), { listing, at: Date.now() })
  return listing
}

// —————————————————————— 本地 ——————————————————————

/** 本地并发 stat，避免几千个文件时把事件循环压死 */
async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index]!)
    }
  })

  await Promise.all(runners)
  return results
}

/**
 * 「此电脑」这一层的虚拟路径。
 *
 * 为什么需要它：`C:\` 的 `dirname` 还是 `C:\`，没有上级可言，
 * 所以从家目录一路往上点到盘符根就卡死了，D 盘 E 盘根本出不来。
 * 用一个不可能与真实路径冲突的哨兵值当虚拟根，进入/返回都在界面层特判。
 */
export const DRIVES_ROOT = '::drives::'

/** 判断是不是盘符根，比如 `C:\` */
function isDriveRoot(path: string): boolean {
  return /^[a-zA-Z]:[\\/]?$/.test(path)
}

/**
 * 列出所有盘符。Windows 上没有现成的"枚举驱动器"API，
 * 逐个探测 A–Z 是最省事也最可靠的办法（26 次 stat，几毫秒）。
 * 光驱没插盘时 stat 会抛错，用 try/catch 吞掉即可。
 */
async function listDrives(): Promise<DirListing> {
  const entries: DirEntry[] = []

  if (process.platform === 'win32') {
    for (let code = 65; code <= 90; code += 1) {
      const letter = String.fromCharCode(code)
      try {
        const info = await stat(`${letter}:\\`)
        if (!info.isDirectory()) continue
        entries.push({ name: `${letter}:`, kind: 'dir', size: null, mtime: null })
      } catch {
        // 这个盘符不存在（或者光驱里没盘），跳过
      }
    }
  } else {
    // 非 Windows 只有一棵树，`/` 就是根
    entries.push({ name: '/', kind: 'dir', size: null, mtime: null })
  }

  return {
    side: 'local',
    path: DRIVES_ROOT,
    parent: null,
    separator: process.platform === 'win32' ? '\\' : '/',
    entries,
    truncated: false,
    virtualRoot: true
  }
}

export async function listLocalDir(path?: string): Promise<DirListing> {
  if (path === DRIVES_ROOT) return listDrives()

  const target = path && path.trim().length > 0 ? path : process.env['USERPROFILE'] ?? process.env['HOME'] ?? '.'

  let dirents
  try {
    dirents = await readdir(target, { withFileTypes: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    const message =
      code === 'ENOENT'
        ? `目录不存在：${target}`
        : code === 'EACCES' || code === 'EPERM'
          ? `没有权限读取：${target}`
          : `读取目录失败：${target}`
    throw new SshError({
      kind: 'config',
      message,
      hint: code === 'ENOENT' ? '路径可能被删掉了，点上面的上一级回去。' : '换一个目录，或用管理员权限运行。',
      raw: `${(err as Error).message}`
    })
  }

  const truncated = dirents.length > MAX_ENTRIES
  const selected = dirents.slice(0, MAX_ENTRIES)

  const entries = await mapLimit(selected, LOCAL_STAT_CONCURRENCY, async (dirent): Promise<DirEntry> => {
    const child = `${target}${target.endsWith(platformSep) ? '' : platformSep}${dirent.name}`
    const kind: EntryKind = dirent.isDirectory()
      ? 'dir'
      : dirent.isSymbolicLink()
        ? 'link'
        : dirent.isFile()
          ? 'file'
          : 'other'

    if (kind === 'dir') {
      return { name: dirent.name, kind, size: null, mtime: null }
    }

    try {
      const info = await stat(child)
      return { name: dirent.name, kind, size: info.size, mtime: info.mtimeMs }
    } catch {
      // 单个文件 stat 失败（权限、刚被删）不该让整个目录挂掉
      return { name: dirent.name, kind, size: null, mtime: null }
    }
  })

  // 盘符根（C:\）的上级是「此电脑」，不是它自己
  const parentCandidate = dirname(target)
  const parent = isDriveRoot(target)
    ? DRIVES_ROOT
    : parentCandidate === target
      ? null
      : parentCandidate

  return {
    side: 'local',
    path: target,
    parent,
    separator: platformSep,
    entries: sortEntries(entries),
    truncated
  }
}
