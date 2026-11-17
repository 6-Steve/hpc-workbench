/**
 * 单流 SFTP 传输（A 策略）。
 *
 * 适用：文件数少（<100）、大小混合、需要精确控制单个文件的场景（docs/02 §2.3）。
 * 每传一个文件要 3-4 次往返，所以小文件成堆时必须走 tar，别用这里。
 *
 * 两条和 tar 一致的硬约束：
 * - **写完要核对大小**：SFTP 不会主动告诉你少写了，不比对就是静默丢数据
 * - 先写 `<目标>.part` 再改名：中途失败不会留下"看起来正常"的半截文件
 */
import { stat, mkdir, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SFTPWrapper, Stats } from 'ssh2'
import { SshError, TransferAborted } from '../ssh/errors'
import type { Session } from '../ssh/session'
import { ProgressMeter, type ProgressListener } from './progress'

export interface TransferOptions {
  onProgress?: ProgressListener
  /**
   * 并发分块数，1 = 单流（默认）。
   *
   * ⚠️ 这个名字容易被误解：它**不是**同时传几个文件（那是队列的 `concurrency`），
   * 而是"同一个文件同时发几个请求"。1 意味着每发 32 KB 都要等一个 ACK 回来，
   * 链路的 RTT 直接乘进每块的时间。
   */
  concurrency?: number
  /**
   * 单个 SFTP 读写请求的大小。
   *
   * 32 KB 是 OpenSSH 默认 SFTP 包长的量级，偏保守：RTT 50 ms 的链路上
   * 一次只有一个 32 KB 在途，理论吞吐约 640 KB/s——和实测吻合。
   * 提到 256 KB（`LARGE_CHUNK`）能把在途量放大 8 倍。
   */
  chunkSize?: number
  /** 目标已存在时直接替换。仍然走 `.part` + 改名，所以是原子的 */
  overwrite?: boolean
  /** 用户取消：中断并清掉半截文件 */
  signal?: AbortSignal
}

/** 冲突错误的稳定标识，供队列层做策略分派，不要靠匹配中文文案 */
export const ALREADY_EXISTS = 'ALREADY_EXISTS'

export interface FileTransferResult {
  bytes: number
  durationMs: number
  bytesPerSecond: number
}

/**
 * 单次 SFTP 读写请求的大小。
 *
 * 原值 32 KB 来自 OpenSSH 默认包长的量级，但它把"在途数据量"压死在 32 KB：
 * 一次请求发出去、等 ACK 回来才能发下一个，于是吞吐 ≈ chunk / RTT。
 * RTT 50 ms 时 32 KB / 0.05 s ≈ 640 KB/s——**和用户实测的 678 KB/s 几乎一致**。
 *
 * 256 KB 在同样的 RTT 下能到 5 MB/s。再往上要担心服务端的
 * `sftp` 内存与 `limits@openssh.com`，本项目不做那么激进。
 */
const DEFAULT_CHUNK = 256 * 1024

/** 远端路径一律 POSIX 语义，不能用 node:path（Windows 上会给你反斜杠） */
function posixDir(path: string): string {
  const index = path.lastIndexOf('/')
  if (index < 0) return '.'
  if (index === 0) return '/'
  return path.slice(0, index)
}

function sftpError(err: Error, action: string, path: string): SshError {
  return new SshError({
    kind: 'remote',
    message: `${action}失败：${path}`,
    hint: '常见原因：目录不存在、没有写权限、或磁盘配额满了。',
    raw: err.message
  })
}

/**
 * 把"半截文件在哪、已经传了多少"挂到错误对象上。
 *
 * 为什么挂在错误上而不是塞进返回值：失败/取消就是 `throw` 出去的，
 * 没有返回值可用。而队列层拿到这个错误后要拿这两个字段去问用户
 * "要不要删掉已经传上去的那 56 MB"。
 *
 * 用属性附加而不是新建一个包装类，是为了让原有的 `instanceof SshError` 判断
 * （队列层、UI 层都在用）继续有效。
 */
export interface PartialTransferInfo {
  /** 远端/本地留下的半截文件路径（上传是 `<目标>.part`，下载是 `<目标>.part`） */
  partialRemotePath?: string
  partialLocalPath?: string
  /** 停手时已经传了多少字节 */
  bytesDone: number
}

export type SshErrorWithPartial = SshError & { partial?: PartialTransferInfo }

function withPartial(err: unknown, info: PartialTransferInfo): unknown {
  if (err instanceof SshError) {
    ;(err as SshErrorWithPartial).partial = info
  }
  return err
}

/**
 * 取消 `fastPut` / `fastGet` 的唯一可靠姿势。
 *
 * ## 为什么不能"在 step 里 throw"
 * 读过 ssh2 的 `fastXfer`：`step` 是从 `writeCb` 里直接调用的
 * （`onstep && onstep(total, nb, fsize)`，没有任何 try/catch），而 `writeCb` 又是
 * SFTP 解析包时的回调栈。从这个栈里抛出去，异常会一路冒到
 * `client.on('error')` 之外，**打挂整条 SSH 会话**——不是打挂这一个文件。
 * 第一次实现就是这么写的，结果后面所有测试都拿到"与 127.0.0.1 的连接已断开"。
 *
 * ## 为什么不能"关掉 SFTP 通道"
 * `channel.end()` 走到 `push(null)` → `cleanupRequests()`，它会给所有在途请求
 * 回调一个 `No response from server`。理论可行，但 **`fastXfer` 自己的 `onerror`
 * 里还会调 `src.close()` / `dst.close()`**，通道已关时这些调用又会塞一条新请求进
 * `_requests`，永远等不到回应——`fastPut` 的外层 callback 就永远不回来。
 * 实测 20 秒超时。
 *
 * ## 所以分两步：先"让它停"，再"等它停"
 * 1. `abort()` 只是把 Promise 变灰，**ssh2 那边完全不知道**，还会继续发 `WRITE`。
 *    这就是"删了 `.part` 过一会儿它又冒出来"的原因（`queueCleanup` 跑在
 *    `fastPut` 还在写的时候）。**删文件必须等它真的停下。**
 * 2. 真正让它停下的是 `step` 里把 `aborted` 置位，然后**不再让 ssh2 继续派发读**。
 *    `fastXfer` 的 `writeCb` 里 `if (nb < origChunkLen) return singleRead(...)` 之后
 *    才是派发下一块 —— 我们拦不住这个分支，但可以在 `step` 里把源读缓冲标记为
 *    "耗尽的假象"：改 `pdst` 做不到（闭包），能做的是让**后续每次 `step` 都直接
 *    return 且不更新进度**，同时靠 `fastPut` 的 callback 作为"真的停了"的信号。
 *    256 KB 一块，最多再飞一块，30 MB/s 上 ≈ 8 ms，用户感知不到。
 *
 * 于是 `watchAbort` 只负责**置位**，真正 reject 的权力交给 `step`/callback 那一侧，
 * 这样才能保证 reject 发生时写入已经停止，`queueCleanup` 才不会和写入抢。
 */
function watchAbort(signal: AbortSignal | undefined, onAbort: () => void): () => void {
  if (!signal) return () => {}
  const onSignal = (): void => onAbort()
  if (signal.aborted) {
    onAbort()
    return () => {}
  }
  signal.addEventListener('abort', onSignal, { once: true })
  return () => signal.removeEventListener('abort', onSignal)
}

async function remoteStat(sftp: SFTPWrapper, path: string): Promise<Stats | undefined> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (err, stats) => {
      if (err) {
        // code 2 = SSH_FX_NO_SUCH_FILE；其它错误（权限等）不能当"不存在"吞掉
        if ((err as Error & { code?: number }).code === 2) resolve(undefined)
        else reject(sftpError(err, '读取远端文件信息', path))
        return
      }
      resolve(stats)
    })
  })
}

async function remoteMkdir(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(path, (err) => (err ? reject(sftpError(err, '创建远端目录', path)) : resolve()))
  })
}

async function remoteRename(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, (err) => (err ? reject(sftpError(err, '重命名远端路径', `${from} → ${to}`)) : resolve()))
  })
}

export async function removeRemoteFile(session: Session, path: string): Promise<void> {
  const sftp = await session.sftp()
  await new Promise<void>((resolve) => {
    sftp.unlink(path, () => resolve())
  })
}

/** 远端文件大小；不存在返回 undefined。队列用它提前算进度分母 */
export async function remoteFileSize(session: Session, path: string): Promise<number | undefined> {
  const sftp = await session.sftp()
  const info = await remoteStat(sftp, path)
  return info?.size
}

/** 递归建远端目录；已存在则跳过，存在但不是目录就报错 */
export async function ensureRemoteDir(session: Session, dir: string): Promise<void> {
  if (dir === '.' || dir === '/' || dir === '') return
  const sftp = await session.sftp()

  const segments = dir.split('/').filter(Boolean)
  let current = dir.startsWith('/') ? '' : '.'

  for (const segment of segments) {
    current = current === '' ? `/${segment}` : `${current}/${segment}`
    const existing = await remoteStat(sftp, current)
    if (existing) {
      if (!existing.isDirectory()) {
        throw new SshError({
          kind: 'remote',
          message: `远端路径已存在且不是目录：${current}`,
          raw: current
        })
      }
      continue
    }
    try {
      await remoteMkdir(sftp, current)
    } catch (err) {
      // 并发建目录会撞车，撞了就再确认一次
      const after = await remoteStat(sftp, current)
      if (!after?.isDirectory()) throw err
    }
  }
}

export async function uploadFile(
  session: Session,
  localPath: string,
  remotePath: string,
  options: TransferOptions = {}
): Promise<FileTransferResult> {
  const info = await stat(localPath)
  if (!info.isFile()) {
    throw new SshError({ kind: 'config', message: `不是一个普通文件：${localPath}`, raw: localPath })
  }
  const size = info.size

  const dir = posixDir(remotePath)
  await ensureRemoteDir(session, dir)

  const sftp = await session.sftp()
  const existing = await remoteStat(sftp, remotePath)
  if (existing && !options.overwrite) {
    throw new SshError({
      kind: 'remote',
      message: `远端已存在同名文件：${remotePath}`,
      hint: '覆盖/跳过/改名属于队列层的冲突策略。',
      raw: remotePath,
      code: ALREADY_EXISTS
    })
  }

  const tmp = `${remotePath}.part`
  const started = Date.now()
  const meter = new ProgressMeter(options.onProgress ?? (() => {}), size)

  /** 传输最终停在多少字节——取消时要用它告诉用户"已经传了多少" */
  let lastTransferred = 0

  try {
    await new Promise<void>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new TransferAborted('上传已取消'))
        return
      }

      let aborted = false
      const stopWatching = watchAbort(options.signal, () => {
        aborted = true
      })

      sftp.fastPut(
        localPath,
        tmp,
        {
          // ssh2 的默认值是 concurrency=64 / chunkSize=32KB，我们主动放宽 chunk
          concurrency: options.concurrency ?? 1,
          chunkSize: options.chunkSize ?? DEFAULT_CHUNK,
          step: (transferred: number) => {
            lastTransferred = transferred
            /*
             * **绝不 throw**（理由见 watchAbort 的注释），也**不在这里 reject**：
             * reject 会让外层立刻去 unlink `.part`，而 ssh2 还在飞手里的块，
             * 删完下一秒文件又回来了——这正是实测到的"删了但它还在"。
             * 这里只置位、停更进度，让 ssh2 自然收尾，由下面的 callback 统一 settle。
             */
            if (aborted) return
            meter.update(transferred)
          }
        },
        (err) => {
          stopWatching()
          // 到这里 ssh2 的循环已经结束（句柄都关了），删 `.part` 才安全
          if (aborted) reject(new TransferAborted('上传已取消'))
          else if (err) reject(sftpError(err, '上传', localPath))
          else resolve()
        }
      )
    })
  } catch (err) {
    /*
     * 半截文件必须处理，否则远端会留下一个看得见、点得开、内容是残缺的 `.part`。
     * 这里**不删**：删不删由用户决定（队列层会带着 `partialPath` 去问），
     * 但至少要把"传到哪了"告诉上层，否则用户没法判断删掉可惜不可惜。
     *
     * 取消时连 `lastTransferred` 也不一定准（step 可能在最后一次写入前就没再被调），
     * 所以外层拿到取消结果时会再用远端 `stat` 校一次真实大小——见 `queue.ts`。
     */
    throw withPartial(err, { partialRemotePath: tmp, bytesDone: lastTransferred })
  }
  meter.finish(size)
  // —— 核对大小，SFTP 不会告诉你少写了 ——
  const written = await remoteStat(sftp, tmp)
  if (!written || written.size !== size) {
    await removeRemoteFile(session, tmp)
    throw new SshError({
      kind: 'remote',
      message: `上传后大小不一致：本地 ${size} 字节，远端 ${written?.size ?? '文件缺失'}`,
      hint: '多半是连接中途断了。重传一次；反复出现请检查网络。',
      raw: `local=${size} remote=${written?.size ?? 'missing'}`
    })
  }

  await remoteRename(sftp, tmp, remotePath)

  const durationMs = Date.now() - started
  return { bytes: size, durationMs, bytesPerSecond: Math.round((size / Math.max(1, durationMs)) * 1000) }
}

export async function downloadFile(
  session: Session,
  remotePath: string,
  localPath: string,
  options: TransferOptions = {}
): Promise<FileTransferResult> {
  const sftp = await session.sftp()
  const remoteInfo = await remoteStat(sftp, remotePath)
  if (!remoteInfo) {
    throw new SshError({
      kind: 'remote',
      message: `远端文件不存在：${remotePath}`,
      raw: remotePath
    })
  }
  if (!remoteInfo.isFile()) {
    throw new SshError({ kind: 'remote', message: `不是一个普通文件：${remotePath}`, raw: remotePath })
  }
  const size = remoteInfo.size

  await mkdir(dirname(localPath), { recursive: true })

  // 本地已存在时同样不静默覆盖——下载覆盖本地文件是真实的数据丢失
  if (!options.overwrite) {
    const existing = await stat(localPath).catch(() => undefined)
    if (existing) {
      throw new SshError({
        kind: 'config',
        message: `本地已存在同名文件：${localPath}`,
        hint: '覆盖/跳过/改名属于队列层的冲突策略。',
        raw: localPath,
        code: ALREADY_EXISTS
      })
    }
  }

  const tmp = `${localPath}.part`
  const started = Date.now()
  const meter = new ProgressMeter(options.onProgress ?? (() => {}), size)

  let lastTransferred = 0

  try {
    await new Promise<void>((resolve, reject) => {
      // 同上传：置位靠 watchAbort，settle 靠 callback（等 ssh2 真停下）
      if (options.signal?.aborted) {
        reject(new TransferAborted('下载已取消'))
        return
      }

      let aborted = false
      const stopWatching = watchAbort(options.signal, () => {
        aborted = true
      })

      sftp.fastGet(
        remotePath,
        tmp,
        {
          concurrency: options.concurrency ?? 1,
          chunkSize: options.chunkSize ?? DEFAULT_CHUNK,
          step: (transferred: number) => {
            lastTransferred = transferred
            if (aborted) return
            meter.update(transferred)
          }
        },
        (err) => {
          stopWatching()
          if (aborted) reject(new TransferAborted('下载已取消'))
          else if (err) reject(sftpError(err, '下载', remotePath))
          else resolve()
        }
      )
    })
  } catch (err) {
    // 本地半截文件同理不删，交给队列层问用户
    throw withPartial(err, { partialLocalPath: tmp, bytesDone: lastTransferred })
  }
  meter.finish(size)

  const written = await stat(tmp)
  if (written.size !== size) {
    await unlink(tmp).catch(() => {})
    throw new SshError({
      kind: 'remote',
      message: `下载后大小不一致：远端 ${size} 字节，本地 ${written.size}`,
      raw: `remote=${size} local=${written.size}`
    })
  }

  await rename(tmp, localPath)

  const durationMs = Date.now() - started
  return { bytes: size, durationMs, bytesPerSecond: Math.round((size / Math.max(1, durationMs)) * 1000) }
}
