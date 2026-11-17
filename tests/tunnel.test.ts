/**
 * 端口转发的本地侧。
 *
 * 用假的 `Session`（只实现 `openTunnel`）跑**真实的 TCP socket**：
 * 要验的正是"本地端口监听 + 双向管道 + 关闭后释放"这些真会出问题的地方，
 * 而不是 SSH 本身。SSH 那一层由 `scripts/tunnel-check.ts` 在真集群上验。
 */
import { connect, createServer, type Server } from 'node:net'
import { Duplex } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { TunnelManager } from '../src/main/forward/tunnel'
import type { Session } from '../src/main/ssh/session'

/** 假 channel：收到什么就回什么，前面加个前缀，方便断言数据确实流过 */
function echoChannel(prefix = 'echo:'): Duplex {
  const channel = new Duplex({
    read() {
      // 不对接真实的读端，所有数据都是下面 write 推回来的
    },
    write(chunk: Buffer, _encoding, callback) {
      this.push(`${prefix}${chunk.toString('utf8')}`)
      callback()
    }
  })
  return channel
}

interface FakeSessionOptions {
  /** 让 openTunnel 直接失败，模拟"目标端口没人监听" */
  failWith?: string
  /** 记录 openTunnel 收到的目标，用来断言参数传递 */
  onOpen?: (host: string, port: number) => void
}

function fakeSession(options: FakeSessionOptions = {}): Session {
  return {
    async openTunnel(host: string, port: number): Promise<Duplex> {
      options.onOpen?.(host, port)
      if (options.failWith) throw new Error(options.failWith)
      return echoChannel()
    }
  } as unknown as Session
}

const managers: TunnelManager[] = []

function newManager(): TunnelManager {
  const manager = new TunnelManager()
  managers.push(manager)
  return manager
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.closeAll()
})

/** 往本地端口发一段数据，收集回包 */
function roundTrip(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port }, () => {
      socket.write(payload)
    })
    const chunks: Buffer[] = []
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      // 收到一段就算成功，不用等对端关闭
      socket.destroy()
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    socket.on('error', reject)
    socket.setTimeout(3000, () => {
      socket.destroy()
      reject(new Error('3 秒内没有收到数据'))
    })
  })
}

describe('TunnelManager', () => {
  it('开隧道后给出可用的本地地址，参数原样传给 SSH', async () => {
    const manager = newManager()
    const seen: Array<[string, number]> = []
    const session = fakeSession({ onOpen: (host, port) => seen.push([host, port]) })

    const info = await manager.open(session, { remoteHost: 'gpu10', remotePort: 8888, label: 'Jupyter' })

    expect(info.listenPort).toBeGreaterThan(0)
    // 对外给的地址必须是回环地址：绑 0.0.0.0 会把集群内网服务暴露给整个局域网
    expect(info.url).toBe(`http://127.0.0.1:${info.listenPort}`)
    expect(info.label).toBe('Jupyter')
    expect(manager.list()).toHaveLength(1)

    await roundTrip(info.listenPort, 'hi')
    expect(seen).toEqual([['gpu10', 8888]])
  })

  it('数据双向流动：本地发什么，远端 channel 收到什么，回包也能回来', async () => {
    const manager = newManager()
    const info = await manager.open(fakeSession(), { remoteHost: '127.0.0.1', remotePort: 9999 })

    const response = await roundTrip(info.listenPort, 'hello')
    expect(response).toBe('echo:hello')

    // 计数是给界面显示"真的有数据在走"的，顺带断言一下
    const after = manager.get(info.id)!
    expect(after.connections).toBe(1)
    expect(after.bytesOut).toBe(5)
    expect(after.bytesIn).toBeGreaterThanOrEqual(10)
  })

  it('关闭后本地端口立刻释放', async () => {
    const manager = newManager()
    const info = await manager.open(fakeSession(), { remoteHost: '127.0.0.1', remotePort: 9999 })
    const port = info.listenPort

    expect(manager.close(info.id)).toBe(true)
    expect(manager.list()).toHaveLength(0)

    await expect(roundTrip(port, 'x')).rejects.toBeTruthy()
  })

  it('关闭不存在的隧道返回 false，不炸', () => {
    const manager = newManager()
    expect(manager.close('nope')).toBe(false)
  })

  it('本地端口被占用时给出人话提示', async () => {
    // 先自己占一个端口
    const blocker: Server = createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const address = blocker.address()
    const busyPort = typeof address === 'object' && address !== null ? address.port : 0

    try {
      const manager = newManager()
      await expect(
        manager.open(fakeSession(), { remoteHost: '127.0.0.1', remotePort: 9999, localPort: busyPort })
      ).rejects.toThrow(/已被占用/)
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  })

  it('端口越界直接拒绝，不去监听', async () => {
    const manager = newManager()
    await expect(manager.open(fakeSession(), { remoteHost: 'gpu10', remotePort: 0 })).rejects.toThrow(/端口不合法/)
    await expect(manager.open(fakeSession(), { remoteHost: 'gpu10', remotePort: 70000 })).rejects.toThrow(/端口不合法/)
    await expect(manager.open(fakeSession(), { remoteHost: '', remotePort: 8888 })).rejects.toThrow(/主机不能为空/)
  })

  it('远端连不上时，本地这边能拿到一段说明而不是干等', async () => {
    const manager = newManager()
    const info = await manager.open(fakeSession({ failWith: 'connect ECONNREFUSED' }), {
      remoteHost: 'gpu10',
      remotePort: 8888
    })

    const response = await roundTrip(info.listenPort, 'GET / HTTP/1.1\r\n\r\n')
    // 浏览器直接连上来时，给一段可读的文本比直接断掉有用得多
    expect(response).toContain('无法连接到 gpu10:8888')
    expect(response).toContain('ECONNREFUSED')

    const after = manager.get(info.id)!
    expect(after.lastError).toContain('ECONNREFUSED')
    expect(after.connections).toBe(0)
  })

  it('closeAll 把所有隧道都关掉（应用退出时靠它）', async () => {
    const manager = newManager()
    const first = await manager.open(fakeSession(), { remoteHost: '127.0.0.1', remotePort: 1 })
    const second = await manager.open(fakeSession(), { remoteHost: '127.0.0.1', remotePort: 2 })

    manager.closeAll()

    expect(manager.list()).toHaveLength(0)
    await expect(roundTrip(first.listenPort, 'x')).rejects.toBeTruthy()
    await expect(roundTrip(second.listenPort, 'x')).rejects.toBeTruthy()
  })
})
