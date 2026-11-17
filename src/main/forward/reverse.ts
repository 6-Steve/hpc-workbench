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
  /** 取消订阅"远端连进来了"事件 */
  unsubscribe: () => void
  sockets: Set<Socket>
  channels: Set<ClientChannel>
}

export class ReverseTunnelManager {
  private readonly tunnels = new Map<string, ReverseRecord>()
  private seq = 0

  constructor(private readonly options: { onLog?: (message: string) => void } = {}) {}

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
      profileId: request.profileId,
      profileLabel: request.profileLabel
    }

    const record: ReverseRecord = {
      info,
      session,
      unsubscribe: () => {},
      sockets: new Set(),
      channels: new Set()
    }

    record.unsubscribe = session.onReverseConnection((connection) => {
      // Client 上的这个事件是所有反向转发共用的，必须按端口过滤
      if (connection.destPort !== boundPort) return
      this.handleConnection(record, connection.accept)
    })

    this.tunnels.set(id, record)
    this.options.onLog?.(`反向隧道已开：集群 127.0.0.1:${boundPort} → 本机 ${localHost}:${localPort}`)
    return { ...info }
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
    // pipeline 会等两端都结束，容易僵住（docs/04 E12）
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

    record.unsubscribe()
    for (const socket of record.sockets) socket.destroy()
    for (const channel of record.channels) if (!channel.destroyed) channel.destroy()
    record.sockets.clear()
    record.channels.clear()

    // 释放集群上的端口；不调的话要等整条 SSH 连接断开才回收
    void record.session.unforwardIn(record.info.listenPort)

    this.tunnels.delete(id)
    this.options.onLog?.(`反向隧道已关：${record.info.label}`)
    return true
  }

  closeAll(): void {
    for (const id of [...this.tunnels.keys()]) this.close(id)
  }
}
