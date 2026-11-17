/**
 * 点数模块探针：验证 `scir-account` 的三个子能力在本应用通道里的真实行为。
 *
 *   npm run points-check                    只跑只读项（余额 + 消耗记录）
 *   npm run points-check -- --transfer 0    额外跑一次转账（**0 点**，不扣钱）
 *
 * 为什么单独写这个脚本而不是直接进界面：
 * 1. `transfer` 要 LDAP 密码，本应用的 exec 通道拿不到，只能走 PTY。
 *    密码能不能喂进去**必须实测**，否则界面做出来也是个永远 AuthFailed 的按钮。
 * 2. 消耗记录是 Unicode 表格，解析器写错不会报错、只会安静地少数几行。
 *
 * ⚠️ 转账测试即使 `--points 0` 也会真的调用平台接口。不传 `--transfer` 就不会碰。
 */
import { join } from 'node:path'
import { loadProfiles, pickProfile } from '../src/main/profiles'
import { ConnectionPool } from '../src/main/ssh/pool'
import { KnownHostsStore } from '../src/main/ssh/known-hosts'
import { formatSshError } from '../src/main/ssh/errors'
import { parsePoints } from '../src/main/adapters/points'
import { parseUsageTable } from '../src/main/adapters/points-usage'

interface Args {
  transfer: number | null
  target: string | null
  month: number
  profile?: string
}

function parseArgs(argv: string[]): Args {
  const args: Args = { transfer: null, target: null, month: 1 }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!
    const next = (): string => {
      const value = argv[i + 1]
      if (value === undefined) throw new Error(`参数 ${token} 后面需要一个值`)
      i += 1
      return value
    }
    switch (token) {
      case '--transfer':
        args.transfer = Number(next())
        break
      case '--target':
        args.target = next()
        break
      case '--month':
        args.month = Number(next())
        break
      case '--profile':
        args.profile = next()
        break
      default:
        throw new Error(`认不出的参数：${token}`)
    }
  }
  return args
}

/**
 * 用一条 PTY 跑完一个交互式命令。
 *
 * 单纯 `exec` 不行：`transfer` 从 **stdin** 读密码，而 exec 的 stdin 是空的、
 * 且没有 tty，二进制看到不是终端就直接按"没给密码"处理。
 *
 * 关键点：
 * - 必须**等提示串出现**再写密码。先写的话，密码会先于 read 被丢掉，
 *   而且会原样回显到输出里（tty 没来得及关 echo）。
 * - 密码后面必须带 `\n`，否则 read 一直等下去。
 * - 写完密码立刻关闭输入：`scir-account` 不会再读第二个东西，
 *   不关的话某些实现会把 PTY 当成还有输入。
 */
async function runOnPty(
  session: Awaited<ReturnType<ConnectionPool['acquire']>>,
  command: string,
  password: string | null,
  timeoutMs = 20_000
): Promise<{ output: string; code: number | null; wrote: boolean }> {
  return new Promise((resolvePromise) => {
    let output = ''
    let wrote = false
    let done = false
    let handle: { write: (data: string) => void; close: () => void } | null = null

    const finish = (code: number | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolvePromise({ output, code, wrote })
    }

    const timer = setTimeout(() => {
      handle?.close()
      finish(null)
    }, timeoutMs)

    void session
      .openShell({ cols: 120, rows: 40 }, {
        onData: (text) => {
          output += text
          if (password !== null && !wrote && /Password:/i.test(output)) {
            wrote = true
            // 给 tty 一点时间关掉 echo 再写，否则密码会明晃晃出现在输出里
            setTimeout(() => {
              try {
                handle?.write(`${password}\n`)
              } catch {
                /* 通道可能已关 */
              }
            }, 120)
          }
        },
        onClose: ({ code }) => finish(code)
      })
      .then((created) => {
        handle = created
        // 提示串可能已经出现（极快的机器），补一次
        if (password !== null && !wrote && /Password:/i.test(output)) return
        created.write(`${command}\n`)
        setTimeout(() => {
          if (!done) created.write('exit\n')
        }, timeoutMs - 2000)
      })
      .catch(() => finish(null))
  })
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const configPath = join(process.cwd(), 'config', 'profiles.json')
  const loaded = loadProfiles(configPath)
  const profile = pickProfile(loaded, args.profile)

  const pool = new ConnectionPool({
    knownHosts: new KnownHostsStore(join(loaded.dir, 'known_hosts.json'))
  })

  const session = await pool.acquire(profile)
  console.log(`已连上 ${profile.username}@${profile.host}`)
  console.log('')

  try {
    // —— 1. 余额 ——
    const balance = await session.exec('scir-account -d')
    const parsed = parsePoints(balance.stdout)
    console.log('[1] scir-account -d')
    console.log(`    原始：${JSON.stringify(balance.stdout.trim())}`)
    console.log(`    解析：${parsed.ok ? JSON.stringify(parsed.data) : `✗ ${parsed.reason}`}`)
    console.log('')

    // —— 2. 消耗记录 ——
    for (const extra of ['', ' -r']) {
      const command = `scir-account details${extra}`
      const result = await session.exec(command)
      const usage = parseUsageTable(result.stdout)
      console.log(`[2] ${command}`)
      console.log(`    退出码 ${result.code} · ${result.stdout.split('\n').length} 行 · ${result.durationMs} ms`)
      if (!usage.ok) {
        console.log(`    ✗ ${usage.reason}`)
        console.log(`    raw 前 400 字：\n${result.stdout.slice(0, 400)}`)
      } else {
        const { rows, totals } = usage.data
        console.log(`    解析出 ${rows.length} 条`)
        for (const row of rows.slice(0, 3)) console.log(`      ${JSON.stringify(row)}`)
        if (rows.length > 3) console.log(`      …共 ${rows.length} 条`)
        console.log(`    表尾汇总：${JSON.stringify(totals)}`)
        const sum = rows.reduce((acc, row) => acc + row.points, 0)
        console.log(`    逐条相加 ${sum.toFixed(2)} vs Used ${totals?.used ?? '—'}`)
      }
      console.log('')
    }

    // —— 3. 转账（可选，默认不跑）——
    if (args.transfer !== null) {
      const target = args.target ?? profile.username
      const command = `scir-account transfer -p ${args.transfer} -t ${target} -m ${args.month}`
      console.log(`[3] ${command}`)
      console.log('    需要密码，走 PTY。设 SCIR_PASSWORD 才真正发送密码。')
      const password = process.env['SCIR_PASSWORD'] || null
      if (password) {
        const result = await runOnPty(session, command, password)
        // 输出里可能残留密码回显，打码
        console.log(`    输出：\n${result.output.split(password).join('********')}`)
        console.log(`    退出码 ${result.code} · 写入过密码 ${result.wrote}`)
      } else {
        // 没有密码时只验证"能不能检测到提示串"，不发密码
        const result = await runOnPty(session, command, null, 8000)
        console.log(`    输出：\n${result.output}`)
        console.log(`    是否检测到 Password 提示：${/Password:/i.test(result.output)}`)
        console.log(`    （没设 SCIR_PASSWORD，所以没真的发密码）`)
      }
      console.log('')
    } else {
      console.log('[3] 转账验证已跳过（加 --transfer 0 才跑）')
      console.log('')
    }
  } finally {
    await pool.closeAll()
  }

  return 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    console.error('探针失败：')
    console.error(formatSshError(err, ''))
    process.exitCode = 1
  })
