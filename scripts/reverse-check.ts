/**
 * 反向隧道自检（命令行版）。
 *
 *   npm run reverse-check                  集群侧临时端口 55591 ← 本机随机端口
 *   npm run reverse-check -- --port 55555  指定集群侧端口
 *
 * 验证思路：在本机起一个 HTTP 服务当"代理"，通过反向隧道把它开到集群上，
 * 然后**在集群上 `curl` 那个端口**。能拿到 200 就说明整条链路通了——
 * 这正是"集群上的 codex 用你本机代理"的真实路径。
 *
 * 之所以必须有这个脚本：`-R` 能不能用、绑不绑得上，本机测不出来；
 * 而界面上验证还得先能开 Electron 窗口。
 */
import { createServer, get } from 'node:http'
import { join } from 'node:path'
import { loadProfiles, pickProfile, ConfigError } from '../src/main/profiles'
import { ConnectionPool } from '../src/main/ssh/pool'
import { KnownHostsStore } from '../src/main/ssh/known-hosts'
import { formatSshError, SshError } from '../src/main/ssh/errors'
import { ReverseTunnelManager } from '../src/main/forward/reverse'
import { lookupPortOwner, portBusyHint } from '../src/main/domain/port-owner'
import { readProxyPort } from '../src/main/domain/proxy-config'
import { openWithFallback } from '../src/main/domain/reverse-port'
import { clusterEgress, localProxyEgress } from '../src/main/domain/egress'
import { proxyExportSnippet } from '../src/shared/proxy'
import { describeVerify } from '../src/shared/tunnel-verify'

interface Args {
  port: number
  profile?: string
  /** 演示"默认端口被占时自动退到一个空闲端口" */
  fallback: boolean
  /** 验收模式：隧道指向本机 Clash，比对两边出口 IP */
  verify: boolean
}

const COLOR = Boolean(process.stdout.isTTY) && !process.env['NO_COLOR']
const paint = (code: string) => (text: string) => (COLOR ? `\x1b[${code}m${text}\x1b[0m` : text)
const dim = paint('2')
const bold = paint('1')
const green = paint('32')
const red = paint('31')

const DEFAULT_REMOTE_PORT = 55591
/** 本机 Clash 的混合端口；`--verify` 时把隧道指到这里 */
const CLASH_PORT = 7897

function parseArgs(argv: string[]): Args {
  const args: Args = { port: DEFAULT_REMOTE_PORT, fallback: false, verify: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!
    if (token === '--port') {
      args.port = Number.parseInt(argv[i + 1] ?? String(DEFAULT_REMOTE_PORT), 10) || DEFAULT_REMOTE_PORT
      i += 1
    } else if (token === '--fallback') {
      args.fallback = true
    } else if (token === '--verify') {
      args.verify = true
    } else if (token === '--profile') {
      args.profile = argv[i + 1]
      i += 1
    }
  }
  return args
}

/** 本机起一个最小的 HTTP 服务，当作"本机代理"的替身 */
async function startLocalServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(`hello-from-laptop ${request.url ?? ''}`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const loaded = loadProfiles(process.env['HPC_CONFIG'] ?? undefined)
  const profile = pickProfile(loaded, args.profile)

  console.log('')
  console.log(bold('HPC 工作台 · 反向隧道自检'))
  console.log(dim('─'.repeat(58)))
  console.log(`${dim('集群侧端口')}  ${args.port}`)
  console.log('')

  // 验收模式不用假靶子，目标是本机真实的 Clash
  const local = args.verify ? null : await startLocalServer()
  if (local) console.log(`${dim('本机靶子')}  http://127.0.0.1:${local.port}`)

  const pool = new ConnectionPool({
    knownHosts: new KnownHostsStore(join(loaded.dir, 'known_hosts.json'))
  })
  const tunnels = new ReverseTunnelManager({ onLog: (message) => console.log(dim(`  · ${message}`)) })

  const checks: Array<{ label: string; pass: boolean; detail: string }> = []

  /**
   * 验收模式：隧道直接指向本机 Clash，然后**比对两边的出口 IP**。
   *
   * 这是判断"隧道到底有没有把你的流量送回来"的唯一硬证据——
   * 端口在监听、连接数在涨，都可能是别人的服务在应答。
   */
  if (args.verify) {
    try {
      await pool.run(profile, async (session) => {
        console.log('')
        console.log(bold(`[验收] 集群 127.0.0.1:${args.port} → 本机 Clash 127.0.0.1:${CLASH_PORT}`))

        const info = await tunnels.open(session, {
          remotePort: args.port,
          localPort: CLASH_PORT,
          label: '验收'
        })

        const [cluster, host] = await Promise.all([
          clusterEgress(session, info.listenPort),
          localProxyEgress(CLASH_PORT)
        ])

        console.log(`  ${dim('集群经隧道出口')}  ${cluster.ip ?? `失败（${cluster.error}）`}`)
        console.log(`  ${dim('本机经 Clash 出口')}  ${host.ip ?? `失败（${host.error}）`}`)
        console.log('')

        const verdict = describeVerify(cluster, host)
        const mark = verdict.tone === 'ok' ? green('✓') : verdict.tone === 'warn' ? '!' : red('✗')
        console.log(`  ${mark} ${verdict.text}`)

        tunnels.close(info.id)
      })
    } finally {
      await local?.close()
      pool.closeAll()
    }
    return
  }

  // 单独的演示模式：给一个被占的端口，看它能不能自己退到一个能用的端口上
  if (args.fallback) {
    try {
      await pool.run(profile, async (session) => {
        console.log('')
        console.log(bold('[退端口模式] 给一个可能被占的端口，看它怎么处理'))
        const proxyPort = await readProxyPort(session)
        console.log(`  ${dim('集群 http_proxy 端口')}  ${proxyPort ?? '没读到（~/.profile 里没有这一行）'}`)

        const { tunnel, fallback } = await openWithFallback({
          run: session,
          requested: args.port,
          tryOpen: (port) =>
            tunnels.open(session, { remotePort: port, localPort: local!.port, label: '自检' })
        })

        if (fallback) {
          const who = fallback.owner
            ? (fallback.owner.username ?? `uid ${fallback.owner.uid}`)
            : '查不到是谁'
          console.log('')
          console.log(`  ${green('✓')} ${fallback.requested} 被占（${who}），已改到 ${bold(String(tunnel.listenPort))}`)
          if (proxyPort !== null && proxyPort !== tunnel.listenPort) {
            console.log('')
            console.log(`  ${dim('要让集群上的程序走这条新隧道，在当前终端执行：')}`)
            for (const line of proxyExportSnippet(tunnel.listenPort).split('\n')) {
              console.log(`    ${line}`)
            }
          }
        } else {
          console.log('')
          console.log(`  ${dim('端口本来就空着，没用到退端口')} → ${tunnel.listenPort}`)
        }

        tunnels.close(tunnel.id)
      })
    } finally {
      await local?.close()
      pool.closeAll()
    }
    return
  }

  try {
    await pool.run(profile, async (session) => {
      console.log('')
      console.log(bold('[1/3] 申请集群侧监听'))

      let tunnelId: string | null = null
      try {
        const info = await tunnels.open(session, {
          remotePort: args.port,
          localPort: local!.port,
          label: '自检'
        })
        tunnelId = info.id
        checks.push({
          label: '集群侧端口绑定成功',
          pass: true,
          detail: `127.0.0.1:${info.listenPort}`
        })
      } catch (err) {
        // 对应 ExitOnForwardFailure：绑不上就立刻失败，不假装成功。
        // 注意 ssh2 抛的 "Unable to bind" 只表示服务端拒绝了，协议里没有原因，
        // 所以这里**真去查一次**是谁占着，而不是猜（127.0.0.1 是全用户共享的）。
        const owner = await lookupPortOwner(session, args.port)
        checks.push({
          label: '集群侧端口绑定成功',
          pass: false,
          detail: `${(err as Error).message} —— ${portBusyHint(args.port, owner)}`
        })
        return
      }

      console.log('')
      console.log(bold('[2/3] 在集群上 curl 那个端口'))
      const probe = await session.exec(
        `curl -s -m 8 -o /dev/null -w "%{http_code}" http://127.0.0.1:${args.port}/ || echo FAIL`
      )
      const code = probe.stdout.trim()
      const body = await session.exec(`curl -s -m 8 http://127.0.0.1:${args.port}/probe || echo FAIL`)

      checks.push({
        label: '集群侧能通过隧道打到本机服务',
        pass: code === '200' && body.stdout.includes('hello-from-laptop'),
        detail: `状态码 ${code}；响应体「${body.stdout.trim().slice(0, 60)}」`
      })

      console.log('')
      console.log(bold('[3/3] 关闭后集群侧应连不上'))
      const after = tunnels.get(tunnelId)
      tunnels.close(tunnelId)
      // 给 unforwardIn 一点时间生效
      await new Promise((resolve) => setTimeout(resolve, 600))

      const closedProbe = await session.exec(
        `curl -s -m 5 -o /dev/null -w "%{http_code}" http://127.0.0.1:${args.port}/ || echo FAIL`
      )
      const closedCode = closedProbe.stdout.trim()

      checks.push({
        label: '关闭后集群侧端口已释放',
        pass: closedCode !== '200',
        detail: `再次访问得到 ${closedCode === '200' ? '200（端口没释放！）' : '连不上（正确）'}`
      })

      if (after) {
        checks.push({
          label: '隧道统计到了这次连接',
          pass: after.connections > 0 && after.bytesIn + after.bytesOut > 0,
          detail: `连接 ${after.connections} 次，下行 ${after.bytesIn} / 上行 ${after.bytesOut} 字节`
        })
      }
    })
  } finally {
    tunnels.closeAll()
    await pool.closeAll()
    await local?.close()
  }

  console.log('')
  console.log(bold('结果'))
  for (const check of checks) {
    console.log(`  ${check.pass ? green('✓') : red('✗')} ${check.label}　${dim(check.detail)}`)
  }

  const failed = checks.filter((check) => !check.pass)
  console.log('')
  if (failed.length > 0) {
    console.log(red(`有 ${failed.length} 项没过`))
    process.exitCode = 1
  } else {
    console.log(green('全部通过'))
  }
  console.log('')
}

// get 只在类型层面用到，避免 lint 报未使用
void get

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
