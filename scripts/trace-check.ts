/**
 * 命令台自检（命令行版）：不打界面，直接看「命令记录」会记到什么。
 *
 *   npm run trace-check
 *   npm run trace-check -- --profile gpu01
 *
 * 它走的是线上那条一模一样的路径：`ConnectionPool` 的 `onTrace` → `TraceStore`。
 * 因此这里打印出来的，就是界面抽屉里会显示的内容（时间 / 耗时 / 退出码 / 输出预览）。
 *
 * 为什么要这个脚本：界面得先有窗口才能验，而这台开发机起不来 GUI（docs/04 §6）。
 * 有了它，"挂钩到底有没有接上"这件事不必靠运气。
 */
import { join } from 'node:path'
import { loadProfiles, pickProfile } from '../src/main/profiles'
import { ConnectionPool } from '../src/main/ssh/pool'
import { KnownHostsStore } from '../src/main/ssh/known-hosts'
import { TraceStore } from '../src/main/trace/store'
import { SQUEUE_COMMAND } from '../src/main/adapters/squeue'
import { GPU_PRICE_COMMAND } from '../src/main/adapters/gpu-price'
import { POINTS_COMMAND } from '../src/main/adapters/points'
import { commandSummary, formatClock, formatDuration, isFailed, TRACE_LIMIT } from '../src/shared/trace'

const COLOR = Boolean(process.stdout.isTTY) && !process.env['NO_COLOR']
const paint = (code: string) => (text: string) => (COLOR ? `\x1b[${code}m${text}\x1b[0m` : text)
const dim = paint('2')
const bold = paint('1')
const green = paint('32')
const red = paint('31')

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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const loaded = loadProfiles(process.env['HPC_CONFIG'] ?? undefined)
  const profile = pickProfile(loaded, args.profile)

  console.log('')
  console.log(bold('HPC 工作台 · 命令台自检'))
  console.log(dim('─'.repeat(64)))
  console.log(`${dim('profile')}  ${profile.id}（${profile.username}@${profile.host}:${profile.port}）`)
  console.log('')

  const store = new TraceStore({ limit: TRACE_LIMIT })
  const pool = new ConnectionPool({
    knownHosts: new KnownHostsStore(join(loaded.dir, 'known_hosts.json')),
    onTrace: (input) => store.push(input)
  })

  // 这三条正好覆盖三种结果：正常 JSON、正常文本、以及一条故意写错的
  const commands = [SQUEUE_COMMAND, GPU_PRICE_COMMAND, POINTS_COMMAND, 'echo __trace_marker__ && exit 7']

  try {
    for (const command of commands) {
      console.log(dim(`→ ${command}`))
      await pool.run(profile, async (session) => {
        const result = await session.exec(command)
        console.log(dim(`  远端退出码 ${result.code}，${result.stdout.length} 字输出`))
      })
    }
  } finally {
    pool.closeAll()
  }

  console.log('')
  console.log(bold(`命令记录（${store.list().length} 条）`))
  console.log(dim('─'.repeat(64)))

  for (const entry of store.list()) {
    const code = entry.error ? 'ERR' : String(entry.code)
    const head = `${formatClock(entry.at)}  ${formatDuration(entry.durationMs).padStart(7)}  ${code.padStart(3)}  `
    const paintLine = isFailed(entry) ? red : green
    console.log(`${dim(head)}${paintLine(commandSummary(entry.command, 70))}`)

    const preview = (entry.stdout || entry.stderr).split('\n').filter(Boolean)[0] ?? ''
    if (preview) console.log(dim(`          ↳ ${preview.slice(0, 90)}`))
    if (entry.stdoutChars > entry.stdout.length) {
      console.log(dim(`          ↳ 完整输出去看 detail（共 ${entry.stdoutChars} 字，列表只给预览）`))
    }
  }

  // 验证 detail 这条路径真的能取回完整内容（界面上的「看完整输出」走的就是它）
  const first = store.list()[0]
  if (first) {
    const record = store.detail(first.id)
    console.log('')
    console.log(dim(`detail(${first.id}) → ${record ? `${record.fullStdout.length} 字完整输出` : '取不到'}`))
  }
  console.log('')
}

void main()
