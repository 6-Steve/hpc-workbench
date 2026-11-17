/**
 * 验证一条反向隧道"真的能用"，而不是"看起来开着"。
 *
 * ## 为什么光看端口在监听不够
 *
 * 反向隧道的成功条件有三个，界面只能直接看到第一个：
 *
 * 1. 集群侧端口绑上了（`forwardIn` 成功）
 * 2. 走这个端口能到**你本机**的代理（隧道链路本身）
 * 3. 你本机的代理还能出去（Clash 开着、有网络）
 *
 * 2 和 3 任一不成立，用户看到的都是"隧道已开"，然后 codex 报一个莫名其妙的网络错误。
 * 更糟的一种：那个端口上蹲着**别人的**服务，请求发出去了、也有响应，只是没走你的电脑
 * ——这种情况只有比对**出口 IP** 才能发现。
 *
 * 所以做法是：集群侧经隧道取一次出口 IP，本机经 Clash 取一次，两边对比。
 * 一致 = 确实走的是你的电脑；不一致 = 那个端口上的东西不是你的。
 */
import { request } from 'node:http'
import type { CommandRunner } from './port-owner'

export interface EgressProbe {
  /** 出口 IP；null 表示没测出来 */
  ip: string | null
  /** 失败原因（成功时为 null） */
  error: string | null
}

/** 在**集群上**执行：经本机隧道取一次出口 IP */
export function clusterEgressCommand(tunnelPort: number): string {
  return `curl -sS -m 8 --proxy http://127.0.0.1:${Math.floor(tunnelPort)} https://api.ipify.org`
}

/** 只接受一个像 IP 的东西。curl 出错时也会往 stdout 写内容，不能照单全收 */
export function parseEgressIp(raw: string): string | null {
  const token = raw.trim().split(/\s+/)[0] ?? ''
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(token)) {
    return token.split('.').every((part) => Number(part) <= 255) ? token : null
  }
  if (token.includes(':') && /^[0-9a-fA-F:]{3,45}$/.test(token)) return token
  return null
}

export async function clusterEgress(run: CommandRunner, tunnelPort: number): Promise<EgressProbe> {
  try {
    const result = await run.exec(clusterEgressCommand(tunnelPort))
    const ip = parseEgressIp(result.stdout)
    if (ip) return { ip, error: null }
    const detail = (result.stderr || result.stdout).trim()
    return { ip: null, error: detail || `curl 退出码 ${result.code ?? '?'}` }
  } catch (err) {
    return { ip: null, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 在**本机**执行：经 Clash 的混合端口取一次出口 IP。
 *
 * 用 HTTP 代理的标准写法（请求行里放绝对 URI），不引入任何依赖。
 * 超时与错误一律转成 `{ip:null, error}`——这是诊断，不该抛。
 */
export function localProxyEgress(proxyPort: number, timeoutMs = 8000): Promise<EgressProbe> {
  return new Promise<EgressProbe>((resolve) => {
    let settled = false
    const done = (probe: EgressProbe): void => {
      if (settled) return
      settled = true
      resolve(probe)
    }

    const req = request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method: 'GET',
        path: 'http://api.ipify.org/',
        headers: { Host: 'api.ipify.org' },
        timeout: timeoutMs
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          if (body.length < 200) body += chunk
        })
        res.on('end', () => {
          const ip = parseEgressIp(body)
          done(
            ip
              ? { ip, error: null }
              : { ip: null, error: `HTTP ${res.statusCode ?? '?'}：返回的不是 IP` }
          )
        })
      }
    )

    req.on('timeout', () => req.destroy(new Error('超时（8 秒）')))
    req.on('error', (err: Error) => done({ ip: null, error: err.message }))
    req.end()
  })
}
