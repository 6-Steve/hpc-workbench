/**
 * 连接探针（命令行版）。
 *
 * 用途：Phase 0 的验收形态——不开界面，直接在控制台验证
 * 「配置 → 握手 → 认证 → 执行命令 → 解析」整条链路是否通。
 *
 *   npm run probe                          探测能力并打印报告
 *   npm run probe -- --json                纯 JSON 输出（给脚本/后续阶段用）
 *   npm run probe -- --cmd "sinfo -V"      在远端跑任意一条命令
 *   npm run probe -- --profile gpu01       指定 profile
 *   npm run probe -- --trust               首次连接时自动信任主机指纹
 *
 * 界面里的"运行"按钮走的是同一套 pool + capabilities，两边结果应当一致。
 */
import { join, resolve } from 'node:path'
import { loadProfiles, pickProfile, ConfigError } from '../src/main/profiles'
import { ConnectionPool } from '../src/main/ssh/pool'
import { KnownHostsStore } from '../src/main/ssh/known-hosts'
import { capabilityCacheKey, probeCapabilities } from '../src/main/ssh/capabilities'
import { SshError, formatSshError } from '../src/main/ssh/errors'
import { FileKVStore } from '../src/main/store/file-kv'

interface Args {
  json: boolean
  help: boolean
  trust: boolean
  profile?: string
  cmd?: string
  config?: string
  timeoutMs?: number
}

const COLOR = Boolean(process.stdout.isTTY) && !process.env['NO_COLOR']
const paint = (code: string) => (text: string) => (COLOR ? `\x1b[${code}m${text}\x1b[0m` : text)
const dim = paint('2')
const bold = paint('1')
const green = paint('32')
const red = paint('31')
const yellow = paint('33')
const cyan = paint('36')

function parseArgs(argv: string[]): Args {
  const args: Args = { json: false, help: false, trust: false }

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!
    const next = (): string => {
      const value = argv[i + 1]
      if (value === undefined) throw new Error(`参数 ${token} 后面需要一个值`)
      i += 1
      return value
    }

    switch (token) {
      case '--json':
        args.json = true
        break
      case '--trust':
        args.trust = true
        break
      case '--help':
      case '-h':
        args.help = true
        break
      case '--profile':
        args.profile = next()
        break
      case '--cmd':
        args.cmd = next()
        break
      case '--config':
        args.config = next()
        break
      case '--timeout':
        args.timeoutMs = Number(next())
        break
      default:
        throw new Error(`认不出的参数：${token}`)
    }
  }

  return args
}

function usage(): string {
  return [
    bold('HPC 工作台 · 连接探针'),
    '',
    '用法：npm run probe -- [选项]',
    '',
    '  --json              输出纯 JSON（默认是给人看的报告）',
    '  --profile <id>      指定 profile，默认取 defaultProfile',
    '  --config <path>     指定配置文件，默认 config/profiles.json',
    '  --cmd <command>     只执行一条远端命令并打印结果',
    '  --trust             首次连接时自动信任主机指纹',
    '  --timeout <ms>      --cmd 的超时时间，默认 30000',
    '  -h, --help          显示这段说明'
  ].join('\n')
}

function printConfigError(err: ConfigError): void {
  console.error('')
  console.error(red('✗ 配置文件有问题'))
  console.error(`  ${err.message}`)
  console.error(dim(`  路径：${err.path}`))
  if (err.issues.length > 0) {
    console.error('')
    for (const issue of err.issues) console.error(`  · ${issue}`)
  }
  console.error('')
  console.error(dim('  最小可用示例见仓库根目录的 profiles.example.json'))
  console.error('')
}

async function main(): Promise<number> {
  let args: Args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(red((err as Error).message))
    console.error('')
    console.error(usage())
    return 2
  }

  if (args.help) {
    console.error(usage())
    return 0
  }

  const configPath = args.config
    ? resolve(process.cwd(), args.config)
    : join(process.cwd(), 'config', 'profiles.json')
  const quiet = args.json

  let loaded
  try {
    loaded = loadProfiles(configPath)
  } catch (err) {
    if (err instanceof ConfigError) {
      if (args.json) console.log(JSON.stringify({ ok: false, kind: 'config', error: err.message, issues: err.issues }, null, 2))
      else printConfigError(err)
      return 2
    }
    throw err
  }

  let profile
  try {
    profile = pickProfile(loaded, args.profile)
  } catch (err) {
    if (err instanceof ConfigError) {
      if (args.json) console.log(JSON.stringify({ ok: false, kind: 'config', error: err.message, issues: err.issues }, null, 2))
      else printConfigError(err)
      return 2
    }
    throw err
  }

  if (args.trust) profile = { ...profile, trustNewHostKey: true }

  const knownHosts = new KnownHostsStore(join(loaded.dir, 'known_hosts.json'))
  const pool = new ConnectionPool({
    knownHosts,
    onLog: quiet ? undefined : (message) => console.error(dim(`      ${message}`))
  })

  if (!quiet) {
    console.error('')
    console.error(bold('HPC 工作台 · 连接探针'))
    console.error(dim('─'.repeat(58)))
    console.error(`${dim('配置')}     ${configPath}`)
    console.error(`${dim('profile')}  ${profile.id}${profile.label !== profile.id ? `（${profile.label}）` : ''}`)
    console.error('')
    console.error(`${cyan('[1/2]')} 建立连接`)
  }

  const connectStartedAt = Date.now()
  let session
  try {
    session = await pool.acquire(profile)
  } catch (err) {
    const normalized = err instanceof SshError ? err : null
    if (quiet) {
      console.log(JSON.stringify({ ok: false, kind: normalized?.kind ?? 'unknown', error: formatSshError(err, '') }, null, 2))
    } else {
      console.error(red('      ✗ 连接失败'))
      console.error(formatSshError(err))
      console.error('')
    }
    await pool.closeAll()
    return 1
  }

  const connectMs = Date.now() - connectStartedAt

  if (!quiet) {
    console.error(green(`      ✓ 已连上 ${profile.username}@${profile.host}:${profile.port}`) + dim(`  ${connectMs} ms`))
    if (session.hostKey) {
      console.error(dim(`      host key  ${session.hostKey.algorithm} ${session.hostKey.fingerprint}`))
    }
  }

  // —— 单条命令模式 ——
  if (args.cmd) {
    try {
      const result = await session.exec(args.cmd, { timeoutMs: args.timeoutMs ?? 30_000 })
      if (quiet) {
        console.log(JSON.stringify({ ok: result.code === 0, connectMs, ...result }, null, 2))
      } else {
        console.error('')
        console.error(`${cyan('[2/2]')} 执行命令`)
        console.error(dim(`      $ ${args.cmd}`))
        console.error('')
        if (result.stdout.trim()) console.log(result.stdout.replace(/\s+$/, ''))
        if (result.stderr.trim()) console.error(yellow(result.stderr.replace(/\s+$/, '')))
        console.error('')
        console.error(
          `${result.code === 0 ? green('✓') : red('✗')} 退出码 ${result.code ?? 'null'} · ${result.durationMs} ms` +
            (result.truncated ? yellow(' · 输出已截断') : '')
        )
        console.error('')
      }
      await pool.closeAll()
      return result.code === 0 ? 0 : 1
    } catch (err) {
      if (quiet) console.log(JSON.stringify({ ok: false, error: formatSshError(err, '') }, null, 2))
      else {
        console.error(red('      ✗ 命令执行失败'))
        console.error(formatSshError(err))
      }
      await pool.closeAll()
      return 1
    }
  }

  // —— 能力探测 ——
  if (!quiet) {
    console.error('')
    console.error(`${cyan('[2/2]')} 能力探测`)
  }

  let capabilities
  try {
    capabilities = await probeCapabilities(session, profile)
  } catch (err) {
    if (quiet) console.log(JSON.stringify({ ok: false, error: formatSshError(err, '') }, null, 2))
    else {
      console.error(red('      ✗ 探测失败'))
      console.error(formatSshError(err))
    }
    await pool.closeAll()
    return 1
  }

  // 缓存和界面共用同一个文件，便于两边对照
  const cache = new FileKVStore(join(loaded.dir, '.cache', 'capabilities.json'))
  cache.set(capabilityCacheKey(profile.id), { capabilities, savedAt: new Date().toISOString() })

  await pool.closeAll()

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          connectMs,
          profile: {
            id: profile.id,
            label: profile.label,
            host: profile.host,
            port: profile.port,
            username: profile.username
          },
          hostKey: session.hostKey ?? null,
          capabilities
        },
        null,
        2
      )
    )
    return 0
  }

  const mark = (ok: boolean): string => (ok ? green('✓ 支持') : dim('✗ 不支持'))

  console.error('')
  console.error(bold('  环境'))
  console.error(`    SLURM      ${capabilities.slurmVersionNumber ?? '—'}  ${dim(capabilities.slurmVersion ?? '')}`)
  console.error(`    系统       ${capabilities.os ?? '—'}`)
  console.error(`    HOME       ${capabilities.home ?? '—'}`)
  console.error(`    sbatch     ${capabilities.sbatchAvailable ? '可用' : red('未找到')}`)
  console.error(`    配额工具   ${capabilities.quotaToolFound ? '可用' : yellow('未找到')}  ${dim(profile.quotaCommand)}`)

  console.error('')
  console.error(bold('  JSON 能力'))
  console.error(`    sinfo      ${mark(capabilities.sinfoJson)}`)
  console.error(`    squeue     ${mark(capabilities.squeueJson)}`)
  console.error(`    sacct      ${mark(capabilities.sacctJson)}`)
  console.error(`    scontrol   ${mark(capabilities.scontrolJson)}`)

  console.error('')
  console.error(bold('  结论'))
  for (const note of capabilities.notes) console.error(`    · ${note}`)

  console.error('')
  console.error(dim(`  已缓存到 ${join(loaded.dir, '.cache', 'capabilities.json')}`))
  console.error(dim(`  总耗时 ${((Date.now() - connectStartedAt) / 1000).toFixed(1)}s`))
  console.error('')
  console.error(green('  链路打通。下一步：实现 points.ts（最简）→ sinfo.ts（最复杂）→ squeue.ts（走 JSON）'))
  console.error('')

  return 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    console.error('')
    console.error(red('探针自己崩了（这不是网络问题）'))
    console.error(err)
    console.error('')
    process.exitCode = 1
  })
