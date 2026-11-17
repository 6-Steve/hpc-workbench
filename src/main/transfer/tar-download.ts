/**
 * tar 流式下载（`uploadDirectory` 的镜像）。
 *
 * 数据路径：远端 `tar -cf - -C <parent> <base>` → SSH channel → 本地 `tar-stream.extract` → 落盘
 * 全程不落地，本地不需要装 tar（Windows 上根本没有），这也是选 tar-stream 而不是调命令行解包的原因。
 *
 * 三条硬约束，和上传一一对应：
 * 1. 先解到 `<dest>.partial/`，全部成功后再 `mv` 改名
 * 2. **远端退出码必须检查**：tar 中途失败时本地会安静地留下半截文件，不查就是静默丢数据
 * 3. 解包要防路径穿越（`../` 或绝对路径），远端给什么名字都不能写到目标目录外面
 */
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { extract as createExtract } from 'tar-stream'
import { SshError } from '../ssh/errors'
import type { Session } from '../ssh/session'
import { shq } from '../ssh/shell'
import { ALREADY_EXISTS } from './sftp'
import { ProgressMeter, formatBytes, formatRate, type ProgressListener } from './progress'

export interface DownloadOptions {
  /** 远端目录的绝对路径 */
  remoteDir: string
  /** 本地目标目录，必须不存在 */
  localDir: string
  onProgress?: ProgressListener
  /** 远端预估字节数，只用于进度百分比；拿不到就走"已完成多少"的显示 */
  expectBytes?: number
  timeoutMs?: number
}

export interface DownloadResult {
  files: number
  dirs: number
  skippedLinks: number
  bytes: number
  durationMs: number
  bytesPerSecond: number
}

/** 把 `a/b/c` 拆成 `{parent:'a/b', base:'c'}`，只用 POSIX 语义 */
function splitRemote(path: string): { parent: string; base: string } {
  const normalized = path.replace(/\/+$/, '')
  const base = posix.basename(normalized) || 'root'
  const parent = posix.dirname(normalized)
  return { parent: parent === '.' ? '/' : parent, base }
}

/**
 * 解包时的路径校验：只允许相对路径，且不能跳出目标目录。
 *
 * 远端给的名字来自它自己的文件系统，理论上不该有 `../`，但 tar 头是**远端可写的内容**——
 * 一个坏掉或恶意的 tar 流能把文件写到 `~/.ssh/authorized_keys`。
 * 这是解包器必须自己守的底线，不能指望上游干净。
 *
 * 返回 null 表示这条 entry 要跳过。
 */
export function safeEntryName(name: string): string | null {
  const cleaned = name.replace(/\\/g, '/').replace(/^\.\/+/, '')
  if (cleaned === '' || cleaned === '.') return null
  if (cleaned.startsWith('/') || /^[a-zA-Z]:/.test(cleaned)) return null
  const normalized = posix.normalize(cleaned)
  if (normalized === '..' || normalized.startsWith('../')) return null
  return normalized
}

export async function downloadDirectory(session: Session, options: DownloadOptions): Promise<DownloadResult> {
  const { remoteDir, localDir } = options
  const startedAt = Date.now()

  // 远端先确认存在、是目录，顺便问一下体积（进度条用）
  const probe = await session.exec(
    `test -d ${shq(remoteDir)} && du -sb ${shq(remoteDir)} 2>/dev/null | cut -f1 || echo __missing__`,
    { timeoutMs: 60_000 }
  )
  const probeOut = probe.stdout.trim()
  if (probe.code !== 0 || probeOut === '__missing__' || probeOut === '') {
    throw new SshError({
      kind: 'remote',
      message: `远端目录不存在或不可读：${remoteDir}`,
      hint: '在右侧栏里确认目录还在、权限够不够。',
      raw: [probe.stderr.trim(), probeOut].filter(Boolean).join('\n') || '（无输出）'
    })
  }

  const parsedExpect = Number.parseInt(probeOut.split('\n')[0] ?? '', 10)
  const expectBytes = options.expectBytes ?? (Number.isNaN(parsedExpect) ? undefined : parsedExpect)

  // 目标已存在就不动——和上传保持同一套语义，不要让用户猜
  const exists = await stat(localDir).then(
    () => true,
    () => false
  )
  if (exists) {
    throw new SshError({
      kind: 'config',
      message: `本地已存在同名路径：${localDir}`,
      hint: '换个目标目录，或先确认里面是什么再手动删除。',
      raw: localDir,
      code: ALREADY_EXISTS
    })
  }

  // 先解到 `<dest>.partial`，全部成功后再整目录改名。
  // tar 流里每条 entry 都带顶层目录名（`out/...`），entry 处理时会把这一层剥掉，
  // 所以解完之后 partialRoot 里直接就是内容，改名一次就到位（和上传对称）。
  const { parent, base } = splitRemote(remoteDir)
  const partialRoot = `${localDir}.partial`
  await rm(partialRoot, { recursive: true, force: true })
  await mkdir(partialRoot, { recursive: true })

  const meter = new ProgressMeter(options.onProgress ?? (() => {}), expectBytes ?? 0)

  const counters = { files: 0, dirs: 0, skippedLinks: 0 }
  const extract = createExtract()

  // tar-stream 的 entry 回调是**串行**的：必须显式调用 next() 才会读下一条。
  // 任何一条上抛的异常都会变成 extract 的 'error'，由下面的 catch 收口。
  extract.on('entry', (header, stream, next) => {
    // 立刻暂停：下面有异步的 mkdir，期间不能让这条流继续吐数据，
    // 否则 tar-stream 会把下一条 entry 也推进来，两个 handler 交错执行。
    stream.pause()

    // 统一的推进口：保证 next() 只被调用一次
    let advanced = false
    const advance = (): void => {
      if (advanced) return
      advanced = true
      next()
    }
    // 丢弃这条 entry 的内容并继续（跳过、或顶层目录名这种空壳）
    const drainAndAdvance = (): void => {
      stream.once('end', advance)
      stream.resume()
    }

    const name = safeEntryName(header.name)

    if (!name || (header.type !== 'file' && header.type !== 'directory')) {
      // 符号链接、设备文件、以及任何可疑路径：一律丢弃
      counters.skippedLinks += 1
      drainAndAdvance()
      return
    }

    // 剥掉顶层目录名：`tar -cf - -C <parent> <base>` 打出来的每条 entry 都带 `<base>/` 前缀。
    // 目标目录里应该直接是内容（和上传对称），所以这里统一去掉这一层。
    const segments =
      name === base ? [] : name.startsWith(`${base}/`) ? name.slice(base.length + 1).split('/') : name.split('/')

    // 顶层目录 entry 本身（`out/`）剥完是空路径，partialRoot 已经建好了，直接跳过
    if (segments.length === 0) {
      drainAndAdvance()
      return
    }

    const target = join(partialRoot, ...segments)

    if (header.type === 'directory') {
      counters.dirs += 1
      mkdir(target, { recursive: true }).then(
        () => drainAndAdvance(),
        (err: Error) => extract.destroy(err)
      )
      return
    }

    counters.files += 1
    const parentDir = segments.length > 1 ? join(partialRoot, ...segments.slice(0, -1)) : partialRoot

    mkdir(parentDir, { recursive: true })
      .then(() => {
        const sink = createWriteStream(target)
        // 写流出错（磁盘满等）要立刻掀掉整个解包，不能只 reject 这一条
        sink.on('error', (err) => extract.destroy(err))
        // 用 finish 而不是 close：close 在错误路径上也会触发，会多调一次 next()
        sink.once('finish', advance)
        stream.once('error', (err) => extract.destroy(err))
        // 解包流本身会传导背压：磁盘慢时 tar 读取自然变慢，不会堆内存
        stream.pipe(sink)
      })
      .catch((err: Error) => extract.destroy(err))
  })

  // 把 extract 的 error 事件变成一次性的 reject，避免未处理的 error 把进程带崩
  let extractFailure: Error | null = null
  const onExtractError = (err: Error): void => {
    extractFailure = err
  }
  extract.on('error', onExtractError)

  // 等 extract 把每一条 entry 都处理完。channel 关闭 ≠ 解包完成：
  // entry 回调是异步的（要建目录、写文件），不等这个的话最后几条会漏统计，
  // 甚至还没落盘就去 rename 了。
  const extractDone = new Promise<void>((resolve) => {
    extract.once('finish', resolve)
    extract.once('close', resolve)
  })

  const remote = await session
    .pipeOut(`tar -cf - -C ${shq(parent)} ${shq(base)}`, extract, {
      timeoutMs: options.timeoutMs,
      onProgress: (bytes) => meter.update(bytes)
    })
    .catch(async (err: unknown) => {
      extract.removeListener('error', onExtractError)
      await rm(partialRoot, { recursive: true, force: true })
      if (err instanceof SshError) throw err
      throw new SshError({
        kind: 'config',
        message: '解包本地数据时出错，下载已中止',
        hint: '可能是磁盘空间不足，或目标目录没有写权限。',
        raw: (err as Error)?.message ?? String(err)
      })
    })

  await extractDone
  extract.removeListener('error', onExtractError)
  meter.finish(remote.bytes)

  // 解包中途出错时，pipeOut 可能已经正常返回（channel 关了不代表数据都落了盘）
  if (extractFailure) {
    await rm(partialRoot, { recursive: true, force: true })
    throw new SshError({
      kind: 'config',
      message: '解包本地数据时出错，下载已中止',
      hint: '可能是磁盘空间不足，或目标目录没有写权限。',
      raw: (extractFailure as Error).message
    })
  }

  // —— 远端退出码必须检查：漏了就是"看起来成功了，其实少一堆文件" ——
  if (remote.code !== 0) {
    await rm(partialRoot, { recursive: true, force: true })
    throw new SshError({
      kind: 'remote',
      message: `远端打包失败（退出码 ${remote.code ?? 'null'}）`,
      hint: '常见原因是某个子目录没有读权限，或传输中途连接断了。',
      raw: [`$ tar -cf - -C ${parent} ${base}`, remote.stderr.trim() || '（远端没有输出 stderr）'].join('\n'),
      code: String(remote.code)
    })
  }

  // 改名：同盘 rename 是原子的
  try {
    await rename(partialRoot, localDir)
  } catch (err) {
    await rm(partialRoot, { recursive: true, force: true })
    throw new SshError({
      kind: 'config',
      message: '解包成功，但改名失败',
      hint: '目标路径上可能已经有同名的东西了。',
      raw: (err as Error).message
    })
  }

  const durationMs = Date.now() - startedAt
  return {
    files: counters.files,
    dirs: counters.dirs,
    skippedLinks: counters.skippedLinks,
    bytes: remote.bytes,
    durationMs,
    bytesPerSecond: Math.round((remote.bytes / Math.max(1, durationMs)) * 1000)
  }
}

/** 打印用的一行摘要 */
export function summarizeDownload(result: DownloadResult): string {
  return (
    `${result.files} 个文件 / ${formatBytes(result.bytes)} → ` +
    `${(result.durationMs / 1000).toFixed(1)}s，${formatRate(result.bytesPerSecond)}`
  )
}
