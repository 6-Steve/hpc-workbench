/**
 * 目录浏览延迟归因。
 *
 *   npm run latency-check
 *   npm run latency-check -- --profile hpc-02
 *   npm run latency-check -- --path /home
 *
 * 目的：把"点一下目录要等一会儿"拆成可量化的几段，而不是靠感觉猜。
 * 分别测：链路往返、SFTP 通道建立、realpath、readdir（不同规模目录）。
 * 每个采样跑多次取中位数，避免被一次抖动带偏。
 */
import { loadProfiles, pickProfile } from '../src/main/profiles'
import { formatSshError } from '../src/main/ssh/errors'
import { KnownHostsStore } from '../src/main/ssh/known-hosts'
import { ConnectionPool } from '../src/main/ssh/pool'

interface Args {
  profile?: string
  path?: string
}

const COLOR = Boolean(process.stdout.isTTY) && !process.env['NO_COLOR']
const paint = (code: string) => (text: string) => (COLOR ? `\x1b[${code}m${text}\x1b[0m` : text)
const dim = paint('2')
const bold = paint('1')
const green = paint('32')
const yellow = paint('33')

function parseArgs(argv: string[]): Args {
  const args: Args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!
    if (token === '--profile') args.profile = argv[++i]
    else if (token === '--path') args.path = argv[++i]
    else throw new Error(`认不出的参数：${token}`)
  }
  return args
}

/** 跑 n 次，返回中位数、最小、最大 */
async function sample(label: string, n: number, run: () => Promise<unknown>): Promise<void> {
  const times: number[] = []
  for (let i = 0; i < n; i += 1) {
    const t0 = performance.now()
    await run()
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  const median = times[Math.floor(times.length / 2)] ?? 0
  const min = times[0] ?? 0
  const max = times[times.length - 1] ?? 0

  const tone = median < 120 ? green : median < 400 ? yellow : paint('31')
  console.log(
    `  ${label.padEnd(30)} ${tone(median.toFixed(0).padStart(5) + ' ms')}` +
      dim(`   (min ${min.toFixed(0)} / max ${max.toFixed(0)}, n=${n})`)
  )
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const loaded = loadProfiles(process.cwd() + '/config/profiles.json')
  const profile = pickProfile(loaded, args.profile)

  console.log('')
  console.log(bold('HPC 工作台 · 目录浏览延迟归因'))
  console.log(dim('─'.repeat(62)))
  console.log(`${dim('profile')}  ${profile.id}  ${profile.host}:${profile.port}`)

  const pool = new ConnectionPool({
    knownHosts: new KnownHostsStore(loaded.dir + '/known_hosts.json'),
    onLog: () => {}
  })

  try {
    const session = await pool.acquire(profile)

    console.log('')
    console.log(bold('1. 链路往返（exec，纯 RTT）'))
    await sample('exec true', 8, () => session.exec('true'))

    console.log('')
    console.log(bold('2. SFTP 通道建立（只发生一次）'))
    const t0 = performance.now()
    const sftp = await session.sftp()
    console.log(`  ${'sftp subsystem'.padEnd(30)} ${(performance.now() - t0).toFixed(0).padStart(5)} ms${dim('   (首次)')}`)

    console.log('')
    console.log(bold('3. realpath（只有 path 为空时才调）'))
    await sample('realpath(".")', 5, () => new Promise((res, rej) => sftp.realpath('.', (e, p) => (e ? rej(e) : res(p)))))

    const home = await new Promise<string>((res, rej) => sftp.realpath('.', (e, p) => (e ? rej(e) : res(p))))
    const dirs: string[] = [home, home + '/..']
    if (args.path) dirs.push(args.path)

    console.log('')
    console.log(bold('4. readdir（每次进目录/上一级都要走一次）'))
    for (const dir of dirs) {
      const probe = await new Promise<Array<{ filename: string }>>((res, rej) =>
        sftp.readdir(dir, (e, list) => (e ? rej(e) : res(list)))
      )
      // 用真实条目数标出规模，否则"300 ms"没有意义
      await sample(`readdir ${dir} (${probe.length} 项)`, 5, () =>
        new Promise((res, rej) => sftp.readdir(dir, (e) => (e ? rej(e) : res(null))))
      )
    }

    console.log('')
    console.log(bold('结论参考'))
    console.log(dim('  < 120 ms  感知为"即时"，不需要优化'))
    console.log(dim('  120–400   能感觉到，但可接受；加加载态即可显著改善'))
    console.log(dim('  > 400 ms  明显卡顿，需要缓存 / 预取 / 减少往返'))
    console.log('')
    return 0
  } catch (err) {
    console.error('')
    console.error(paint('31')('✗ 测量失败'))
    console.error(formatSshError(err))
    return 1
  } finally {
    await pool.closeAll()
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
