/**
 * 作业日志定位与跟随（命令行版）。
 *
 *   npm run joblog-check                 列我的作业，挑一个自动验证
 *   npm run joblog-check -- 203815       指定作业号
 *   npm run joblog-check -- 203815 --tail 3   跟随 3 秒看增量
 *
 * 为什么需要它：日志定位这块的真相全在集群上——`scontrol` 给不给
 * `standard_output`、作业被清理后长什么样、`tail -F` 能不能跟住，
 * 在本机用夹具是测不出来的。而界面上验证又得先能启动 Electron。
 */
import { join } from 'node:path'
import { loadProfiles, pickProfile, ConfigError } from '../src/main/profiles'
import { ConnectionPool } from '../src/main/ssh/pool'
import { KnownHostsStore } from '../src/main/ssh/known-hosts'
import { formatSshError, SshError } from '../src/main/ssh/errors'
import { parseScontrolJob, scontrolJobCommand } from '../src/main/adapters/scontrol-job'
import { parseSqueue, SQUEUE_COMMAND } from '../src/main/adapters/squeue'
import { shq } from '../src/main/ssh/shell'
import type { Session } from '../src/main/ssh/session'

interface Args {
  jobId?: string
  /** 直接跟一个远端文件，跳过作业查询（调跟随逻辑时用） */
  file?: string
  tailSeconds: number
  profile?: string
}

const COLOR = Boolean(process.stdout.isTTY) && !process.env['NO_COLOR']
const paint = (code: string) => (text: string) => (COLOR ? `\x1b[${code}m${text}\x1b[0m` : text)
const dim = paint('2')
const bold = paint('1')
const green = paint('32')
const red = paint('31')
const cyan = paint('36')

function parseArgs(argv: string[]): Args {
  const args: Args = { tailSeconds: 0 }

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!
    if (token === '--tail') {
      args.tailSeconds = Number.parseInt(argv[i + 1] ?? '3', 10) || 3
      i += 1
    } else if (token === '--file') {
      args.file = argv[i + 1]
      i += 1
    } else if (token === '--profile') {
      args.profile = argv[i + 1]
      i += 1
    } else if (!token.startsWith('-') && /^\d+$/.test(token)) {
      args.jobId = token
    }
  }

  return args
}

/**
 * 跟随一个文件若干秒。
 *
 * 打印收到的每一行，最后报块数 / 字节 / 是否主动中止。
 * 中文是否完好就看打印出来的内容——`StringDecoder` 没接好时这里会出乱码。
 */
async function followFile(session: Session, path: string, seconds: number): Promise<void> {
  console.log('')
  console.log(bold(`[跟随] tail -n 5 -F -- ${path}   （${seconds} 秒后自动停）`))

  const controller = new AbortController()
  let bytes = 0
  let chunks = 0
  const timer = setTimeout(() => controller.abort(), seconds * 1000)

  const result = await session.tail(`tail -n 5 -F -- ${shq(path)}`, {
    onText: (text) => {
      bytes += Buffer.byteLength(text, 'utf8')
      chunks += 1
      for (const line of text.replace(/\n$/, '').split('\n').filter(Boolean)) {
        console.log(`      ${green('+')} ${line}`)
      }
    },
    signal: controller.signal
  })
  clearTimeout(timer)

  console.log('')
  console.log(
    `      ${dim('主动中止')}=${result.aborted ? '是' : '否'}　${dim('数据块')}=${chunks}　${dim('字节')}=${bytes}　${dim(
      '耗时'
    )}=${result.durationMs} ms`
  )
  if (bytes === 0) console.log(dim('      这段时间没有新输出（文件没增长）'))
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const configPath = process.env['HPC_CONFIG'] ?? undefined

  const loaded = loadProfiles(configPath)
  const profile = pickProfile(loaded, args.profile)

  console.log('')
  console.log(bold('HPC 工作台 · 作业日志定位'))
  console.log(dim('─'.repeat(58)))
  console.log(`${dim('配置')}     ${loaded.path}`)
  console.log(`${dim('profile')}  ${profile.id}（${profile.label}）`)
  console.log('')

  const pool = new ConnectionPool({
    knownHosts: new KnownHostsStore(join(loaded.dir, 'known_hosts.json'))
  })
  try {
    await pool.run(profile, async (session) => {
      // --file 模式：跳过作业查询，只验跟随
      if (args.file) {
        console.log(bold(`直接跟随文件：${args.file}`))
        await followFile(session, args.file, args.tailSeconds)
        return
      }

      let jobId = args.jobId

      if (!jobId) {
        const queue = await session.exec(SQUEUE_COMMAND)
        const parsed = parseSqueue(queue.stdout)
        if (!parsed.ok) {
          console.log(red(`读不到作业列表：${parsed.reason}`))
          return
        }
        const running = parsed.data.find((job) => job.state === 'running')
        const pick = running ?? parsed.data[0]
        if (!pick) {
          console.log('队列里没有作业可用来自检。传一个作业号试试：npm run joblog-check -- 123456')
          return
        }
        jobId = pick.id
        console.log(dim(`自动挑中作业 ${jobId}（${pick.name} / ${pick.rawState}）`))
        console.log('')
      }

      // —— 1. 详情 ——
      console.log(bold('[1/3] scontrol show job --json'))
      const raw = await session.exec(scontrolJobCommand(jobId))
      const parsed = parseScontrolJob(raw.stdout)

      if (!parsed.ok) {
        console.log(red(`      解析失败：${parsed.reason}`))
        console.log(dim(`      原始输出前 300 字：${parsed.raw.slice(0, 300)}`))
        return
      }

      const detail = parsed.data
      const line = (label: string, value: string | number | null): void => {
        console.log(`      ${dim(label.padEnd(10))} ${value === null || value === '' ? dim('—') : value}`)
      }
      line('作业号', detail.id)
      line('名称', detail.name)
      line('状态', `${detail.rawState}${detail.stateReason ? `（${detail.stateReason}）` : ''}`)
      line('分区', detail.partition)
      line('节点', detail.nodes)
      line('资源', `${detail.cpus ?? '?'} 核 / ${detail.gpus ?? 0} 卡 / ${detail.memoryMb ?? '?'} MB`)
      line('工作目录', detail.workDir)
      line('输出文件', detail.stdoutPath)
      console.log('')

      // —— 2. 文件在不在 ——
      console.log(bold('[2/3] 输出文件是否存在'))
      if (detail.stdoutPath === null) {
        console.log(red('      集群没给输出路径'))
        return
      }
      const probe = await session.exec(`test -f ${shq(detail.stdoutPath)} && echo __YES__ || echo __NO__`)
      const exists = probe.stdout.includes('__YES__')
      console.log(`      ${exists ? green('存在') : red('不存在')}  ${dim(detail.stdoutPath)}`)
      if (!exists) {
        console.log(dim('      作业可能还没写出第一行。'))
        return
      }
      console.log('')

      // —— 3. 读最后若干行 ——
      console.log(bold('[3/3] 读最后 10 行'))
      const tailed = await session.exec(`tail -n 10 -- ${shq(detail.stdoutPath)}`)
      const lines = tailed.stdout.replace(/\n$/, '').split('\n')
      for (const text of lines) console.log(`      ${cyan('│')} ${text}`)
      console.log('')

      // —— 可选：跟随 ——
      if (args.tailSeconds > 0) {
        await followFile(session, detail.stdoutPath, args.tailSeconds)
      }
    })
  } finally {
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
