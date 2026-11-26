/**
 * 单条 SSH 连接的封装：握手指令、host key 校验、exec 与通道并发控制。
 *
 * 设计要点：
 * - 一条 TCP 连接上开多个 channel，绝不为每次操作重新握手（握手 3-5 次往返）
 * - 并发 exec 走信号量，默认 5，不超过服务端 MaxSessions
 * - 超时与输出截断在客户端兜住，避免一条烂命令把主进程拖死
 */
import { readFile } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { Transform, type Readable, type Writable } from 'node:stream'
import type { ClientChannel, ConnectConfig, SFTPWrapper } from 'ssh2'
import { Client } from 'ssh2'
import type { ResolvedProfile } from '../profiles'
import type { TraceInput } from '../../shared/trace'
import { SshError, TransferAborted, normalizeSshError } from './errors'
import { KnownHostsStore, fingerprintOf } from './known-hosts'
import { Semaphore } from './semaphore'

export interface ExecResult {
  command: string
  /** 远端退出码；被信号杀掉时为 null */
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
  durationMs: number
  /** 输出超过 maxBytes 被丢弃，UI 必须提示"输出过多，已截断" */
  truncated: boolean
}

export interface ExecOptions {
  /** 客户端侧超时，超时后关闭该 channel */
  timeoutMs?: number
  /** stdout 最多保留多少字节，默认 8 MB */
  maxBytes?: number
}

export interface PipeOptions {
  /** 默认 30 分钟：上传大目录时不能用 exec 的 30 秒 */
  timeoutMs?: number
  /** 每写入一块就回调一次（已写入总字节），由调用方节流 */
  onProgress?: (bytes: number) => void
  /**
   * 用户主动中止（取消传输）。
   *
   * 与"出错"必须区分开：中止是预期行为，不该走重试、也不该报红错误。
   * 中止时先 destroy 源、关 channel，再以 `TransferAborted` 拒绝。
   */
  signal?: AbortSignal
  /** 流缓冲。默认 16 KB 对 20-40 MB/s 的链路太小了，见 `STREAM_BUFFER_BYTES` */
  bufferBytes?: number
}

export interface PipeResult {
  command: string
  /** 远端退出码。**必须检查**：本地写得成功、远端解压失败会静默丢数据 */
  code: number | null
  signal: string | null
  stderr: string
  bytes: number
  durationMs: number
}

export interface PipeOutOptions {
  timeoutMs?: number
  /** 每收到一块就回调一次（已收到总字节），由调用方节流 */
  onProgress?: (bytes: number) => void
  /** 用户主动中止（取消传输），语义同 `PipeOptions.signal` */
  signal?: AbortSignal
  /** 流缓冲，同 `PipeOptions.bufferBytes` */
  bufferBytes?: number
}

/** 与 PipeResult 同构，但 bytes 是**读出来**的量（下行） */
export type PipeOutResult = PipeResult

export interface TailOptions {
  /** 收到文本就回调。**已经是解码后的字符串**，调用方不要再 toString */
  onText: (text: string) => void
  /** stderr 也当文本吐出来，一般只有 `tail: cannot open ...` 这种 */
  onStderr?: (text: string) => void
  /** 中止信号：用户关掉弹窗时触发，会把远端命令一起停掉 */
  signal?: AbortSignal
  /** 最长跟多久（毫秒），0 表示不限。默认 30 分钟，防止忘了关一直占通道 */
  maxDurationMs?: number
}

/** 反向转发进来的一条连接。`destPort` 用来分派给对应的隧道 */
export interface ReverseConnection {
  destPort: number
  accept: () => ClientChannel
  reject: () => void
}

export interface ShellSize {
  cols: number
  rows: number
}

export interface ShellHandlers {
  /** 收到终端输出。**已经解码成字符串**，多字节字符不会在中途被劈开 */
  onData: (text: string) => void
  /** 会话结束（远端退出、连接断了、或本地主动关闭） */
  onClose?: (result: { code: number | null; signal: string | null }) => void
}

/** 一个活着的交互式 shell。渲染层只看到这三个动作，不碰 ssh2 类型 */
export interface ShellHandle {
  /** 键盘输入。PTY 需要原始字节，不要在这里做任何加工 */
  write: (data: string) => void
  resize: (size: ShellSize) => void
  close: () => void
}

export interface TailResult {
  command: string
  code: number | null
  signal: string | null
  stderr: string
  /** true = 被本地主动中止（用户关了，或到时间了），不是远端命令自己结束 */
  aborted: boolean
  durationMs: number
}

export interface HostKeyInfo {
  algorithm: string
  fingerprint: string
  verdict: 'known' | 'new'
}

export interface SessionOptions {
  knownHosts?: KnownHostsStore
  onLog?: (message: string) => void
  /**
   * 每执行完一条命令回调一次（成功、非 0 退出、连接层失败都有）。
   *
   * 只用于「命令记录」这种旁观功能：**回调抛异常会被吞掉**，
   * 不允许观测代码反过来影响命令本身。
   */
  onTrace?: (input: TraceInput) => void
}

const DEFAULT_EXEC_TIMEOUT_MS = 30_000
const DEFAULT_PIPE_TIMEOUT_MS = 30 * 60_000
/** 跟随日志的兜底时长。用户基本不会看一小时日志，超了就断，别一直占通道 */
const DEFAULT_TAIL_TIMEOUT_MS = 30 * 60_000
/** 端口转发一律只绑回环地址。见 `forwardIn` 的安全说明 */
const LOOPBACK = '127.0.0.1'
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
const MAX_STDERR_BYTES = 256 * 1024

/**
 * 管道流缓冲（`write()` 在不返回 false 之前能压多少数据在内存里）。
 *
 * Node 默认 16 KB。原文里只有 SSH channel 自己有缓冲，中间那个计数 `Transform`
 * 只有 16 KB，于是"本地能提前多少写出数据"就只剩 16 KB——
 * 一条 RTT 50 ms 的链路、16 KB 在途，理论吞吐 `16KB / 0.05s ≈ 320 KB/s`。
 * 这和用户实测的 **678 KB/s** 是同一个数量级，说明瓶颈在**在途数据量**，
 * 不在带宽（集群实测链路本身能到 42 MB/s）。
 *
 * 取 256 KB：在途 256 KB / 50 ms ≈ 5 MB/s，不再是被自己卡住。
 * 不取更大的原因——每个并发传输各占一份，队列默认并发 2，
 * 1 MB 就是 2 MB 常驻，再大就要考虑内存了。
 */
const STREAM_BUFFER_BYTES = 256 * 1024

type SessionStatus = 'connecting' | 'ready' | 'closed'

export class Session {
  readonly profile: ResolvedProfile

  private readonly client: Client
  private readonly semaphore: Semaphore
  private readonly closeListeners = new Set<() => void>()
  private status: SessionStatus
  private hostKeyInfo: HostKeyInfo | undefined
  private lastError: SshError | undefined
  /**
   * 连接是怎么断的，一句话。`null` = 还没断。
   *
   * 为什么要单独记：`lastError` 只在 `error` 事件里被赋值，而"对端发了断开请求"
   * 和"我们自己关的"走的都不是 error 分支——那两种情况下什么都不记，
   * 事后只能看到一句"连接已断开"，等于没信息。
   */
  private closedReason: string | null = null
  /** 收到过 ssh2 的 `end` = 对端发了 SSH_MSG_DISCONNECT */
  private sawRemoteEnd = false
  /** 是我们自己调的 `close()` */
  private closingByUs = false
  private sftpClient: SFTPWrapper | undefined
  private sftpPending: Promise<SFTPWrapper> | undefined
  /** 旁观钩子，见 SessionOptions.onTrace */
  private onTrace: ((input: TraceInput) => void) | undefined

  private constructor(
    profile: ResolvedProfile,
    client: Client,
    semaphore: Semaphore,
    onTrace?: (input: TraceInput) => void
  ) {
    this.profile = profile
    this.client = client
    this.semaphore = semaphore
    this.onTrace = onTrace
    this.status = 'connecting'
  }

  static async open(profile: ResolvedProfile, options: SessionOptions = {}): Promise<Session> {
    const log = options.onLog ?? ((): void => {})
    const client = new Client()
    const session = new Session(profile, client, new Semaphore(profile.maxConcurrent), options.onTrace)
    const ctx = { host: profile.host, port: profile.port, username: profile.username }

    let hostKeyProblem: { expected: string | null; actual: string; algorithm: string; reason: string } | undefined

    const hostVerifier = (key: Buffer, verify?: (ok: boolean) => void): boolean => {
      const { algorithm, fingerprint } = fingerprintOf(key)
      const store = options.knownHosts

      if (!store) {
        session.hostKeyInfo = { algorithm, fingerprint, verdict: 'new' }
        verify?.(true)
        return true
      }

      const verdict = store.verify(profile.host, profile.port, algorithm, fingerprint)

      if (verdict === 'mismatch') {
        hostKeyProblem = {
          expected: store.expectedFingerprint(profile.host, profile.port, algorithm),
          actual: fingerprint,
          algorithm,
          reason: 'mismatch'
        }
        verify?.(false)
        return false
      }

      if (verdict === 'new' && !profile.trustNewHostKey) {
        hostKeyProblem = { expected: null, actual: fingerprint, algorithm, reason: 'unknown' }
        verify?.(false)
        return false
      }

      if (verdict === 'new') {
        store.remember(profile.host, profile.port, algorithm, fingerprint)
        log(`首次连接该主机，已记录 ${algorithm} 指纹 ${fingerprint}`)
      }

      session.hostKeyInfo = { algorithm, fingerprint, verdict }
      verify?.(true)
      return true
    }

    const authMaterial = await loadAuthMaterial(profile)
    const config: ConnectConfig = {
      host: profile.host,
      port: profile.port,
      username: profile.username,
      readyTimeout: profile.connectTimeoutMs,
      keepaliveInterval: profile.keepaliveIntervalMs,
      keepaliveCountMax: 3,
      hostVerifier,
      ...authMaterial
    }

    log(`连接 ${profile.username}@${profile.host}:${profile.port}（profile: ${profile.id}）`)

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (err?: SshError): void => {
        if (settled) return
        settled = true
        if (err) reject(err)
        else resolve()
      }

      client.on('error', (err: Error) => {
        const normalized = hostKeyProblem ? hostKeyError(hostKeyProblem, profile) : normalizeSshError(err, ctx)
        session.lastError = normalized
        // error 里的措辞最具体（"心跳超时"/"ECONNRESET"），优先用它当关闭原因
        session.closedReason = normalized.message
        session.markClosed()
        settle(normalized)
      })
      client.once('ready', () => {
        session.status = 'ready'
        settle()
      })
      // 对端发 SSH_MSG_DISCONNECT 时 ssh2 先发 'end' 再发 'close'
      client.on('end', () => {
        session.sawRemoteEnd = true
      })
      client.on('close', () => session.noteClientClosed())

      try {
        client.connect(config)
      } catch (err) {
        settle(normalizeSshError(err, ctx))
      }
    })

    return session
  }

  get isAlive(): boolean {
    return this.status === 'ready'
  }

  get hostKey(): HostKeyInfo | undefined {
    return this.hostKeyInfo
  }

  get lastFailure(): SshError | undefined {
    return this.lastError
  }

  /**
   * 连接关闭的原因，一句话。`null` = 还活着。
   *
   * 给"事后解释"用的：反向隧道断了要写进界面、连接池断了要写进日志，
   * 之前这些地方只能干巴巴说一句"连接已断开"。
   */
  get closeReason(): string | null {
    return this.status === 'closed' ? this.closedReason : null
  }

  onClose(listener: () => void): () => void {
    if (this.status === 'closed') {
      listener()
      return () => {}
    }
    this.closeListeners.add(listener)
    return () => {
      this.closeListeners.delete(listener)
    }
  }

  private noteClientClosed(): void {
    // `error` 已经写过更具体的原因时不再覆盖
    if (!this.closedReason) {
      this.closedReason = describeClose({ byUs: this.closingByUs, remoteEnded: this.sawRemoteEnd })
    }
    this.markClosed()
  }

  private markClosed(): void {
    if (this.status === 'closed') return
    this.status = 'closed'
    const listeners = [...this.closeListeners]
    this.closeListeners.clear()
    for (const fn of listeners) fn()
  }

  /**
   * 执行一条命令。
   * 连接层错误抛 `SshError`；命令非 0 退出**不抛**，由调用方看 `code`/`stderr` 决定怎么办
   * （Adapter 需要保留原文，不能被异常打断）。
   */
  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    if (!this.isAlive) {
      throw new SshError({
        kind: 'reset',
        message: `与 ${this.profile.host} 的连接已断开`,
        hint: '重连一次即可。若频繁发生，多半是跳板机清理了空闲连接。',
        raw: this.lastError?.raw ?? `session status: ${this.status}`,
        code: 'NOT_CONNECTED',
        retryable: true
      })
    }

    // `at` 取排队之前：界面上的时间线应该反映"什么时候发起"，不是"什么时候轮到"
    const startedAt = Date.now()
    let result: ExecResult
    try {
      result = await this.semaphore.run(() => this.execOnce(command, options))
    } catch (err) {
      // 命令发出去了、但没拿到结果（超时 / 通道被 reset / 连接掉了）。
      // 和"非 0 退出"要能分开看：那种是远端拒绝，这种是根本没回来。
      this.emitTrace({
        profileId: this.profile.id,
        host: this.profile.host,
        command,
        at: startedAt,
        code: null,
        durationMs: Date.now() - startedAt,
        stdout: '',
        stderr: '',
        truncated: false,
        error: err instanceof Error ? err.message : String(err)
      })
      throw err
    }

    this.emitTrace({
      profileId: this.profile.id,
      host: this.profile.host,
      command,
      at: startedAt,
      code: result.code,
      durationMs: result.durationMs,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
      error: null
    })
    return result
  }

  private emitTrace(input: TraceInput): void {
    const onTrace = this.onTrace
    if (!onTrace) return
    try {
      onTrace(input)
    } catch {
      // 绝不因为"记日志的代码崩了"让一条正常命令失败
    }
  }

  private execOnce(command: string, options: ExecOptions): Promise<ExecResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    const startedAt = Date.now()

    return new Promise<ExecResult>((resolve, reject) => {
      let done = false
      let timer: NodeJS.Timeout | undefined

      const finish = (fn: () => void): void => {
        if (done) return
        done = true
        if (timer) clearTimeout(timer)
        fn()
      }

      this.client.exec(command, (err, stream: ClientChannel) => {
        if (err) {
          finish(() => reject(normalizeSshError(err, { ...this.ctx(), phase: 'exec' })))
          return
        }

        const outChunks: Buffer[] = []
        const errChunks: Buffer[] = []
        let outBytes = 0
        let errBytes = 0
        let truncated = false
        let exitCode: number | null = null
        let exitSignal: string | null = null

        stream.on('data', (chunk: Buffer) => {
          if (outBytes + chunk.length > maxBytes) {
            truncated = true
            const room = maxBytes - outBytes
            if (room > 0) {
              outChunks.push(chunk.subarray(0, room))
              outBytes = maxBytes
            }
            return // 超限后继续 drain，但不留内存，让远端命令正常跑完
          }
          outChunks.push(chunk)
          outBytes += chunk.length
        })

        stream.stderr.on('data', (chunk: Buffer) => {
          if (errBytes >= MAX_STDERR_BYTES) return
          errChunks.push(chunk)
          errBytes += chunk.length
        })

        stream.on('exit', (code: number | null, signal?: string | null) => {
          exitCode = code ?? null
          exitSignal = signal ?? null
        })

        stream.on('close', (code?: number | null, signal?: string | null) => {
          finish(() =>
            resolve({
              command,
              code: exitCode ?? code ?? null,
              signal: exitSignal ?? signal ?? null,
              stdout: Buffer.concat(outChunks).toString('utf8'),
              stderr: Buffer.concat(errChunks).toString('utf8'),
              durationMs: Date.now() - startedAt,
              truncated
            })
          )
        })

        stream.on('error', (streamErr: Error) => {
          finish(() => reject(normalizeSshError(streamErr, { ...this.ctx(), phase: 'exec' })))
        })

        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            try {
              stream.close()
            } catch {
              /* channel 可能已经关闭 */
            }
            finish(() =>
              reject(
                new SshError({
                  kind: 'timeout',
                  message: `命令超时（${timeoutMs} ms）：${trimForDisplay(command)}`,
                  hint: '命令可能卡在交互提示上。可在终端里手动跑一遍确认。',
                  raw: [`$ ${command}`, '已收到的输出：', Buffer.concat(outChunks).toString('utf8').slice(0, 4000)].join(
                    '\n'
                  ),
                  code: 'EXEC_TIMEOUT',
                  retryable: true
                })
              )
            )
          }, timeoutMs)
        }
      })
    })
  }

  /**
   * 把本地流灌进远端命令的 stdin，返回远端退出码。
   *
   * 这是 tar 流式传输的地基：数据不落地，全程只有一条 SSH channel。
   * 三条硬约束：
   * - 必须走 `pipeline`，靠它传导背压，否则 1 GB 会一次性读进内存
   * - 远端退出码**必须**检查，本地写完不代表远端解开成功
   * - 远端提前退出时用退出码 + stderr 报错，而不是抛个看不懂的 EPIPE
   */
  async pipe(command: string, source: Readable, options: PipeOptions = {}): Promise<PipeResult> {
    if (!this.isAlive) {
      throw new SshError({
        kind: 'reset',
        message: `与 ${this.profile.host} 的连接已断开`,
        hint: '重连一次即可。',
        raw: this.lastError?.raw ?? `session status: ${this.status}`,
        code: 'NOT_CONNECTED',
        retryable: true
      })
    }
    return this.semaphore.run(() => this.pipeOnce(command, source, options))
  }

  private pipeOnce(command: string, source: Readable, options: PipeOptions): Promise<PipeResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_PIPE_TIMEOUT_MS
    const startedAt = Date.now()

    return new Promise<PipeResult>((resolve, reject) => {
      let done = false
      let timer: NodeJS.Timeout | undefined
      /**
       * 摘掉 signal 上的回调。
       *
       * 放在 `finish` 里统一做，而不是散在正常/出错/超时三处：
       * 那条路径都可能先触发，逐个记得摘是不现实的，漏一个就会在 AbortSignal
       * 上积累监听器（传几百个文件就积几百个），Node 会打 MaxListenersExceededWarning。
       */
      let detachSignal = (): void => {}

      const finish = (fn: () => void): void => {
        if (done) return
        done = true
        if (timer) clearTimeout(timer)
        detachSignal()
        fn()
      }

      this.client.exec(command, (err, stream: ClientChannel) => {
        if (err) {
          finish(() => reject(normalizeSshError(err, { ...this.ctx(), phase: 'exec' })))
          return
        }

        const errChunks: Buffer[] = []
        let errBytes = 0
        let transferred = 0
        let exitCode: number | null = null
        let exitSignal: string | null = null

        stream.stderr.on('data', (chunk: Buffer) => {
          if (errBytes >= MAX_STDERR_BYTES) return
          errChunks.push(chunk)
          errBytes += chunk.length
        })

        // 必须把 stdout 也拉起来消费。SSH channel 是可读可写的同一个对象，
        // 只写不读时底层背压会把整条通道卡住：数据全部进了本地缓冲、一个字节都发不出去，
        // 远端永远等不到 EOF。实测表现是「写入量等于全量，然后一直不结束」，极难看出来。
        stream.resume()

        stream.on('exit', (code: number | null, signal?: string | null) => {
          exitCode = code ?? null
          exitSignal = signal ?? null
        })

        stream.on('close', (code?: number | null, signal?: string | null) => {
          finish(() =>
            resolve({
              command,
              code: exitCode ?? code ?? null,
              signal: exitSignal ?? signal ?? null,
              stderr: Buffer.concat(errChunks).toString('utf8'),
              bytes: transferred,
              durationMs: Date.now() - startedAt
            })
          )
        })

        // 只数不发：数据直接流过，不在内存里攒
        const meter = new Transform({
          // 默认 16 KB 的可写高水位意味着管道里最多只压着 16 KB "在途"数据，
          // 发一块就要等对端 ACK 一块，吞吐被往返时延锁死。给到 256 KB 后
          // 才能填满链路的带宽时延积（见 STREAM_BUFFER_BYTES）。
          writableHighWaterMark: options.bufferBytes ?? STREAM_BUFFER_BYTES,
          transform(chunk: Buffer, _encoding, callback) {
            transferred += chunk.length
            options.onProgress?.(transferred)
            callback(null, chunk)
          }
        })

        /**
         * 用户点了"取消"。
         *
         * 与"出错"必须分开：走 `abort` 会套上 retryable 的 `reset` 包装，
         * 而用户取消**绝不能重试**——他就是要它停。
         */
        /** 摘掉 signal 上的回调（`finish` 会调用，这里只是把引用交给它） */
        const onAbortSignal = (): void => abort(new TransferAborted('上传已取消'))
        detachSignal = () => options.signal?.removeEventListener('abort', onAbortSignal)

        const abort = (err: Error): void => {
          source.destroy()
          try {
            stream.close()
          } catch {
            /* 可能已关 */
          }
          finish(() =>
            reject(
              err instanceof SshError
                ? err
                : new SshError({
                    kind: 'reset',
                    message: `上传中断：${err.message}`,
                    hint: '检查网络是否稳定；远端命令可能提前退出了。',
                    raw: [err.message, Buffer.concat(errChunks).toString('utf8')].join('\n'),
                    retryable: true
                  })
            )
          )
        }

        source.on('error', abort)
        meter.on('error', abort)
        stream.on('error', abort)

        source.pipe(meter).pipe(stream)

        if (options.signal) {
          if (options.signal.aborted) {
            onAbortSignal()
          } else {
            options.signal.addEventListener('abort', onAbortSignal, { once: true })
          }
        }

        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            abort(
              new SshError({
                kind: 'timeout',
                message: `上传超时（${Math.round(timeoutMs / 1000)} s）`,
                hint: '网络带宽可能远低于预期。可以先传一个小目录测速再决定。',
                raw: `transferred=${transferred} bytes in ${Date.now() - startedAt} ms`,
                code: 'PIPE_TIMEOUT',
                retryable: true
              })
            )
          }, timeoutMs)
        }
      })
    })
  }

  /**
   * 反方向：把远端命令的 **stdout 灌进本地可写流**（tar 下载用）。
   *
   * 和 `pipe` 对称，但坑完全不同：
   * - 上行的坑是"不读 stdout 会背压死锁"，下行天然要读，没这个问题；
   * - 下行的坑是**本地磁盘写不动时要把背压传回远端**，否则数据全堆在内存里，
   *   传一个 20 GB 的目录能把主进程撑爆。所以这里靠 `.pipe()` 自带的反压联动，
   *   绝不能为了"接住数据"去调 `stream.resume()`。
   * - 远端退出码同样必须检查：tar 中途报错退出时，本地会安静地留下半截文件。
   */
  async pipeOut(command: string, sink: Writable, options: PipeOutOptions = {}): Promise<PipeResult> {
    if (!this.isAlive) {
      throw new SshError({
        kind: 'reset',
        message: `与 ${this.profile.host} 的连接已断开`,
        hint: '重连一次即可。',
        raw: this.lastError?.raw ?? `session status: ${this.status}`,
        code: 'NOT_CONNECTED',
        retryable: true
      })
    }
    return this.semaphore.run(() => this.pipeOutOnce(command, sink, options))
  }

  private pipeOutOnce(command: string, sink: Writable, options: PipeOutOptions): Promise<PipeResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_PIPE_TIMEOUT_MS
    const startedAt = Date.now()

    return new Promise<PipeResult>((resolve, reject) => {
      let done = false
      let timer: NodeJS.Timeout | undefined
      let detachSignal = (): void => {}

      const finish = (fn: () => void): void => {
        if (done) return
        done = true
        if (timer) clearTimeout(timer)
        detachSignal()
        fn()
      }

      this.client.exec(command, (err, stream: ClientChannel) => {
        if (err) {
          finish(() => reject(normalizeSshError(err, { ...this.ctx(), phase: 'exec' })))
          return
        }

        const errChunks: Buffer[] = []
        let errBytes = 0
        let received = 0
        let exitCode: number | null = null
        let exitSignal: string | null = null

        stream.stderr.on('data', (chunk: Buffer) => {
          if (errBytes >= MAX_STDERR_BYTES) return
          errChunks.push(chunk)
          errBytes += chunk.length
        })

        stream.on('exit', (code: number | null, signal?: string | null) => {
          exitCode = code ?? null
          exitSignal = signal ?? null
        })

        stream.on('close', (code?: number | null, signal?: string | null) => {
          finish(() =>
            resolve({
              command,
              code: exitCode ?? code ?? null,
              signal: exitSignal ?? signal ?? null,
              stderr: Buffer.concat(errChunks).toString('utf8'),
              bytes: received,
              durationMs: Date.now() - startedAt
            })
          )
        })

        const abort = (error: Error): void => {
          sink.destroy()
          try {
            stream.close()
          } catch {
            /* 可能已关 */
          }
          finish(() =>
            reject(
              error instanceof SshError
                ? error
                : new SshError({
                    kind: 'reset',
                    message: `下载中断：${error.message}`,
                    hint: '检查网络是否稳定、目标磁盘是否有空间。',
                    raw: [error.message, Buffer.concat(errChunks).toString('utf8')].join('\n'),
                    retryable: true
                  })
            )
          )
        }

        // 只数不改：数据原样流过。**不要**在这里调 stream.resume()
        const meter = new Transform({
          // 下行同理：16 KB 的可写水位会把"在途"数据压得太少，吞吐被 RTT 卡住
          writableHighWaterMark: options.bufferBytes ?? STREAM_BUFFER_BYTES,
          transform(chunk: Buffer, _encoding, callback) {
            received += chunk.length
            options.onProgress?.(received)
            callback(null, chunk)
          }
        })

        // 下行同样用 `.pipe()` 而不是 pipeline()：channel 是 Duplex，
        // pipeline 会要求它的**可写侧**也正常收尾，而远端压根不会关 stdin。
        stream.pipe(meter).pipe(sink)

        meter.on('error', abort)
        sink.on('error', abort)
        stream.on('error', abort)

        // 取消语义同上行，见 pipeOnce 里的说明
        const onAbortSignal = (): void => abort(new TransferAborted('下载已取消'))
        detachSignal = () => options.signal?.removeEventListener('abort', onAbortSignal)
        if (options.signal) {
          if (options.signal.aborted) {
            onAbortSignal()
          } else {
            options.signal.addEventListener('abort', onAbortSignal, { once: true })
          }
        }

        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            abort(
              new SshError({
                kind: 'timeout',
                message: `下载超时（${Math.round(timeoutMs / 1000)} s）`,
                hint: '网络带宽可能远低于预期，或目标磁盘写入过慢。',
                raw: `received=${received} bytes in ${Date.now() - startedAt} ms`,
                code: 'PIPE_TIMEOUT',
                retryable: true
              })
            )
          }, timeoutMs)
        }
      })
    })
  }

  /**
   * 跟一个**不会自己结束**的命令（`tail -f` 这类），把 stdout 按文本往外吐。
   *
   * 和 `exec` / `pipeOut` 的三点不同，都是为"长连接"付的代价：
   *
   * 1. **不走信号量**。信号量是给"请求-响应"型命令用的（默认并发 5）。
   *    `tail -f` 永不结束，占一个槽就是永久少一个；开三个跟随剩下两个槽，
   *   之后所有 exec 都会被饿死，表现为"界面卡住不刷新"。
   *    这类长连接独立开通道，服务端的 `MaxSessions` 默认 10，够用。
   * 2. **必须用 `StringDecoder`**。一个 UTF-8 汉字占 3 字节，chunk 边界随时可能
   *    把它劈开。直接 `chunk.toString('utf8')` 会在中文日志里随机出现 `�`。
   * 3. **必须能主动中止**。用户关掉弹窗时 `tail -f` 还在远端跑，
   *    不清掉就会一直占着通道直到应用退出。
   */
  async tail(command: string, options: TailOptions): Promise<TailResult> {
    if (!this.isAlive) {
      throw new SshError({
        kind: 'reset',
        message: `与 ${this.profile.host} 的连接已断开`,
        hint: '重连一次即可。',
        raw: this.lastError?.raw ?? `session status: ${this.status}`,
        code: 'NOT_CONNECTED',
        retryable: true
      })
    }

    const maxDurationMs = options.maxDurationMs ?? DEFAULT_TAIL_TIMEOUT_MS
    const startedAt = Date.now()

    return new Promise<TailResult>((resolve, reject) => {
      let done = false
      let aborted = false
      let timer: NodeJS.Timeout | undefined
      const errChunks: Buffer[] = []
      let errBytes = 0
      let exitCode: number | null = null
      let exitSignal: string | null = null
      // 拿到 channel 之后才有真正的实现；先占位是为了让 finish 能解绑监听
      let onAbort = (): void => {}

      const finish = (fn: () => void): void => {
        if (done) return
        done = true
        if (timer) clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        fn()
      }

      const decoder = new StringDecoder('utf8')
      const errDecoder = new StringDecoder('utf8')

      this.client.exec(command, (err, stream: ClientChannel) => {
        if (err) {
          finish(() => reject(normalizeSshError(err, { ...this.ctx(), phase: 'exec' })))
          return
        }

        onAbort = (): void => {
          aborted = true
          // 先 TERM 让远端进程退出，再关通道；只 close 的话远端 tail 可能变孤儿
          try {
            stream.signal('TERM')
          } catch {
            // 通道已经没了，忽略
          }
          stream.close()
        }

        stream.on('data', (chunk: Buffer) => {
          const text = decoder.write(chunk)
          if (text.length > 0) options.onText(text)
        })

        stream.stderr.on('data', (chunk: Buffer) => {
          if (errBytes >= MAX_STDERR_BYTES) return
          errChunks.push(chunk)
          errBytes += chunk.length
          const text = errDecoder.write(chunk)
          if (text.length > 0) options.onStderr?.(text)
        })

        stream.on('exit', (code: number | null, signal?: string | null) => {
          exitCode = code ?? null
          exitSignal = signal ?? null
        })

        stream.on('close', () => {
          // 冲掉解码器里残留的半个字符，否则最后一行可能少一个字
          const rest = decoder.end()
          if (rest.length > 0) options.onText(rest)
          finish(() =>
            resolve({
              command,
              code: exitCode,
              signal: exitSignal,
              stderr: Buffer.concat(errChunks).toString('utf8'),
              aborted,
              durationMs: Date.now() - startedAt
            })
          )
        })

        stream.on('error', (err: Error) => {
          finish(() => reject(normalizeSshError(err, { ...this.ctx(), phase: 'exec' })))
        })

        if (options.signal) {
          if (options.signal.aborted) {
            onAbort()
          } else {
            options.signal.addEventListener('abort', onAbort, { once: true })
          }
        }

        // 兜底：用户忘了关也不能把通道占一整天
        if (maxDurationMs > 0) {
          timer = setTimeout(() => onAbort(), maxDurationMs)
        }
      })
    })
  }

  /**
   * 请求**远端**监听一个端口（SSH 的 `tcpip-forward`，即 `ssh -R`）。
   *
   * 绑定地址**硬编码成 `127.0.0.1`**，不开放参数。
   * 绑 `0.0.0.0` 会让整个集群（包括别人的机器）都能连到你本机的服务，
   * 和"本地转发只绑回环"是同一条红线，不给配置项就是不给犯这个错的机会。
   *
   * 返回值是**实际绑定成功的端口**。ssh2 在服务端指派了不同端口时会回传，
   * 不能想当然用传进去的那个。
   *
   * ⚠️ 失败要立刻抛（对应 `ssh -o ExitOnForwardFailure=yes`）：
   * ssh 的默认行为是"端口绑不上也照常连上"，用户会以为隧道开着、
   * 实际请求全打空。这里必须让调用方立刻知道。
   */
  async forwardIn(remotePort: number): Promise<number> {
    if (!this.isAlive) {
      throw new SshError({
        kind: 'reset',
        message: `与 ${this.profile.host} 的连接已断开`,
        hint: '重连一次即可。',
        raw: this.lastError?.raw ?? `session status: ${this.status}`,
        code: 'NOT_CONNECTED',
        retryable: true
      })
    }

    return new Promise<number>((resolve, reject) => {
      this.client.forwardIn(LOOPBACK, remotePort, (err, boundPort) => {
        if (err) {
          reject(normalizeSshError(err, { ...this.ctx(), phase: 'tunnel' }))
          return
        }
        resolve(boundPort ?? remotePort)
      })
    })
  }

  /** 释放远端端口。不调用的话端口会一直占着，直到这条 SSH 连接断开 */
  async unforwardIn(remotePort: number): Promise<void> {
    if (!this.isAlive) return
    await new Promise<void>((resolve) => {
      try {
        this.client.unforwardIn(LOOPBACK, remotePort, () => resolve())
      } catch {
        resolve()
      }
    })
  }

  /**
   * 订阅"远端转发进来了一个连接"。
   *
   * 事件挂在 Client 上是**所有反向转发共用的**，所以每条隧道都要按
   * `destPort` 自己过滤。返回取消订阅函数，关闭隧道时一定要调——
   * 否则关了十条隧道就有十个监听器都在跑。
   */
  onReverseConnection(listener: (connection: ReverseConnection) => void): () => void {
    const handler = (
      details: { destPort: number },
      accept: () => ClientChannel,
      reject: () => void
    ): void => {
      listener({ destPort: details.destPort, accept, reject })
    }

    this.client.on('tcp connection', handler)
    return () => {
      this.client.removeListener('tcp connection', handler)
    }
  }

  /**
   * 开一个交互式 shell（PTY）。
   *
   * **在登录节点上开**，不是计算节点：集群大多禁了计算节点的直连 SSH，
   * 而登录节点本来就允许交互登录，`module load` / `conda activate` / `salloc` 都在那儿用。
   *
   * 几个必须做对的地方：
   * - **`term` 要显式给 `xterm-256color`**。不给的话远端按 `dumb` 处理，
   *   `htop` / `vim` 这类全屏程序会画成一团。
   * - **必须用 `StringDecoder`**：汉字 3 字节，chunk 边界会把它劈开，
   *   直接 `toString('utf8')` 会在中文路径上出现乱码（和 `tail` 同一个坑）。
   * - **不走信号量**：交互会话是长连接，占一个并发名额就永久少一个。
   * - **`error` 必须监听**，否则一条坏连接会把主进程带下去。
   * - 关闭时会冲掉解码器里残留的半个字符，否则最后一行可能少一个字。
   */
  async openShell(initial: ShellSize, handlers: ShellHandlers): Promise<ShellHandle> {
    if (!this.isAlive) {
      throw new SshError({
        kind: 'reset',
        message: `与 ${this.profile.host} 的连接已断开`,
        hint: '重连一次即可。',
        raw: this.lastError?.raw ?? `session status: ${this.status}`,
        code: 'NOT_CONNECTED',
        retryable: true
      })
    }

    const cols = Math.max(20, Math.floor(initial.cols))
    const rows = Math.max(5, Math.floor(initial.rows))

    return new Promise<ShellHandle>((resolve, reject) => {
      this.client.shell({ term: 'xterm-256color', cols, rows }, (err, stream: ClientChannel) => {
        if (err) {
          reject(normalizeSshError(err, { ...this.ctx(), phase: 'exec' }))
          return
        }

        const decoder = new StringDecoder('utf8')
        let closed = false

        stream.on('data', (chunk: Buffer) => {
          const text = decoder.write(chunk)
          if (text.length > 0) handlers.onData(text)
        })

        // PTY 会把 stderr 合并进 stdout，一般不会有独立的 stderr，但有就一起吐出来
        stream.stderr?.on('data', (chunk: Buffer) => {
          const text = decoder.write(chunk)
          if (text.length > 0) handlers.onData(text)
        })

        stream.on('close', (code: number | null, signal?: string | null) => {
          if (closed) return
          closed = true
          const rest = decoder.end()
          if (rest.length > 0) handlers.onData(rest)
          handlers.onClose?.({ code: code ?? null, signal: signal ?? null })
        })

        // 不监听的话单条连接出错会冒泡成未捕获异常
        stream.on('error', () => {
          if (closed) return
          closed = true
          handlers.onClose?.({ code: null, signal: null })
        })

        resolve({
          write: (data: string) => {
            if (closed || stream.writableEnded) return
            stream.write(data)
          },
          resize: (size: ShellSize) => {
            if (closed) return
            // setWindow(rows, cols, height, width)：**先 rows 后 cols**，顺序反了会画歪
            try {
              stream.setWindow(Math.max(5, Math.floor(size.rows)), Math.max(20, Math.floor(size.cols)), 0, 0)
            } catch {
              // 通道已关时 setWindow 会抛，忽略即可
            }
          },
          close: () => {
            if (closed) return
            closed = true
            try {
              stream.close()
            } catch {
              // 已经关了
            }
            handlers.onClose?.({ code: null, signal: null })
          }
        })
      })
    })
  }

  /**
   * 开一条端口转发通道（SSH 的 `direct-tcpip`）。
   *
   * 语义是"让**登录节点**替我去连 `dstHost:dstPort`"，然后把这条连接的两端
   * 接到本地一个 TCP 端口上。所以：
   * - `dstHost` 用 `127.0.0.1` 表示登录节点自己
   * - 用 `gpu10` 这种计算节点名，则是让登录节点去连它——通常同集群内网可达，
   *   前提是 sshd 没关 `AllowTcpForwarding`（默认是开的）
   *
   * **不走信号量**：这是一条长连接，和 `tail` 同理。占着并发名额会让后续
   * exec 全部排队（默认并发只有 5）。服务端 `MaxSessions` 默认 10，够用。
   *
   * 失败常见原因：目标端口没人监听（`connect ECONNREFUSED`）、
   * 管理员关了 TCP 转发（`administratively prohibited`）。两种都要如实报，
   * 因为用户的下一步动作完全不同：前者是"服务没起来"，后者是"这条路被政策封了"。
   */
  async openTunnel(dstHost: string, dstPort: number): Promise<ClientChannel> {
    if (!this.isAlive) {
      throw new SshError({
        kind: 'reset',
        message: `与 ${this.profile.host} 的连接已断开`,
        hint: '重连一次即可。',
        raw: this.lastError?.raw ?? `session status: ${this.status}`,
        code: 'NOT_CONNECTED',
        retryable: true
      })
    }

    return new Promise<ClientChannel>((resolve, reject) => {
      this.client.forwardOut('127.0.0.1', 0, dstHost, dstPort, (err, channel) => {
        if (err) {
          reject(
            normalizeSshError(err, {
              ...this.ctx(),
              phase: 'tunnel'
            })
          )
          return
        }
        resolve(channel)
      })
    })
  }

  /**
   * 拿一条 SFTP 子系统通道，懒打开、复用。
   *
   * 一条 SFTP 通道可以承载成百上千次读写请求，不要每个文件开一条——
   * 开通道本身要一次往返，而且会占用服务端 MaxSessions 名额。
   *
   * ⚠️ 但**取消一次传输时反过来必须把它丢掉**：`fastPut`/`fastGet` 内部
   * 由 ssh2 自己驱动，没有 abort 入口，唯一的强制停手办法就是关掉这条通道。
   * 关掉之后 `close` 事件会把缓存清掉，下一次 `sftp()` 重新开一条——
   * 代价是一次往返，只在用户主动取消时才付。
   */
  async sftp(): Promise<SFTPWrapper> {
    if (!this.isAlive) {
      throw new SshError({
        kind: 'reset',
        message: `与 ${this.profile.host} 的连接已断开`,
        hint: '重连一次即可。',
        raw: this.lastError?.raw ?? `session status: ${this.status}`,
        code: 'NOT_CONNECTED',
        retryable: true
      })
    }

    if (this.sftpClient) return this.sftpClient
    if (this.sftpPending) return this.sftpPending

    const pending = new Promise<SFTPWrapper>((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) {
          reject(normalizeSshError(err, { ...this.ctx(), phase: 'exec' }))
          return
        }
        this.sftpClient = sftp
        // 通道跟着连接一起死，断开时清掉缓存，下次重连重新开
        sftp.on('close', () => {
          if (this.sftpClient === sftp) this.sftpClient = undefined
        })
        resolve(sftp)
      })
    })

    this.sftpPending = pending
    try {
      return await pending
    } finally {
      if (this.sftpPending === pending) this.sftpPending = undefined
    }
  }

  private ctx(): { host: string; port: number; username: string } {
    return { host: this.profile.host, port: this.profile.port, username: this.profile.username }
  }

  async close(): Promise<void> {
    if (this.status === 'closed') return
    const client = this.client
    // 先记账再断：`close` 事件里要靠它区分"我们关的"和"对面关的"
    this.closingByUs = true

    if (this.status !== 'ready') {
      client.destroy()
      this.closedReason ??= '本地主动关闭（连接尚未就绪）'
      this.markClosed()
      return
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        client.destroy()
        resolve()
      }, 2000)
      client.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      client.end()
    })
    // 正常情况下 'close' 事件已经写过原因了；这里兜的是"超时后 destroy"那条路
    this.closedReason ??= '本地主动关闭'
    this.markClosed()
  }
}

/**
 * 一句话说清"连接是怎么断的"。
 *
 * ## 为什么这里没有 exit code / signal，也没有 hadError
 *
 * `{ code, signal }` 是**通道**（exec / shell）的概念——`SessionOptions.onClose`
 * 里那一对就是通道的，`exit` 之后才有。连接（`Client`）本身没有：
 *
 * - ssh2 运行时的 `close` 会带一个 `hadError`，但 `@types/ssh2` 把它声明成
 *   `on('close', () => void)`，想拿它只能强转类型；
 * - 而且它本来就不带信息——真有错的话 `error` 事件**先**发生，那边有
 *   "心跳超时 / ECONNRESET / ENOTFOUND" 这种原话。
 *
 * 所以这里只回答"谁先动的"。想拿数字是拿不到的，硬编一个只会误导。
 */
export function describeClose(input: { byUs: boolean; remoteEnded: boolean }): string {
  if (input.byUs) return '本地主动关闭'
  if (input.remoteEnded) return '服务端主动断开了连接'
  return '连接被关闭（没拿到具体原因）'
}

function trimForDisplay(command: string, max = 120): string {
  const oneLine = command.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`
}

function hostKeyError(
  problem: { expected: string | null; actual: string; algorithm: string; reason: string },
  profile: ResolvedProfile
): SshError {
  const target = `${profile.host}:${profile.port}`

  if (problem.reason === 'mismatch') {
    return new SshError({
      kind: 'hostkey',
      message: `${target} 的主机指纹变了（${problem.algorithm}）`,
      hint: `本地记录 ${problem.expected ?? '（空）'}，服务器这次给的是 ${problem.actual}。若确认集群重装或换机，删掉 config/known_hosts.json 里 "${target}" 那条再重连；否则请先停下来核实。`,
      raw: `expected=${problem.expected ?? 'null'} actual=${problem.actual} algorithm=${problem.algorithm}`,
      code: 'HOSTKEY_MISMATCH'
    })
  }

  return new SshError({
    kind: 'hostkey',
    message: `${target} 是未记录过的主机，且该 profile 不允许自动信任`,
    hint: '把 profile 的 trustNewHostKey 设为 true（首次连接的常见做法），确认指纹无误后再重连。',
    raw: `fingerprint=${problem.actual} algorithm=${problem.algorithm}`,
    code: 'HOSTKEY_UNKNOWN'
  })
}

/**
 * 把 profile 里的凭据变成 ssh2 的 `ConnectConfig` 片段。
 *
 * 导出给 `latency.ts` 用：测速要开一条一次性连接，凭据解析必须和正式连接**同一份代码**，
 * 否则"密码在钥匙串里"那套逻辑会在两处各写一遍，然后慢慢走偏。
 */
export async function loadAuthMaterial(profile: ResolvedProfile): Promise<Partial<ConnectConfig>> {
  const { auth } = profile

  if (auth.method === 'password') {
    /*
     * 密码为空几乎总是"还没配"，而不是"配了一个空密码"。
     *
     * 以前直接把空串交给 ssh2，得到的是服务端返回的认证失败——
     * 界面上显示"密码错误"，用户会去反复核对自己记的密码，
     * 实际上他压根没存过。所以在这里拦住，说清是哪一种。
     */
    if (!auth.password || auth.password.length === 0) {
      const issue = profile.credentialIssue
      throw new SshError({
        kind: 'config',
        message: issue?.message ?? `profile ${profile.label} 用密码登录，但密码是空的`,
        hint:
          issue?.kind === 'undecryptable'
            ? '设置 → 登录凭据里重新输一次这个跳板机的密码。'
            : '设置 → 登录凭据里保存这个跳板机的密码；或者把 auth.method 改成 key 用私钥登录。',
        raw: issue ? `credential issue: ${issue.kind}` : 'auth.password is empty'
      })
    }
    return { password: auth.password }
  }

  const path = auth.privateKeyPath
  if (!path) {
    throw new SshError({
      kind: 'config',
      message: `profile ${profile.id} 的 auth.privateKeyPath 是空的`,
      hint: '填上私钥路径（支持 ~ 与相对 config 目录的相对路径）。',
      raw: 'auth.privateKeyPath is empty'
    })
  }

  let material: Buffer
  try {
    material = await readFile(path)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    throw new SshError({
      kind: 'config',
      message: `读不到私钥文件：${path}`,
      hint:
        code === 'ENOENT'
          ? '路径不对，或文件不在这台机器上。Windows 下路径分隔符用 / 或 \\\\ 都可以。'
          : '检查文件权限，确认没有被其他程序独占。',
      raw: (err as Error).message,
      code
    })
  }

  const passphrase = auth.passphrase && auth.passphrase.length > 0 ? auth.passphrase : undefined
  return { privateKey: material, ...(passphrase ? { passphrase } : {}) }
}
