/**
 * tar 流式上传（单段版本，最初用来验证链路可行性）。
 *
 * 数据路径：本地读文件 → tar-stream 打包 → SSH channel → 远端 `tar -x`
 * 全程不落地，文件边界只是 512 字节头部，没有逐文件往返（docs/02 §2.1）。
 *
 * 三条硬约束（docs/04 E2/E3、docs/02 §2.4）：
 * 1. 只通过 `Session.pipe` 走 `stream.pipeline`，靠它传导背压
 * 2. **远端退出码必须检查**——本地写完不代表远端解开成功，不查就是静默丢数据
 * 3. 先解到 `<dest>.partial/`，全部成功后再 `mv` 改名；改名在同文件系统内是原子的
 *
 * 分段（2 GB/段）与段级续传还没做，这里刻意不做。
 */
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { pack as createTar, type Pack } from 'tar-stream'
import { SshError } from '../ssh/errors'
import type { Session } from '../ssh/session'
import { shq } from '../ssh/shell'
import { ALREADY_EXISTS } from './sftp'
import { ProgressMeter, formatBytes, formatRate, type ProgressListener } from './progress'

export interface UploadOptions {
  /** 本地目录，其内容会成为远端的顶层内容（不含目录本身） */
  localDir: string
  /** 远端目标目录，必须不存在 */
  remoteDir: string
  onProgress?: ProgressListener
  timeoutMs?: number
}

export interface UploadResult {
  files: number
  dirs: number
  /** 跳过的符号链接数（本版本不跟随即复制） */
  skippedLinks: number
  bytes: number
  durationMs: number
  bytesPerSecond: number
  /** 远端 `du -sb` 的结果，用于交叉校验 */
  remoteBytes: number | null
  remoteFiles: number | null
  /** 文件数一致且字节数在容差内 */
  verified: boolean
}

interface LocalEntry {
  abs: string
  /** 相对于 localDir 的 POSIX 风格路径 */
  rel: string
  size: number
  mtimeMs: number
  isDir: boolean
  isLink: boolean
}

async function walk(root: string): Promise<LocalEntry[]> {
  const entries: LocalEntry[] = []

  const visit = async (dir: string, prefix: string): Promise<void> => {
    const items = await readdir(dir, { withFileTypes: true })
    items.sort((a, b) => a.name.localeCompare(b.name))

    for (const item of items) {
      const abs = join(dir, item.name)
      const rel = prefix ? `${prefix}/${item.name}` : item.name

      if (item.isSymbolicLink()) {
        entries.push({ abs, rel, size: 0, mtimeMs: Date.now(), isDir: false, isLink: true })
        continue
      }
      if (item.isDirectory()) {
        entries.push({ abs, rel, size: 0, mtimeMs: Date.now(), isDir: true, isLink: false })
        await visit(abs, rel)
        continue
      }
      if (item.isFile()) {
        const info = await stat(abs)
        entries.push({ abs, rel, size: info.size, mtimeMs: info.mtimeMs, isDir: false, isLink: false })
      }
    }
  }

  await visit(root, '')
  return entries
}

/** 把本地目录打进 pack 流；写不进去就销毁 pack，让上游的 pipeline 收到错误 */
async function packEntries(pack: Pack, entries: LocalEntry[]): Promise<void> {
  for (const entry of entries) {
    if (entry.isLink) continue

    // Windows 的分隔符绝不能进远端路径（docs/04 E7）
    const name = entry.rel.split(sep).join('/')

    if (entry.isDir) {
      await new Promise<void>((resolve, reject) => {
        pack.entry({ name: `${name}/`, type: 'directory', mode: 0o755, mtime: new Date() }, (err) =>
          err ? reject(err) : resolve()
        )
      })
      continue
    }

    // 权限统一 644：Windows 没有 POSIX 权限位，不显式给会写出 000（docs/02 §2.4）
    await new Promise<void>((resolve, reject) => {
      // tar-stream v2：entry() 返回可写流，把文件流 pipe 进去（比传 stream 参数更类型安全，
      // @types 里那个重载没写全）
      const sink = pack.entry(
        { name, size: entry.size, mode: 0o644, type: 'file', mtime: new Date(entry.mtimeMs) },
        (err) => (err ? reject(err) : resolve())
      )
      createReadStream(entry.abs)
        .on('error', reject)
        .pipe(sink)
    })
  }

  pack.finalize()
}

export async function uploadDirectory(session: Session, options: UploadOptions): Promise<UploadResult> {
  const { localDir, remoteDir } = options
  const startedAt = Date.now()

  const entries = await walk(localDir)
  const skippedLinks = entries.filter((entry) => entry.isLink).length
  const files = entries.filter((entry) => !entry.isDir && !entry.isLink)
  const dirs = entries.filter((entry) => entry.isDir && !entry.isLink)
  const totalBytes = files.reduce((sum, entry) => sum + entry.size, 0)

  if (files.length === 0) {
    throw new SshError({
      kind: 'config',
      message: `本地目录里没有文件：${localDir}`,
      raw: localDir
    })
  }

  // 目标已存在就不动，绝不覆盖——宁可让用户自己决定
  const exists = await session.exec(`test -e ${shq(remoteDir)} && echo yes || echo no`)
  if (exists.stdout.trim() === 'yes') {
    throw new SshError({
      kind: 'remote',
      message: `远端已存在同名路径：${remoteDir}`,
      hint: '换个目标目录，或先确认里面是什么再手动删除。',
      raw: exists.stdout,
      code: ALREADY_EXISTS
    })
  }

  const partial = `${remoteDir}.partial`
  const meter = new ProgressMeter(options.onProgress ?? (() => {}), totalBytes)

  const pack = createTar()
  let producerError: unknown = null
  const producer = packEntries(pack, entries).catch((err: unknown) => {
    producerError = err
    pack.destroy(err as Error)
  })

  const result = await session.pipe(`mkdir -p ${shq(partial)} && tar -xf - -C ${shq(partial)}`, pack, {
    timeoutMs: options.timeoutMs,
    onProgress: (bytes) => meter.update(bytes)
  })
  meter.finish(result.bytes)
  await producer

  if (producerError) {
    await removeRemotePath(session, partial)
    throw new SshError({
      kind: 'config',
      message: '读取本地文件时出错，上传已中止',
      raw: (producerError as Error)?.message ?? String(producerError)
    })
  }

  // —— 远端退出码必须检查，这是最容易漏的一条 ——
  if (result.code !== 0) {
    const stderr = result.stderr.trim()
    await removeRemotePath(session, partial)
    throw new SshError({
      kind: 'remote',
      message: `远端解包失败（退出码 ${result.code ?? 'null'}）`,
      hint: '上面的原始信息通常能直接看出原因：磁盘满、权限不足、或 tar 不认识某种文件。',
      raw: [`$ tar -xf - -C ${partial}`, stderr || '（远端没有输出 stderr）'].join('\n'),
      code: String(result.code)
    })
  }

  // 全部解开之后再改名：同文件系统内 mv 是原子的
  const move = await session.exec(`mv ${shq(partial)} ${shq(remoteDir)}`)
  if (move.code !== 0) {
    await removeRemotePath(session, partial)
    throw new SshError({
      kind: 'remote',
      message: '解包成功，但改名失败',
      raw: [`$ mv ${partial} ${remoteDir}`, move.stderr.trim() || '（无输出）'].join('\n')
    })
  }

  // —— 传完自动核对一次，这是成本最低的兜底（docs/02 §2.4）——
  const check = await session.exec(`du -sb ${shq(remoteDir)} && find ${shq(remoteDir)} -type f | wc -l`)
  let remoteBytes: number | null = null
  let remoteFiles: number | null = null

  if (check.code === 0) {
    const [duLine = '', countLine = ''] = check.stdout.trim().split('\n')
    const parsedBytes = Number.parseInt(duLine.split(/\s+/)[0] ?? '', 10)
    const parsedFiles = Number.parseInt(countLine.trim(), 10)
    remoteBytes = Number.isNaN(parsedBytes) ? null : parsedBytes
    remoteFiles = Number.isNaN(parsedFiles) ? null : parsedFiles
  }

  const durationMs = Date.now() - startedAt
  // du 会把目录本身的块也算进去，所以字节数允许一点容差；文件数必须严格相等
  const tolerance = Math.max(4096 * (dirs.length + 1), Math.round(totalBytes * 0.01))
  const verified =
    remoteFiles === files.length &&
    remoteBytes !== null &&
    Math.abs(remoteBytes - totalBytes) <= tolerance

  return {
    files: files.length,
    dirs: dirs.length,
    skippedLinks,
    bytes: totalBytes,
    durationMs,
    bytesPerSecond: Math.round((totalBytes / Math.max(1, durationMs)) * 1000),
    remoteBytes,
    remoteFiles,
    verified
  }
}

/** 删除远端路径。刻意加了护栏：绝不允许对根目录或过短的路径执行 rm -rf */
export async function removeRemotePath(session: Session, path: string): Promise<void> {
  const trimmed = path.trim()
  if (trimmed.length < 8 || !trimmed.startsWith('/') || trimmed === '/' || trimmed.includes('..')) {
    throw new SshError({
      kind: 'config',
      message: `拒绝删除可疑路径：${path}`,
      hint: '只在明确的目标目录上调用清理，避免手滑删掉家目录。',
      raw: path
    })
  }
  await session.exec(`rm -rf ${shq(trimmed)}`, { timeoutMs: 60_000 })
}

/** 打印用的一行摘要 */
export function summarize(result: UploadResult): string {
  return (
    `${result.files} 个文件 / ${formatBytes(result.bytes)} → ` +
    `${(result.durationMs / 1000).toFixed(1)}s，${formatRate(result.bytesPerSecond)}` +
    (result.verified ? '（已核对）' : '（核对不一致）')
  )
}
