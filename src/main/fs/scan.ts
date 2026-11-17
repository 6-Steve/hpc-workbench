/**
 * 传输前扫描：算出「多少个文件 / 多大 / 最大文件多大」。
 *
 * 这是决策矩阵的输入，也是确认框里那几个数字的来源。
 * 扫描本身有代价（远端目录要逐个 readdir），所以：
 * - 有硬上限，超了返回 `truncated`，让上层明说"这个数是不完整的"
 * - 只统计，不读文件内容
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import { SshError } from '../ssh/errors'
import type { Session } from '../ssh/session'

export interface PathStats {
  fileCount: number
  dirCount: number
  totalBytes: number
  largestFileBytes: number
  /** 条目数超过上限，数字不完全准确 */
  truncated: boolean
}

/** 单个路径最多统计多少条，防止误拖一个巨大的目录把界面卡死 */
export const MAX_SCAN_ENTRIES = 20_000

const EMPTY: PathStats = { fileCount: 0, dirCount: 0, totalBytes: 0, largestFileBytes: 0, truncated: false }

function merge(a: PathStats, b: PathStats): PathStats {
  return {
    fileCount: a.fileCount + b.fileCount,
    dirCount: a.dirCount + b.dirCount,
    totalBytes: a.totalBytes + b.totalBytes,
    largestFileBytes: Math.max(a.largestFileBytes, b.largestFileBytes),
    truncated: a.truncated || b.truncated
  }
}

// —————————————————————— 本地 ——————————————————————

export async function scanLocalPath(path: string): Promise<PathStats> {
  let info
  try {
    info = await stat(path)
  } catch (err) {
    throw new SshError({
      kind: 'config',
      message: `读不到：${path}`,
      hint: '文件可能刚被删掉或移动了。',
      raw: (err as Error).message
    })
  }

  if (info.isFile()) {
    return { fileCount: 1, dirCount: 0, totalBytes: info.size, largestFileBytes: info.size, truncated: false }
  }
  if (!info.isDirectory()) {
    return EMPTY
  }

  return walkLocal(path)
}

async function walkLocal(root: string): Promise<PathStats> {
  let stats: PathStats = { ...EMPTY }
  let counted = 0
  const queue: string[] = [root]

  while (queue.length > 0) {
    const current = queue.shift()!
    let dirents
    try {
      dirents = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }

    for (const dirent of dirents) {
      if (counted >= MAX_SCAN_ENTRIES) {
        return { ...stats, truncated: true }
      }
      counted += 1

      const child = join(current, dirent.name)
      if (dirent.isDirectory()) {
        stats.dirCount += 1
        queue.push(child)
        continue
      }
      if (dirent.isSymbolicLink()) continue

      try {
        const childInfo = await stat(child)
        stats.fileCount += 1
        stats.totalBytes += childInfo.size
        stats.largestFileBytes = Math.max(stats.largestFileBytes, childInfo.size)
      } catch {
        // 单个文件读不到就跳过，不影响整体统计
      }
    }
  }

  return stats
}

// —————————————————————— 远端 ——————————————————————

interface RemoteAttrs {
  mode: number
  size: number
}

function sftpStat(sftp: SFTPWrapper, path: string): Promise<RemoteAttrs | null> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (err, attrs) => {
      if (err) {
        if ((err as Error & { code?: number }).code === 2) resolve(null)
        else {
          reject(
            new SshError({
              kind: 'remote',
              message: `读不到远端路径：${path}`,
              hint: '可能没有权限，或目录已经被删了。',
              raw: err.message
            })
          )
        }
        return
      }
      resolve({ mode: attrs.mode, size: attrs.size })
    })
  })
}

function sftpReaddir(sftp: SFTPWrapper, path: string): Promise<Array<{ filename: string; attrs: RemoteAttrs }>> {
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (err, list) => {
      if (err) {
        reject(
          new SshError({
            kind: 'remote',
            message: `读不到远端目录：${path}`,
            raw: err.message
          })
        )
        return
      }
      resolve(list as Array<{ filename: string; attrs: RemoteAttrs }>)
    })
  })
}

const isDirMode = (mode: number): boolean => (mode & 0o170000) === 0o040000
const isFileMode = (mode: number): boolean => (mode & 0o170000) === 0o100000

export async function scanRemotePath(session: Session, path: string): Promise<PathStats> {
  const sftp = await session.sftp()
  const info = await sftpStat(sftp, path)

  if (!info) {
    throw new SshError({
      kind: 'remote',
      message: `远端路径不存在：${path}`,
      hint: '可能是符号链接指向了别处，或刚被删掉了。',
      raw: path
    })
  }

  if (isFileMode(info.mode)) {
    return { fileCount: 1, dirCount: 0, totalBytes: info.size, largestFileBytes: info.size, truncated: false }
  }
  if (!isDirMode(info.mode)) return EMPTY

  let stats: PathStats = { ...EMPTY }
  let counted = 0
  const queue: string[] = [path]

  while (queue.length > 0) {
    const current = queue.shift()!
    const entries = await sftpReaddir(sftp, current).catch(() => [])

    for (const entry of entries) {
      if (entry.filename === '.' || entry.filename === '..') continue
      if (counted >= MAX_SCAN_ENTRIES) return { ...stats, truncated: true }
      counted += 1

      if (isDirMode(entry.attrs.mode)) {
        stats.dirCount += 1
        queue.push(current === '/' ? `/${entry.filename}` : `${current}/${entry.filename}`)
        continue
      }
      if (isFileMode(entry.attrs.mode)) {
        stats.fileCount += 1
        stats.totalBytes += entry.attrs.size
        stats.largestFileBytes = Math.max(stats.largestFileBytes, entry.attrs.size)
      }
    }
  }

  return stats
}

/** 合并多个路径的统计（一次拖多个文件时用） */
export function sumStats(list: PathStats[]): PathStats {
  return list.reduce((acc, item) => merge(acc, item), { ...EMPTY })
}

/** 远端路径是文件还是目录；不存在返回 null */
export async function remoteKindOf(session: Session, path: string): Promise<'file' | 'dir' | 'other' | null> {
  const sftp = await session.sftp()
  const info = await sftpStat(sftp, path)
  if (!info) return null
  if (isDirMode(info.mode)) return 'dir'
  if (isFileMode(info.mode)) return 'file'
  return 'other'
}
