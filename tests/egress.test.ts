/**
 * 「隧道到底通没通」的两次探测。
 *
 * 为什么这个必须测：它存在的唯一目的就是**推翻**"端口在监听 = 能用"这个错觉。
 * 如果探测本身写错了（比如把 curl 的报错当成 IP 收下），界面就会在真正出问题时
 * 显示"一切正常"——比没有这个功能更糟。
 */
import { createServer, type Server } from 'node:http'
import { describe, expect, it } from 'vitest'
import {
  clusterEgress,
  clusterEgressCommand,
  localProxyEgress,
  parseEgressIp,
  type EgressProbe
} from '../src/main/domain/egress'

function runner(stdout: string, stderr = '', code = 0): { exec: (command: string) => Promise<{ stdout: string; stderr: string; code: number }> } {
  return { async exec() { return { stdout, stderr, code } } }
}

describe('集群侧探测命令', () => {
  it('走 --proxy 指向隧道端口，并且带超时', () => {
    const command = clusterEgressCommand(55556)
    expect(command).toContain('--proxy http://127.0.0.1:55556')
    expect(command).toContain('-m 8')
    // 集群上要能取到公网 IP 才谈得上判断"从哪出去"
    expect(command).toContain('https://')
  })
})

describe('parseEgressIp：只认一个像 IP 的东西', () => {
  it('正常 IPv4', () => {
    expect(parseEgressIp('14.137.237.10\n')).toBe('14.137.237.10')
  })

  it('IPv6 也收', () => {
    expect(parseEgressIp('2408:8207:1234::1\n')).toBe('2408:8207:1234::1')
  })

  it('段值超过 255 的不是 IP', () => {
    expect(parseEgressIp('999.1.1.1')).toBeNull()
  })

  it('curl 的报错文本不能被当成 IP 收下', () => {
    // 这是最危险的误判：把错误当成成功，界面会显示"可用"
    expect(parseEgressIp('curl: (7) Failed to connect to 127.0.0.1 port 55556')).toBeNull()
    expect(parseEgressIp('')).toBeNull()
    expect(parseEgressIp('{"error":"nope"}')).toBeNull()
  })
})

describe('clusterEgress', () => {
  it('拿到 IP 就算成功', async () => {
    await expect(clusterEgress(runner('38.190.176.202\n'), 55556)).resolves.toEqual({
      ip: '38.190.176.202',
      error: null
    })
  })

  it('拿不到就把 stderr 原样带回去，别编原因', async () => {
    const probe = await clusterEgress(runner('', 'curl: (7) Failed to connect', 7), 55556)
    expect(probe.ip).toBeNull()
    expect(probe.error).toContain('curl: (7)')
  })

  it('exec 抛异常也转成结果，不往外抛', async () => {
    const broken = {
      async exec(): Promise<{ stdout: string; stderr: string; code: number }> {
        throw new Error('连接已断开')
      }
    }
    const probe = await clusterEgress(broken, 55556)
    expect(probe.ip).toBeNull()
    expect(probe.error).toBe('连接已断开')
  })
})

describe('localProxyEgress：走本机 Clash 取出口 IP', () => {
  let server: Server | undefined

  async function startFakeProxy(body: string): Promise<number> {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(body)
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    return typeof address === 'object' && address !== null ? address.port : 0
  }

  it('拿到代理返回的 IP', async () => {
    const port = await startFakeProxy('14.137.237.10')
    try {
      await expect(localProxyEgress(port, 3000)).resolves.toEqual({
        ip: '14.137.237.10',
        error: null
      })
    } finally {
      server?.close()
    }
  })

  it('代理回了一段不是 IP 的内容，算失败', async () => {
    const port = await startFakeProxy('<html>captive portal</html>')
    try {
      const probe = await localProxyEgress(port, 3000)
      expect(probe.ip).toBeNull()
      expect(probe.error).toContain('不是 IP')
    } finally {
      server?.close()
    }
  })

  it('端口没人听时给出连接错误，而不是干等', async () => {
    const port = await startFakeProxy('1.2.3.4')
    server?.close()
    server = undefined
    await new Promise<void>((resolve) => setTimeout(resolve, 80))
    const probe = await localProxyEgress(port, 2000)
    expect(probe.ip).toBeNull()
    expect(probe.error).toBeTruthy()
  })
})

/** 只是一个类型占位检查：EgressProbe 两边都能用 */
describe('EgressProbe 形状', () => {
  it('成功与失败各占一个字段', () => {
    const ok: EgressProbe = { ip: '1.2.3.4', error: null }
    const bad: EgressProbe = { ip: null, error: '超时' }
    expect(ok.ip).toBeTruthy()
    expect(bad.error).toBeTruthy()
  })
})
