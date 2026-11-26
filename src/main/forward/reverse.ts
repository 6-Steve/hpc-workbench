/**
 * 反向端口转发（SSH 的 `-R`）。
 *
 * ## 和本地转发（`-L`）的区别
 *
 * - `-L`：**本机**监听 → 转发到**集群**上的服务。用途是"我访问集群"。
 * - `-R`：**集群**监听 → 转发回**本机**的服务。用途是"**集群借我的网络出去**"。
 *
 * 典型场景就是让集群上的 codex 用上本机的代理：
 *
 * ```
 * ssh -R 127.0.0.1:55555:127.0.0.1:7897 hpc
 * ```
 *
 * 登录节点上出现 `127.0.0.1:55555`，连它等于连你笔记本的 `7897`（Clash 混合端口）。
 *
 * ## 三条硬约束
 *
 * 1. **集群侧只绑 `127.0.0.1`**（由 `Session.forwardIn()` 硬编码，没有参数可传）。
 *    绑 `0.0.0.0` 等于把本机的代理服务开放给整个集群，包括别人的机器。
 * 2. **绑定失败必须立刻抛**，对应原命令的 `-o ExitOnForwardFailure=yes`。
 *    ssh 默认是"端口绑不上也照常连上"，用户会以为隧道开着、实际请求全打空。
 * 3. **本机目标连不上时不要往通道里写任何东西**。这一侧的对端可能是 HTTP 代理客户端，
 *    塞一段说明文本会污染协议。直接断开，让对端看到干净的 EOF，原因记在界面上。
 */
import { connect, type Socket } from 'node:net'
import { Transform } from 'node:stream'
import type { ClientChannel } from 'ssh2'
import type { Session } from '../ssh/session'
import type { TunnelInfo } from './tunnel'

export interface ReverseTunnelRequest {
  /** 集群登录节点上监听哪个端口（只绑 127.0.0.1） */
  remotePort: number
  /** 本机目标的端口。`-R` 的语义是 `remote:local`，所以这是"本机"那一侧 */
  localPort: number
  /** 本机目标主机，默认 127.0.0.1 */
  localHost?: string
  label?: string
  /** 建在哪台跳板机上（两台登录节点会各有一条 21056，必须能区分） */
  profileId?: string
  profileLabel?: string
}

interface ReverseRecord {
  info: TunnelInfo
  session: Session
  /** 重连要用的参数（`remotePort` 是 fallback 之后**实际绑上**的那个） */
  request: ReverseTunnelRequest
  /** 取消订阅"远端连进来了"事件 */
  unsubscribe: () => void
  /** 取消订阅"连接关了"事件 */
  unsubscribeSession: () => void
  sockets: Set<Socket>
  channels: Set<ClientChannel>
  /** 已经重试过几次；连上之后归零 */
  attempts: number
  /** 下一次重连的定时器；null = 没在重连 */
  timer: ReturnType<typeof setTimeout> | null
  /** 用户主动关了。之后所有异步回调都要立刻收手 */
  closed: boolean
}

/**
 * 自动重连的节奏。
 *
 * 断线在这条链路上是常态（本机 → 代理 → 跳板机，中间任何一跳抖动都会断），
 * 所以"断了就报错、等人来点"不是可接受的交互：用户开着反向隧道是为了让集群
 * 能上网，断的时候他多半正在跑一个长任务，根本不会盯着这个界面。
 *
 * 立刻一次，然后 2s / 4s / 8s / 16s（封顶 30s），共 5 次约半分钟。还连不上就认了——
 * 再拖下去只会让用户以为它还活着。
 */
const RECONNECT_BASE_MS = 2000
const RECONNECT_MAX_ATTEMPTS = 5
const RECONNECT_MAX_DELAY_MS = 30_000

export interface ReverseTunnelOptions {
  onLog?: (message: string) => void
  /**
   * 断线后重新拿一条连接（同一个 profile）。
   *
   * **不传就等于不自动重连**，行为退回"断了就断"。单测里只关心转发行为时可以不给。
   */
  getSession?: (profileId: string | undefined) => Promise<Session>
  /** 退避基准；单测里调到几十毫秒 */
  reconnectBaseMs?: number
  reconnectMaxAttempts?: number
}

export class ReverseTunnelManager {
  private readonly tunnels = new Map<string, ReverseRecord>()
  private seq = 0

  constructor(private readonly options: ReverseTunnelOptions = {}) {}

  list(): TunnelInfo[] {
    return [...this.tunnels.values()].map((record) => ({ ...record.info }))
  }

  get(id: string): TunnelInfo | null {
    const record = this.tunnels.get(id)
    return record ? { ...record.info } : null
  }

  async open(session: Session, request: ReverseTunnelRequest): Promise<TunnelInfo> {
    const remotePort = Math.floor(request.remotePort)
    const localPort = Math.floor(request.localPort)

    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
      throw new Error(`集群侧端口不合法：${request.remotePort}`)
    }
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
      throw new Error(`本机目标端口不合法：${request.localPort}`)
    }

    const localHost = request.localHost?.trim() || '127.0.0.1'

    // 失败会抛（对应 ExitOnForwardFailure）。这里**不做 try/catch**：
    // 让错误原样往上走，由 IPC 层翻译给用户。"假装成功"是这条命令最危险的行为。
    const boundPort = await session.forwardIn(remotePort)
    const label = request.label?.trim() || `反向 · 集群 ${boundPort} ← 本机 ${localPort}`

    this.seq += 1
    const id = `rev-${this.seq}-${Date.now().toString(36)}`

    const info: TunnelInfo = {
      id,
      direction: 'reverse',
      label,
      targetHost: localHost,
      targetPort: localPort,
      listenPort: boundPort,
      // 反向隧道不是给你点开浏览器的：监听端在集群上，本机没有可访问的地址
      url: null,
      openedAt: Date.now(),
      connections: 0,
      bytesIn: 0,
      bytesOut: 0,
      lastError: null,
      connected: true,
      profileId: request.profileId,
      profileLabel: request.profileLabel
    }

    const record: ReverseRecord = {
      info,
      session,
      // 记的是**绑成功**的端口：openWithFallback 可能已经把它从 21056 退到了 21057，
      // 重连时还去抢原来的号是徒劳的
      request: { ...request, remotePort: boundPort },
      unsubscribe: () => {},
      unsubscribeSession: () => {},
      sockets: new Set(),
      channels: new Set(),
      attempts: 0,
      timer: null,
      closed: false
    }

    // 先入表再挂订阅：`onClose` 在"连接已经关了"时会**同步**回调，
    // 顺序反了的话那次回调会落在一个还不在表里的记录上
    this.tunnels.set(id, record)
    this.attach(record)
    this.options.onLog?.(`反向隧道已开：集群 127.0.0.1:${boundPort} → 本机 ${localHost}:${localPort}`)
    return { ...info }
  }

  /**
   * 把这条隧道挂到 `record.session` 上。
   *
   * 重连之后会再调一次（连接换了，两个订阅都得重挂）。两件事必须成对：
   * 只重挂 `onReverseConnection` 而忘了 `onClose`，下次断线就再也收不到通知，
   * 记录会一直显示"开着"。
   */
  private attach(record: ReverseRecord): void {
    const port = record.info.listenPort

    record.unsubscribe = record.session.onReverseConnection((connection) => {
      // Client 上的这个事件是所有反向转发共用的，必须按端口过滤
      if (connection.destPort !== port) return
      this.handleConnection(record, connection.accept)
    })

    record.unsubscribeSession = record.session.onClose(() => {
      record.unsubscribeSession = () => {}
      this.onSessionLost(record)
    })
  }

  /**
   * 底下的连接掉了。
   *
   * 这里**不删记录**：删掉的话界面会凭空少一行，用户只会觉得"闪了一下"，
   * 不知道发生了什么。留一行"已断开 · 正在重连"比消失有信息量。
   */
  private onSessionLost(record: ReverseRecord): void {
    if (record.closed || record.timer) return

    record.info.connected = false

    /*
     * 把连接自己给的原因带出去。
     *
     * 拿不到 code/signal——ssh2 的连接层就没有这东西（`{code, signal}` 是通道的）。
     * 但"服务端主动断开了连接"和"心跳超时"这两句已经足够区分
     * "跳板机在清理空闲连接"和"你这边网络断了"，比一句干巴巴的"已断开"有用得多。
     */
    const why = record.session.closeReason ?? '与集群的连接已断开'

    if (!this.options.getSession) {
      record.info.lastError = `${why}，这条隧道已经失效`
      this.options.onLog?.(`反向隧道断开：${record.info.label}（${why}）`)
      return
    }

    record.info.lastError = `${why}，正在重连…`
    this.options.onLog?.(`反向隧道断开，开始重连：${record.info.label}（${why}）`)
    this.scheduleReconnect(record)
  }

  private scheduleReconnect(record: ReverseRecord): void {
    if (record.closed) return

    const max = this.options.reconnectMaxAttempts ?? RECONNECT_MAX_ATTEMPTS
    if (record.attempts >= max) {
      record.info.lastError = `重连 ${max} 次都没成功，请手动重开（也可能是跳板机换了）`
      this.options.onLog?.(`反向隧道重连放弃：${record.info.label}`)
      return
    }

    record.attempts += 1
    const base = this.options.reconnectBaseMs ?? RECONNECT_BASE_MS

    /*
     * 第一次**立刻**试，之后才退避。
     *
     * 最常见的断线不是网络没了，而是连接池把它判死然后重连（`pool.run` 遇到
     * 可重试错误会 `invalidate()`，那条连接上的所有隧道一起没）——这种情况下
     * 新连接几毫秒后就有了，让用户白等 2 秒毫无意义。
     * 真断网时第一次也会秒失败，退避从第二次开始照样生效。
     */
    const wait = record.attempts === 1 ? 0 : Math.min(base * 2 ** (record.attempts - 2), RECONNECT_MAX_DELAY_MS)

    record.timer = setTimeout(() => {
      record.timer = null
      void this.attemptReconnect(record)
    }, wait)
  }

  private async attemptReconnect(record: ReverseRecord): Promise<void> {
    if (record.closed || !this.options.getSession) return

    try {
      const session = await this.options.getSession(record.info.profileId)

      /*
       * await 期间用户可能已经把这条关掉了。
       *
       * 注意这里**不能 `session.close()`**：`getSession` 给的是连接池里的共享连接，
       * 关它等于把别人的队列、传输、终端一起断掉。要收手的只有"这条隧道"。
       */
      if (record.closed) return

      const bound = await session.forwardIn(record.request.remotePort)
      if (record.closed) {
        // 端口已经申请下来了，但这条已经没人要了，还回去就行
        void session.unforwardIn(bound)
        return
      }

      // 换连接：旧订阅在死连接上，取消只是为了不泄漏
      record.unsubscribe()
      record.unsubscribeSession()
      record.session = session
      record.info.listenPort = bound
      record.info.connected = true
      record.info.lastError = null
      record.attempts = 0
      this.attach(record)

      this.options.onLog?.(`反向隧道已重连：集群 127.0.0.1:${bound} → 本机 ${record.info.targetHost}:${record.info.targetPort}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      record.info.lastError = `重连失败（${message}）`
      this.options.onLog?.(`反向隧道重连失败：${message}`)
      this.scheduleReconnect(record)
    }
  }

  private handleConnection(record: ReverseRecord, accept: () => ClientChannel): void {
    const { info } = record

    let channel: ClientChannel
    try {
      channel = accept()
    } catch (err) {
      info.lastError = err instanceof Error ? err.message : String(err)
      return
    }

    record.channels.add(channel)
    info.connections += 1

    const socket = connect({ host: info.targetHost, port: info.targetPort })
    record.sockets.add(socket)

    const cleanup = (): void => {
      record.sockets.delete(socket)
      record.channels.delete(channel)
      socket.destroy()
      if (!channel.destroyed) channel.destroy()
    }

    socket.on('error', (err: Error) => {
      // 本机目标没起来（比如 Clash 没开）就走这里。
      // **不往通道里写说明文本**：对端可能是代理客户端，写了会污染协议
      info.lastError = `连不上本机 ${info.targetHost}:${info.targetPort} —— ${err.message}`
      this.options.onLog?.(`反向隧道连接失败：${info.lastError}`)
      cleanup()
    })

    socket.on('close', cleanup)
    // 这个监听必须有，否则一条坏通道会把主进程带下去
    channel.on('error', (err: Error) => {
      info.lastError = err.message
      cleanup()
    })
    channel.on('close', cleanup)

    // 用 .pipe() 链而不是 pipeline()：channel 是 Duplex，
    // pipeline 会等两端都结束，容易僵住
    channel.pipe(
      new Transform({
        transform(chunk, _encoding, callback) {
          info.bytesIn += chunk.length
          callback(null, chunk)
        }
      })
    ).pipe(socket)

    socket
      .pipe(
        new Transform({
          transform(chunk, _encoding, callback) {
            info.bytesOut += chunk.length
            callback(null, chunk)
          }
        })
      )
      .pipe(channel)
  }

  close(id: string): boolean {
    const record = this.tunnels.get(id)
    if (!record) return false

    // 先置位再拆：正在飞的重连回调看到 closed 就会收手
    record.closed = true
    if (record.timer) {
      clearTimeout(record.timer)
      record.timer = null
    }

    record.unsubscribe()
    record.unsubscribeSession()
    for (const socket of record.sockets) socket.destroy()
    for (const channel of record.channels) if (!channel.destroyed) channel.destroy()
    record.sockets.clear()
    record.channels.clear()

    /*
     * 释放集群上的端口；不调的话要等整条 SSH 连接断开才回收。
     *
     * 连接已经死了就跳过——`unforwardIn` 会往一条没有的通道上写包，
     * 抛出来的错误既没人接也没意义。用 `!== false` 是因为假 Session（单测）
     * 上没有这个 getter，当"活着"处理才能验到释放这一步。
     */
    if (record.session.isAlive !== false) void record.session.unforwardIn(record.info.listenPort)

    this.tunnels.delete(id)
    this.options.onLog?.(`反向隧道已关：${record.info.label}`)
    return true
  }

  closeAll(): void {
    for (const id of [...this.tunnels.keys()]) this.close(id)
  }
}
