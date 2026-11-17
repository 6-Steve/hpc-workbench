/**
 * 端口转发（SSH 隧道）。
 *
 * ## 解决什么问题
 *
 * 你在计算节点上跑了个 Jupyter（8888）或 TensorBoard（6006），
 * 但从笔记本根本连不上那台机器——中间隔着登录节点和内网。
 * 传统做法是手敲 `ssh -L 8888:gpu10:8888 user@login`，参数记错一个是常事。
 *
 * 这里把它做成"选一个正在跑的作业 → 选端口 → 得到 http://127.0.0.1:xxxx"。
 *
 * ## 三条硬约束
 *
 * 1. **本地只绑 `127.0.0.1`，绝不绑 `0.0.0.0`**。
 *    绑 0.0.0.0 等于把集群内网的服务暴露给同网段的任何人——这是安全红线，
 *    不是性能选项。改这一行之前先想清楚。
 * 2. **不用 `stream.pipeline()` 收尾**，用 `.pipe()` 链（和传输层同一个坑）：
 *    pipeline 会等两端都结束，而 SSH channel 要等对端关，容易僵住。
 * 3. **channel 的 `error` 必须监听**。不监听的话单条连接出错会冒泡成
 *    未捕获异常，把整个主进程带下去。
 */
import { createServer, type Server, type Socket } from 'node:net'
import { Transform } from 'node:stream'
import type { ClientChannel } from 'ssh2'
import type { Session } from '../ssh/session'

export interface TunnelRequest {
  /** 登录节点视角的目标主机：`127.0.0.1` = 登录节点自己，`gpu10` = 那台计算节点 */
  remoteHost: string
  remotePort: number
  /** 0 或不传 = 让系统分配一个空闲端口 */
  localPort?: number
  /** 界面上显示的名字，比如「Jupyter · 210522」 */
  label?: string
  /** 建在哪台跳板机上（界面用来区分两台登录节点的同名隧道） */
  profileId?: string
  profileLabel?: string
}

/**
 * 一条隧道。
 *
 * 字段用**方向中立**的名字：本地转发（-L）和反向转发（-R）的监听侧 / 目标侧
 * 正好互换，叫 `localPort/remotePort` 会在反向场景里说出"本机端口在集群上"
 * 这种自相矛盾的话。
 */
export interface TunnelInfo {
  id: string
  /** `local` = 本机监听转发到集群；`reverse` = 集群监听转发回本机 */
  direction: 'local' | 'reverse'
  label: string
  /** 目标：本地转发是集群上的服务；反向转发是你本机的服务 */
  targetHost: string
  targetPort: number
  /** 监听端口：本地转发在本机，反向转发在集群登录节点（两侧都只绑 127.0.0.1） */
  listenPort: number
  /** 只有 `local` 才有能直接打开的地址；`reverse` 不是给你开浏览器的 */
  url: string | null
  openedAt: number
  /** 累计接入的连接数：0 说明浏览器/客户端还没连上来 */
  connections: number
  bytesIn: number
  bytesOut: number
  /** 最近一次连接失败的原因（常见：目标端口没人监听） */
  lastError: string | null
  /**
   * 这条隧道建在哪台跳板机上。
   *
   * 没有这两个字段时，列表里两条 `集群 127.0.0.1:21056` 长得一模一样，
   * 用户根本分不出哪条在 hpc、哪条在 hpc-02——而"隧道建在哪台、Codex 就要在哪台
   * 上跑"恰恰是这对多登录节点的集群最关键的一条约束。
   */
  profileId?: string
  profileLabel?: string
}

interface TunnelRecord {
  info: TunnelInfo
  server: Server
  /** 正在使用的本地 socket 与远端 channel，关闭时要一起销毁 */
  sockets: Set<Socket>
  channels: Set<ClientChannel>
}

const LOOPBACK = '127.0.0.1'

export class TunnelManager {
  private readonly tunnels = new Map<string, TunnelRecord>()
  private seq = 0

  constructor(private readonly options: { onLog?: (message: string) => void } = {}) {}

  list(): TunnelInfo[] {
    return [...this.tunnels.values()].map((record) => ({ ...record.info }))
  }

  get(id: string): TunnelInfo | null {
    const record = this.tunnels.get(id)
    return record ? { ...record.info } : null
  }

  /**
   * 开一条隧道。返回时本地端口已经在监听了，界面可以直接给出地址。
   *
   * 注意：这里**不验证远端端口通不通**。开隧道只需本地能监听，
   * 远端是否真的在服务要等第一个连接进来才知道（那时会记进 `lastError`）。
   * 想提前验证的话得先转发一条连接出去，等于替用户发起一次请求，不做。
   */
  async open(session: Session, request: TunnelRequest): Promise<TunnelInfo> {
    const remoteHost = request.remoteHost.trim()
    if (remoteHost.length === 0) throw new Error('目标主机不能为空')

    const remotePort = Math.floor(request.remotePort)
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
      throw new Error(`目标端口不合法：${request.remotePort}`)
    }

    const localPortWanted = Math.floor(request.localPort ?? 0)
    if (localPortWanted !== 0 && (localPortWanted < 1 || localPortWanted > 65535)) {
      throw new Error(`本地端口不合法：${request.localPort}`)
    }

    this.seq += 1
    const id = `tunnel-${this.seq}-${Date.now().toString(36)}`
    const label = request.label?.trim() || `${remoteHost}:${remotePort}`

    const info: TunnelInfo = {
      id,
      direction: 'local',
      label,
      targetHost: remoteHost,
      targetPort: remotePort,
      listenPort: 0,
      url: null,
      openedAt: Date.now(),
      connections: 0,
      bytesIn: 0,
      bytesOut: 0,
      lastError: null,
      profileId: request.profileId,
      profileLabel: request.profileLabel
    }

    const record: TunnelRecord = { info, server: createServer(), sockets: new Set(), channels: new Set() }

    record.server.on('connection', (socket: Socket) => {
      void this.handleConnection(session, record, socket)
    })

    record.server.on('error', (err: Error) => {
      info.lastError = err.message
      this.options.onLog?.(`隧道监听出错：${err.message}`)
    })

    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        record.server.removeListener('listening', onListening)
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`本地端口 ${localPortWanted} 已被占用，换一个或者留空让系统分配。`))
          return
        }
        reject(err)
      }
      const onListening = (): void => {
        record.server.removeListener('error', onError)
        resolve()
      }

      record.server.once('error', onError)
      record.server.once('listening', onListening)
      // 只绑回环地址。见文件头的安全说明，别改成 0.0.0.0
      record.server.listen(localPortWanted, LOOPBACK)
    })

    const address = record.server.address()
    const boundPort = typeof address === 'object' && address !== null ? address.port : localPortWanted
    info.listenPort = boundPort
    info.url = `http://${LOOPBACK}:${boundPort}`

    // 绑定成功后换成持久日志监听（上面那个 once 只负责启动阶段的失败）
    record.server.on('error', (err: Error) => {
      info.lastError = err.message
    })

    this.tunnels.set(id, record)
    this.options.onLog?.(`隧道已开：${label} → ${LOOPBACK}:${boundPort}`)
    return { ...info }
  }

  private async handleConnection(session: Session, record: TunnelRecord, socket: Socket): Promise<void> {
    const { info } = record
    record.sockets.add(socket)

    let channel: ClientChannel
    try {
      channel = await session.openTunnel(info.targetHost, info.targetPort)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      info.lastError = message
      this.options.onLog?.(`隧道连接失败（${info.targetHost}:${info.targetPort}）：${message}`)
      // 浏览器连上来却拿不到任何响应，比直接断掉更让人困惑，所以回一段纯文本说明
      socket.end(`HPC 工作台：无法连接到 ${info.targetHost}:${info.targetPort}\n${message}\n`)
      record.sockets.delete(socket)
      return
    }

    record.channels.add(channel)
    info.connections += 1
    info.lastError = null

    const meterIn = new Transform({
      transform(chunk, _encoding, callback) {
        info.bytesIn += chunk.length
        callback(null, chunk)
      }
    })
    const meterOut = new Transform({
      transform(chunk, _encoding, callback) {
        info.bytesOut += chunk.length
        callback(null, chunk)
      }
    })

    // 用 .pipe() 链而不是 pipeline()：见文件头第 2 条
    channel.pipe(meterIn).pipe(socket)
    socket.pipe(meterOut).pipe(channel)

    const cleanup = (): void => {
      record.sockets.delete(socket)
      record.channels.delete(channel)
      socket.destroy()
      if (!channel.destroyed) channel.destroy()
    }

    socket.on('error', cleanup)
    socket.on('close', cleanup)
    // 这个监听是必须的：不监听的话单条连接出错会把主进程带下去
    channel.on('error', (err: Error) => {
      info.lastError = err.message
      cleanup()
    })
    channel.on('close', cleanup)
  }

  /** 关掉一条隧道：停止监听 → 断开所有活动连接。返回是否真的关掉了 */
  close(id: string): boolean {
    const record = this.tunnels.get(id)
    if (!record) return false

    record.server.close()
    for (const socket of record.sockets) socket.destroy()
    for (const channel of record.channels) {
      if (!channel.destroyed) channel.destroy()
    }
    record.sockets.clear()
    record.channels.clear()

    this.tunnels.delete(id)
    this.options.onLog?.(`隧道已关：${record.info.label}`)
    return true
  }

  /** 应用退出 / 断连时全部关掉，别留下还在监听的端口 */
  closeAll(): void {
    for (const id of [...this.tunnels.keys()]) this.close(id)
  }
}
