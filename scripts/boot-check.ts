/**
 * 启动页自检：不打界面，直接跑一遍「配置 → 连接 → 队列」三步。
 *
 *   npm run boot-check
 *   npm run boot-check -- --profile gpu01
 *
 * 走的是和 `app:boot-status` **同一条路径**（同样的三条命令、同样的判据），
 * 所以这里打印出来的就是启动页会显示的三行结论。
 *
 * 为什么需要它：启动页的视觉只能人眼看（本机 GUI 起不来，docs/04 §6），
 * 但"三步会不会误判"是逻辑问题，必须能自动化验证。
 * 尤其是失败路径——真实使用时最可能出问题的地方，恰恰是平时看不到的那条分支。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadProfiles, pickProfile } from '../src/main/profiles'
import { ConnectionPool } from '../src/main/ssh/pool'
import { KnownHostsStore } from '../src/main/ssh/known-hosts'
import { SQUEUE_COMMAND, parseSqueue } from '../src/main/adapters/squeue'
import { BOOT_TIMEOUT_MS } from '../src/shared/boot'

const COLOR = Boolean(process.stdout.isTTY) && !process.env['NO_COLOR']
const paint = (code: string) => (text: string) => (COLOR ? `\x1b[${code}m${text}\x1b[0m` : text)
const dim = paint('2')
const bold = paint('1')
const green = paint('32')
const red = paint('31')
const yellow = paint('33')

function parseArgs(argv: string[]): { profile?: string } {
  const args: { profile?: string } = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--profile') {
      args.profile = argv[i + 1]
      i += 1
    }
  }
  return args
}

function line(phase: string, ok: boolean, message: string, ms: number, hint?: string): void {
  const mark = ok ? green('✓') : red('✗')
  const pad = phase.padEnd(8)
  console.log(`  ${mark} ${pad} ${message} ${dim(`${ms}ms`)}`)
  if (hint) console.log(`    ${yellow('→')} ${dim(hint)}`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const root = join(__dirname, '..')
  const configPath = process.env['HPC_CONFIG'] ?? join(root, 'config', 'profiles.json')

  console.log(bold('\n启动页三步检查\n'))
  const startedAt = Date.now()
  let failed = false

  // —— 1. 配置 ——
  const configStart = Date.now()
  if (!existsSync(configPath)) {
    line('config', false, '找不到配置文件', Date.now() - configStart, `期望路径：${configPath}`)
    console.log(red('\n结论：启动页会停在第一步，并给出「去诊断页」入口。\n'))
    process.exitCode = 1
    return
  }
  line('config', true, '配置文件已找到', Date.now() - configStart)

  const loaded = loadProfiles(configPath)
  const profile = pickProfile(loaded, args.profile)

  const knownHosts = new KnownHostsStore(join(root, 'config', 'known_hosts.json'))
  const pool = new ConnectionPool({ knownHosts })

  try {
    // —— 2. 连接 ——
    const connectStart = Date.now()
    const who = await pool.run(profile, (session) => session.exec('echo "$USER@$(hostname -s)"'))
    if (who.code !== 0) {
      line('connect', false, '能连上，但取不到身份信息', Date.now() - connectStart, who.stderr.trim())
      failed = true
      console.log(red('\n结论：启动页会停在连接这一步。\n'))
      process.exitCode = 1
      return
    }
    const target = who.stdout.trim().split('\n').pop()?.trim() || profile.label
    line('connect', true, `已连接 ${target}`, Date.now() - connectStart)

    // —— 3. 队列 ——
    const queueStart = Date.now()
    const listResult = await pool.run(profile, (session) => session.exec(SQUEUE_COMMAND))
    const parsed = parseSqueue(listResult.stdout)
    if (!parsed.ok) {
      line('queue', false, '连上了，但队列读不出来', Date.now() - queueStart, parsed.reason)
      failed = true
      console.log(red('\n结论：启动页会停在队列这一步，但**仍会放行**进主界面。\n'))
      process.exitCode = 1
      return
    }

    const jobs = parsed.data
    const running = jobs.filter((job) => job.state === 'running').length
    const pending = jobs.filter((job) => job.state === 'pending').length
    const message = jobs.length === 0 ? '队列里没有作业' : `${jobs.length} 个作业（${running} 跑 / ${pending} 排）`
    line('queue', true, message, Date.now() - queueStart)
  } finally {
    await pool.closeAll()
  }

  const totalMs = Date.now() - startedAt
  const budget = totalMs < BOOT_TIMEOUT_MS ? green(`${totalMs}ms`) : yellow(`${totalMs}ms（偏慢）`)
  console.log(`\n总耗时 ${budget} ${dim(`/ 预算 ${BOOT_TIMEOUT_MS}ms`)}`)
  console.log(failed ? red('\n结论：有一步没过。\n') : green('\n结论：三步全过，启动页会停 420ms 让人看清再淡出。\n'))
}

void main().catch((err: unknown) => {
  console.error(red(`启动检查崩了：${err instanceof Error ? err.message : String(err)}`))
  process.exitCode = 1
})
