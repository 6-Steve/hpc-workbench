/**
 * 反向隧道。
 *
 * 用假的 `Session` 模拟 SSH 那一侧，但**本机目标是真实 TCP 服务**——
 * 要验的是"集群那边进来一个连接，能不能正确接到本机端口上并双向通"，
 * 而这恰好是本机就能完整复现的部分。
 */
import { createServer, type Server } from 'node:net'
import { Duplex } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { ReverseTunnelManager } from '../src/main/forward/reverse'
import type { ReverseConnection, Session } from '../src/main/ssh/session'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待超时')
    await sleep(10)
  }
}

/** 本机回环 echo 服务：收到什么原样回什么 */
async function startEchoServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => {
    socket.on('data', (chunk) => socket.write(chunk))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { server, port }
}

interface FakeSession {
  session: Session
  /** 模拟"集群那边来了一个连接" */
  incoming: (destPort: number) => { received: string[]; feed: (text: string) => void }
  forwarded: number[]
  unforwarded: number[]
  unsubscribed: () => boolean
  failNextForward: boolean
  /** 模拟"底下的连接掉了"：isAlive 变 false，并通知 onClose 的订阅者 */
  drop: () => void
  /** 这条假连接是不是已经被关掉了 */
  alive: () => boolean
}

function fakeSession(): FakeSession {
  let listener: ((connection: ReverseConnection) => void) | null = null
  const forwarded: number[] = []
  const unforwarded: number[] = []
  const closeListeners = new Set<() => void>()
  let alive = true

  const state: FakeSession = {
    forwarded,
    unforwarded,
    failNextForward: false,
    alive: () => alive,
    drop: () => {
      alive = false
      for (const notify of [...closeListeners]) notify()
      closeListeners.clear()
    },
    unsubscribed: () => listener === null,
    session: {
      get isAlive(): boolean {
        return alive
      },
      async close(): Promise<void> {
        state.drop()
      },
      onClose(notify: () => void): () => void {
        closeListeners.add(notify)
        return () => closeListeners.delete(notify)
      },
      async forwardIn(port: number): Promise<number> {
        if (state.failNextForward) throw new Error('administratively prohibited')
        forwarded.push(port)
        return port
      },
      async unforwardIn(port: number): Promise<void> {
        unforwarded.push(port)
      },
      onReverseConnection(incoming: (connection: ReverseConnection) => void): () => void {
        listener = incoming
        return () => {
          listener = null
        }
      }
    } as unknown as Session,
    incoming: (destPort: number) => {
      const received: string[] = []
      const channel = new Duplex({
        read() {},
        write(chunk: Buffer, _encoding, callback) {
          received.push(chunk.toString('utf8'))
          callback()
        }
      })
      const accept = (): Duplex => channel
      listener?.({ destPort, accept: accept as unknown as () => never, reject: () => {} })
      return {
        received,
        feed: (text: string) => channel.push(Buffer.from(text, 'utf8'))
      }
    }
  }

  return state
}

const managers: ReverseTunnelManager[] = []
const servers: Server[] = []

function newManager(options?: ConstructorParameters<typeof ReverseTunnelManager>[0]): ReverseTunnelManager {
  const manager = new ReverseTunnelManager(options)
  managers.push(manager)
  return manager
}

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.closeAll()
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('ReverseTunnelManager', () => {
  it('开隧道后字段是"集群监听 → 本机目标"，没有可打开的 url', async () => {
    const fake = fakeSession()
    const manager = newManager()

    const info = await manager.open(fake.session, { remotePort: 55555, localPort: 7897 })

    expect(info.direction).toBe('reverse')
    expect(info.listenPort).toBe(55555)
    expect(info.targetHost).toBe('127.0.0.1')
    expect(info.targetPort).toBe(7897)
    // 反向隧道不是给你点开浏览器的，监听端在集群上
    expect(info.url).toBeNull()
    expect(fake.forwarded).toEqual([55555])
    expect(manager.list()).toHaveLength(1)
  })

  it('集群侧进来的连接会接到本机端口，双向通', async () => {
    const { server, port } = await startEchoServer()
    servers.push(server)

    const fake = fakeSession()
    const manager = newManager()
    const info = await manager.open(fake.session, { remotePort: 55555, localPort: port })

    const connection = fake.incoming(55555)
    // 从"集群"这一侧发数据，应该经本机端口 echo 回来
    connection.feed('ping')
    await waitFor(() => connection.received.join('').includes('ping'))

    expect(connection.received.join('')).toBe('ping')
    const after = manager.get(info.id)!
    expect(after.connections).toBe(1)
    expect(after.bytesIn).toBe(4)
    expect(after.bytesOut).toBe(4)
    expect(after.lastError).toBeNull()
  })

  it('端口不匹配的连接会被忽略（多个反向隧道共用同一个事件）', async () => {
    const { server, port } = await startEchoServer()
    servers.push(server)

    const fake = fakeSession()
    const manager = newManager()
    const info = await manager.open(fake.session, { remotePort: 55555, localPort: port })

    // 端口对不上，不该被处理
    const wrong = fake.incoming(6666)
    wrong.feed('nope')
    await sleep(60)
    expect(manager.get(info.id)!.connections).toBe(0)
  })

  it('本机目标连不上时记下原因，不往通道里写东西', async () => {
    const fake = fakeSession()
    const manager = newManager()
    // 9 这种端口在本机基本不可能有服务
    const info = await manager.open(fake.session, { remotePort: 55555, localPort: 9 })

    const connection = fake.incoming(55555)
    await waitFor(() => manager.get(info.id)!.lastError !== null)

    const after = manager.get(info.id)!
    expect(after.lastError).toContain('连不上本机')
    // 关键：对端是代理客户端，塞说明文本会污染协议，所以一个字都不能写
    expect(connection.received).toHaveLength(0)
  })

  it('绑定失败时 open 直接抛（对应 ExitOnForwardFailure）', async () => {
    const fake = fakeSession()
    fake.failNextForward = true
    const manager = newManager()

    await expect(manager.open(fake.session, { remotePort: 55555, localPort: 7897 })).rejects.toThrow(
      /administratively prohibited/
    )
    // 失败就不该留下记录，也不该占着端口
    expect(manager.list()).toHaveLength(0)
  })

  it('关闭时释放集群端口并退订事件', async () => {
    const fake = fakeSession()
    const manager = newManager()
    const info = await manager.open(fake.session, { remotePort: 55555, localPort: 7897 })

    expect(manager.close(info.id)).toBe(true)
    expect(fake.unforwarded).toEqual([55555])
    expect(fake.unsubscribed()).toBe(true)
    expect(manager.list()).toHaveLength(0)
  })

  it('端口越界直接拒绝，不去申请转发', async () => {
    const fake = fakeSession()
    const manager = newManager()

    await expect(manager.open(fake.session, { remotePort: 0, localPort: 7897 })).rejects.toThrow(
      /集群侧端口不合法/
    )
    await expect(manager.open(fake.session, { remotePort: 55555, localPort: 70000 })).rejects.toThrow(
      /本机目标端口不合法/
    )
    expect(fake.forwarded).toHaveLength(0)
  })

  it('closeAll 会释放每一个的集群端口（应用退出时靠它）', async () => {
    const fake = fakeSession()
    const manager = newManager()
    await manager.open(fake.session, { remotePort: 55555, localPort: 7897 })
    await manager.open(fake.session, { remotePort: 55556, localPort: 7898 })

    manager.closeAll()

    expect(fake.unforwarded.sort()).toEqual([55555, 55556])
    expect(manager.list()).toHaveLength(0)
  })
})

/* ────────────────────────────────────────────────────────────────────────
 * 断线。
 *
 * 反向隧道挂在一条长连接上，这条链路（本机 → 代理 → 跳板机）断是常态。
 * 原来有两个问题叠在一起：
 *   1. 连接断了，记录还留在列表里 —— 界面说"开着"，用户 curl 得到
 *      `Connection refused`，两边说的是同一件事，看着却像自相矛盾；
 *   2. 断了之后没有任何恢复动作，用户得自己发现、自己重开。
 * 下面这几条锁住"断了要说实话"和"断了会自己捞回来"。
 * ──────────────────────────────────────────────────────────────────────── */

const FAST = { reconnectBaseMs: 10, reconnectMaxAttempts: 3 }

describe('ReverseTunnelManager · 断线', () => {
  it('连接掉了：记录不删，但标成未连接并说明在重连', async () => {
    const fake = fakeSession()
    const manager = newManager({ ...FAST, getSession: async () => fakeSession().session })
    await manager.open(fake.session, { remotePort: 21056, localPort: 7897 })

    fake.drop()

    // 记录还在——凭空少一行比"显示已断开"更让人迷惑
    expect(manager.list()).toHaveLength(1)
    const info = manager.list()[0]!
    expect(info.connected).toBe(false)
    expect(info.lastError).toContain('正在重连')
  })

  it('没有 getSession 时明确说"已失效"，不去假装还能重连', async () => {
    const fake = fakeSession()
    const manager = newManager()
    await manager.open(fake.session, { remotePort: 21056, localPort: 7897 })

    fake.drop()

    const info = manager.list()[0]!
    expect(info.connected).toBe(false)
    expect(info.lastError).toContain('已经失效')
  })

  it('自动重连：在新连接上重新申请同一个端口，状态回到已连接', async () => {
    const first = fakeSession()
    const second = fakeSession()
    const manager = newManager({ ...FAST, getSession: async () => second.session })

    await manager.open(first.session, { remotePort: 21056, localPort: 7897 })
    first.drop()

    await waitFor(() => second.forwarded.length === 1)

    const info = manager.list()[0]!
    expect(second.forwarded).toEqual([21056])
    expect(info.connected).toBe(true)
    expect(info.lastError).toBeNull()
    expect(info.listenPort).toBe(21056)
  })

  it('重连后转发仍然通（换的是连接，不是隧道）', async () => {
    const first = fakeSession()
    const second = fakeSession()
    const manager = newManager({ ...FAST, getSession: async () => second.session })
    const echo = await startEchoServer()
    servers.push(echo.server)

    await manager.open(first.session, { remotePort: 21056, localPort: echo.port })
    first.drop()
    await waitFor(() => second.forwarded.length === 1)

    // 重连之后，集群那边进来一个连接，仍然要接到本机端口上
    const conn = second.incoming(21056)
    conn.feed('ping')
    await waitFor(() => conn.received.join('') === 'ping')
    expect(manager.list()[0]!.connections).toBe(1)
  })

  it('重连失败会一直试到上限，然后老实说"重连 N 次都没成功"', async () => {
    const first = fakeSession()
    let attempts = 0
    const manager = newManager({
      ...FAST,
      getSession: async () => {
        attempts += 1
        throw new Error('network unreachable')
      }
    })

    await manager.open(first.session, { remotePort: 21056, localPort: 7897 })
    first.drop()

    await waitFor(() => (manager.list()[0]?.lastError ?? '').includes('都没成功'), 4000)

    expect(attempts).toBe(3)
    const info = manager.list()[0]!
    expect(info.connected).toBe(false)
    expect(info.lastError).toContain('请手动重开')
  })

  it('用户主动关掉之后不再重连（定时器要清干净）', async () => {
    const fake = fakeSession()
    let attempts = 0
    const manager = newManager({
      ...FAST,
      getSession: async () => {
        attempts += 1
        throw new Error('should not happen')
      }
    })

    const info = await manager.open(fake.session, { remotePort: 21056, localPort: 7897 })
    fake.drop()
    manager.close(info.id)

    await sleep(120)

    expect(attempts).toBe(0)
    expect(manager.list()).toHaveLength(0)
  })
})
