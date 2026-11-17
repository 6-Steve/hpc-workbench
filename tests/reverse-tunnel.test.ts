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
}

function fakeSession(): FakeSession {
  let listener: ((connection: ReverseConnection) => void) | null = null
  const forwarded: number[] = []
  const unforwarded: number[] = []

  const state: FakeSession = {
    forwarded,
    unforwarded,
    failNextForward: false,
    unsubscribed: () => listener === null,
    session: {
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

function newManager(): ReverseTunnelManager {
  const manager = new ReverseTunnelManager()
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
