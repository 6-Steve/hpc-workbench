/**
 * 端口转发自检（命令行版）。
 *
 *   npm run tunnel-check                       转发到登录节点的 127.0.0.1:18765
 *   npm run tunnel-check -- --port 8888        指定远端端口
 *   npm run tunnel-check -- --host gpu10       转发到计算节点
 *
 * 为什么必须有这个脚本：`direct-tcpip` 能不能用取决于服务端的
 * `AllowTcpForwarding`，本机测不出来。而界面上验证还得先能开 Electron 窗口。
 *
 * 用法示例（在跳板机上起个临时 HTTP 服务当靶子）：
 *   nohup python3 -m http.server 18765 --bind 127.0.0.1 > /dev/null 2>&1 &
 */
import { get } from 'node:http'
import { join } from 'node:path'
import { loadProfiles, pickProfile, ConfigError } from '../src/main/profiles'
import { ConnectionPool } from '../src/main/ssh/pool'
import { KnownHostsStore } from '../src/main/ssh/known-hosts'
import { formatSshError, SshError } from '../src/main/ssh/errors'
import { TunnelManager } from '../src/main/forward/tunnel'

interface Args {
  port: number
  host: string
  profile?: string
}

const COLOR = Boolean(process.stdout.isTTY) && !process.env['NO_COLOR']
const paint = (code: string) => (text: string) => (COLOR ? `\x1b[${code}m${text}\x1b[0m` : text)
const dim = paint('2')
const bold = paint('1')
const green = paint('32')
const red = paint('31')

function parseArgs(argv: string[]): Args {
  const args: Args = { port: 18765, host: '127.0.0.1' }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!
    if (token === '--port') {
      args.port = Number.parseInt(argv[i + 1] ?? '18765', 10) || 18765
      i += 1
    } else if (token === '--host') {
      args.host = argv[i + 1] ?? '127.0.0.1'
      i += 1
    } else if (token === '--profile') {
      args.profile = argv[i + 1]
      i += 1
    }
  }
  return args
}

/** 通过本地隧道地址发一个 HTTP GET，拿状态码和响应体开头 */
function fetchThrough(url: string): Promise<{ status: number; head: string }> {
  return new Promise((resolve, reject) => {
    const request = get(url, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => {
        if (Buffer.concat(chunks).length < 4000) chunks.push(chunk)
      })
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          head: Buffer.concat(chunks).toString('utf8').slice(0, 200)
        })
      })
    })
    request.on('error', reject)
    request.setTimeout(8000, () => request.destroy(new Error('请求超时（8 秒）')))
  })
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const loaded = loadProfiles(process.env['HPC_CONFIG'] ?? undefined)
  const profile = pickProfile(loaded, args.profile)

  console.log('')
  console.log(bold('HPC 工作台 · 端口转发自检'))
  console.log(dim('─'.repeat(58)))
  console.log(`${dim('目标')}  ${args.host}:${args.port}`)
  console.log('')

  const pool = new ConnectionPool({
    knownHosts: new KnownHostsStore(join(loaded.dir, 'known_hosts.json'))
  })
  const tunnels = new TunnelManager({ onLog: (message) => console.log(dim(`  · ${message}`)) })

  try {
    await pool.run(profile, async (session) => {
      console.log(bold('[1/3] 开隧道'))
      const info = await tunnels.open(session, {
        remoteHost: args.host,
        remotePort: args.port,
        label: '自检'
      })
      console.log(`      本地 ${green(info.url ?? '')}  →  ${info.targetHost}:${info.targetPort}`)

      console.log('')
      console.log(bold('[2/3] 通过隧道发一次 HTTP 请求'))
      try {
        // 本地转发一定有 url；这里断言一下，避免字段改成可空之后悄悄传 null
        if (info.url === null) throw new Error('本地转发没有返回本地地址')
        const result = await fetchThrough(info.url)
        const after = tunnels.get(info.id)!
        console.log(`      状态码 ${result.status}　连接数 ${after.connections}　下行 ${after.bytesIn} 字节`)
        console.log(`      响应开头：${dim(result.head.split('\n')[0] ?? '')}`)
        if (result.status !== 200) {
          console.log(red(`      ⚠ 状态码不是 200，目标服务可能没起在 ${args.port} 上`))
        }
      } catch (err) {
        console.log(red(`      请求失败：${(err as Error).message}`))
        console.log(dim('      这通常说明目标端口没人监听，或者 sshd 关了 TCP 转发'))
      }

      console.log('')
      console.log(bold('[3/3] 关隧道并确认端口已释放'))
      tunnels.close(info.id)
      try {
        await fetchThrough(info.url ?? '')
        console.log(red('      ⚠ 隧道关掉之后还能访问，端口没释放干净'))
      } catch {
        console.log(`      ${green('已断开')}${dim('（连接被拒绝是对的）')}`)
      }
    })
  } finally {
    tunnels.closeAll()
    await pool.closeAll()
  }

  console.log('')
}

main().catch((err: unknown) => {
  if (err instanceof ConfigError) {
    console.error(red(`配置有问题：${err.message}`))
    for (const issue of err.issues) console.error(`  · ${issue}`)
    process.exitCode = 1
    return
  }
  if (err instanceof SshError) {
    console.error(red(formatSshError(err)))
    process.exitCode = 1
    return
  }
  console.error(err)
  process.exitCode = 1
})
