/**
 * Adapter 检查器：连一次集群，把五个数据源各跑一遍并打印解析结果。
 *
 *   npm run inspect              人看的报告
 *   npm run inspect -- --json    结构化输出（下一步接 UI / 写库存管线时直接用）
 *   npm run inspect -- --profile hpc-02
 *
 * 与 probe 的分工：probe 回答"能不能连上、支持什么"，
 * inspect 回答"解析出来的数对不对"。Phase 0 的验收看这个。
 */
import { join, resolve } from 'node:path'
import { loadProfiles, pickProfile, ConfigError } from '../src/main/profiles'
import { ConnectionPool } from '../src/main/ssh/pool'
import { KnownHostsStore } from '../src/main/ssh/known-hosts'
import { formatSshError } from '../src/main/ssh/errors'
import { freeByType, totalGpus } from '../src/main/adapters/gres'
import { parseGpuPrice } from '../src/main/adapters/gpu-price'
import { parseNodeDetail } from '../src/main/adapters/node-detail'
import { parsePoints } from '../src/main/adapters/points'
import { parseQuota } from '../src/main/adapters/quota'
import { parseSqueue } from '../src/main/adapters/squeue'
import type { NodeInfo, ParseResult } from '../src/main/adapters/types'

interface Args {
  json: boolean
  help: boolean
  profile?: string
  config?: string
}

const COLOR = Boolean(process.stdout.isTTY) && !process.env['NO_COLOR']
const paint = (code: string) => (text: string) => (COLOR ? `\x1b[${code}m${text}\x1b[0m` : text)
const dim = paint('2')
const bold = paint('1')
const green = paint('32')
const red = paint('31')

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!
    switch (token) {
      case '--json':
        args.json = true
        break
      case '--help':
      case '-h':
        args.help = true
        break
      case '--profile':
        args.profile = argv[++i]
        break
      case '--config':
        args.config = argv[++i]
        break
      default:
        throw new Error(`认不出的参数：${token}`)
    }
  }
  return args
}

/** 按量级选单位：6T 比 6144.0G 好读 */
function humanBytes(bytes: number): string {
  const tb = bytes / 1024 ** 4
  if (tb >= 1) return `${tb.toFixed(1)}T`
  const gb = bytes / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(1)}G`
  return `${(bytes / 1024 ** 2).toFixed(0)}M`
}

function ratio(used: number, limit: number | null): string {
  if (!limit || limit <= 0) return '—'
  return `${((used / limit) * 100).toFixed(1)}%`
}

/** 汇总"按型号的空闲卡数"，只算没被阻断的节点 */
function stockByType(nodes: NodeInfo[]): Map<string, { free: number; total: number; hosts: string[] }> {
  const stock = new Map<string, { free: number; total: number; hosts: string[] }>()
  for (const node of nodes) {
    if (node.blocked) continue
    const free = freeByType(node.gpus, node.gpusUsed)
    for (const item of free) {
      const entry = stock.get(item.type) ?? { free: 0, total: 0, hosts: [] }
      entry.free += item.count
      entry.total += node.gpus.find((g) => g.type === item.type)?.count ?? 0
      if (item.count > 0) entry.hosts.push(`${node.name}:${item.count}`)
      stock.set(item.type, entry)
    }
  }
  return stock
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('用法：npm run inspect -- [--json] [--profile <id>] [--config <path>]')
    return 0
  }

  const configPath = args.config
    ? resolve(process.cwd(), args.config)
    : join(process.cwd(), 'config', 'profiles.json')

  let loaded
  try {
    loaded = loadProfiles(configPath)
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(red(`✗ ${err.message}`))
      for (const issue of err.issues) console.error(`  · ${issue}`)
      return 2
    }
    throw err
  }

  const profile = pickProfile(loaded, args.profile)
  const pool = new ConnectionPool({
    knownHosts: new KnownHostsStore(join(loaded.dir, 'known_hosts.json')),
    onLog: args.json ? undefined : (message) => console.error(dim(`  ${message}`))
  })

  const startedAt = Date.now()
  if (!args.json) {
    console.error('')
    console.error(bold('HPC 工作台 · Adapter 检查'))
    console.error(dim('─'.repeat(58)))
  }

  const session = await pool.acquire(profile)

  const run = async <T>(command: string, parse: (raw: string) => ParseResult<T>): Promise<ParseResult<T> | { ok: false; reason: string; raw: string }> => {
    try {
      const result = await session.exec(command, { timeoutMs: 20_000 })
      if (result.code !== 0 && result.stdout.trim().length === 0) {
        return { ok: false, reason: `命令退出码 ${result.code}`, raw: result.stderr }
      }
      return parse(result.stdout)
    } catch (err) {
      return { ok: false, reason: formatSshError(err, '').trim(), raw: '' }
    }
  }

  const points = await run('scir-account -d', parsePoints)
  const quota = await run(profile.quotaCommand, parseQuota)
  const nodes = await run('scontrol show node --json', parseNodeDetail)
  const jobs = await run('squeue --me --json', parseSqueue)
  const price = await run('scir-watch -s', parseGpuPrice)

  await pool.closeAll()
  const elapsed = Date.now() - startedAt

  const stock = nodes.ok ? stockByType(nodes.data) : new Map()
  const blocked = nodes.ok ? nodes.data.filter((node) => node.blocked) : []

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          ok: [points, quota, nodes, jobs, price].every((result) => result.ok),
          profile: { id: profile.id, host: profile.host, port: profile.port, username: profile.username },
          elapsedMs: elapsed,
          points,
          quota,
          nodes: nodes.ok
            ? {
                ok: true,
                count: nodes.data.length,
                blocked: blocked.map((node) => ({ name: node.name, states: node.states, gpus: totalGpus(node.gpus) })),
                stock: Object.fromEntries([...stock.entries()].map(([type, s]) => [type, s.free]))
              }
            : nodes,
          jobs,
          price
        },
        null,
        2
      )
    )
    return 0
  }

  // —— 点数 ——
  console.log('')
  if (points.ok) {
    const p = points.data
    console.log(`${green('✓')} 点数    ${p.total} 总 / ${p.used} 已用 / ${bold(`${p.avail} 可用`)}`)
  } else {
    console.log(`${red('✗')} 点数    解析失败：${points.reason}`)
  }

  // —— 配额 ——
  if (quota.ok) {
    for (const q of quota.data) {
      console.log(
        `${green('✓')} 配额    ${q.filesystem} ${q.type}` +
          `  容量 ${humanBytes(q.bytes.used)} / ${q.bytes.soft ? humanBytes(q.bytes.soft) : '—'} (${ratio(q.bytes.used, q.bytes.soft)})` +
          `  文件 ${q.files.used} / ${q.files.soft ?? '—'} (${ratio(q.files.used, q.files.soft)})` +
          (q.bytes.grace !== 'none' ? red(`  grace=${q.bytes.grace}`) : '')
      )
    }
  } else {
    console.log(`${red('✗')} 配额    解析失败：${quota.reason}`)
  }

  // —— 节点与库存 ——
  if (nodes.ok) {
    console.log(
      `${green('✓')} 节点    ${nodes.data.length} 台 · 维护/故障 ${blocked.length} 台 · 可接单 ${nodes.data.length - blocked.length} 台`
    )
    if (blocked.length > 0) {
      console.log(dim(`          ${blocked.map((node) => `${node.name}(${node.states.join('+')})`).join(' ')}`))
    }

    const rows = [...stock.entries()].filter(([, s]) => s.free > 0).sort((a, b) => b[1].free - a[1].free)
    for (const [type, s] of rows) {
      const cheapest = price.ok ? price.data.filter((p) => p.type === type).sort((a, b) => a.cost - b.cost)[0] : undefined
      const hours = cheapest && points.ok ? Math.floor(points.data.avail / cheapest.cost) : null
      console.log(
        `          ${type.padEnd(24)} 空闲 ${String(s.free).padStart(2)} / ${String(s.total).padStart(2)}` +
          (cheapest ? dim(`  ${cheapest.cost} 点/时`) : dim('  价未知')) +
          (hours !== null ? dim(`  余额可跑 ${hours}h`) : '')
      )
    }
    const empty = [...stock.entries()].filter(([, s]) => s.free === 0)
    if (empty.length > 0) {
      console.log(dim(`          无空闲：${empty.map(([type]) => type).join('、')}`))
    }
  } else {
    console.log(`${red('✗')} 节点    解析失败：${nodes.reason}`)
  }

  // —— 作业 ——
  if (jobs.ok) {
    const held = jobs.data.filter((job) => job.heldByUser)
    console.log(
      `${green('✓')} 作业    ${jobs.data.length} 个` + (held.length > 0 ? red(`，其中 ${held.length} 个被自己挂起`) : '')
    )
    for (const job of jobs.data.slice(0, 8)) {
      console.log(
        `          ${job.id}  ${job.name.slice(0, 22).padEnd(22)} ${job.state.padEnd(9)} ${job.reasonText}` +
          (job.gpusRequested ? dim(`  ${job.gpusRequested} 卡`) : '')
      )
    }
  } else {
    console.log(`${red('✗')} 作业    解析失败：${jobs.reason}`)
  }

  // —— 单价 ——
  if (price.ok) {
    console.log(`${green('✓')} 单价    ${price.data.length} 行（${new Set(price.data.map((p) => p.type)).size} 种机型）`)
  } else {
    console.log(`${red('✗')} 单价    解析失败：${price.reason}`)
  }

  // —— 失败时把原文摊出来，这是用户自救的唯一途径 ——
  const failed: Array<[string, { reason: string; raw: string }]> = []
  if (!points.ok) failed.push(['点数', points])
  if (!quota.ok) failed.push(['配额', quota])
  if (!nodes.ok) failed.push(['节点', nodes])
  if (!jobs.ok) failed.push(['作业', jobs])
  if (!price.ok) failed.push(['单价', price])

  if (failed.length > 0) {
    console.log('')
    console.log(bold('原始输出（解析失败的项）'))
    for (const [label, result] of failed) {
      console.log(dim(`\n# ${label}`))
      console.log(result.raw.split(/\r?\n/).slice(0, 12).join('\n'))
    }
  }

  console.log('')
  console.log(dim(`耗时 ${(elapsed / 1000).toFixed(1)}s`))
  console.log('')
  return failed.length === 0 ? 0 : 1
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    console.error('')
    console.error(red('检查器自己崩了（不是网络问题）'))
    console.error(err)
    process.exitCode = 1
  })
