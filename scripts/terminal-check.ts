/**
 * 交互式终端自检（命令行版）。
 *
 *   npm run terminal-check
 *
 * 验三件本机测不出的事：
 * 1. 服务端允不允许开 PTY（`MaxSessions` 用完时会直接拒绝）
 * 2. 中文输出会不会被 chunk 边界劈成乱码
 * 3. `setWindow` 之后远端真的看到新的列数（`tput cols`）——resize 写反顺序就是在这露馅
 */
import { join } from 'node:path'
import { loadProfiles, pickProfile, ConfigError } from '../src/main/profiles'
import { ConnectionPool } from '../src/main/ssh/pool'
import { KnownHostsStore } from '../src/main/ssh/known-hosts'
import { formatSshError, SshError } from '../src/main/ssh/errors'

const COLOR = Boolean(process.stdout.isTTY) && !process.env['NO_COLOR']
const paint = (code: string) => (text: string) => (COLOR ? `\x1b[${code}m${text}\x1b[0m` : text)
const dim = paint('2')
const bold = paint('1')
const green = paint('32')
const red = paint('31')

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function main(): Promise<void> {
  const loaded = loadProfiles(process.env['HPC_CONFIG'] ?? undefined)
  const profile = pickProfile(loaded)

  console.log('')
  console.log(bold('HPC 工作台 · 交互式终端自检'))
  console.log(dim('─'.repeat(58)))
  console.log('')

  const pool = new ConnectionPool({
    knownHosts: new KnownHostsStore(join(loaded.dir, 'known_hosts.json'))
  })

  let output = ''

  try {
    await pool.run(profile, async (session) => {
      console.log(bold('[1/3] 开 PTY'))
      const handle = await session.openShell(
        { cols: 100, rows: 30 },
        {
          onData: (text) => {
            output += text
          },
          onClose: ({ code }) => console.log(dim(`      会话已结束（退出码 ${code ?? 'null'}）`))
        }
      )
      console.log(`      ${green('已开')}${dim('（100x30）')}`)

      console.log('')
      console.log(bold('[2/3] 跑几条命令，看回显和中文'))
      // 关掉提示符干扰，一次跑完
      handle.write('PS1=""; echo "SHELL=$SHELL"; echo "中文测试：你好，世界"; echo "COLS=$(tput cols)"\n')
      await sleep(1800)

      console.log(bold('[3/3] resize 到 132 列，看远端是否真的变了'))
      handle.resize({ cols: 132, rows: 40 })
      await sleep(300)
      handle.write('echo "COLS_AFTER=$(tput cols)"\n')
      await sleep(1200)

      handle.write('exit\n')
      await sleep(600)
      handle.close()
    })
  } finally {
    await pool.closeAll()
  }

  // 把控制序列去掉再判断，终端里的框线字符不影响这几个断言
  const plain = output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')

  console.log('')
  console.log(bold('结果'))
  const checks: Array<{ label: string; pass: boolean; detail: string }> = [
    {
      label: 'PTY 起来了（能拿到 SHELL 变量）',
      pass: /SHELL=\//.test(plain),
      detail: /(SHELL=\/\S*)/.exec(plain)?.[1] ?? '没抓到'
    },
    {
      label: '中文没有乱码',
      pass: plain.includes('你好，世界'),
      detail: plain.includes('你好，世界') ? '正确显示「你好，世界」' : '没找到「你好，世界」'
    },
    {
      label: '初始列数是 100',
      pass: /COLS=100/.test(plain),
      detail: /(COLS=\d+)/.exec(plain)?.[1] ?? '没抓到'
    },
    {
      label: 'resize 后列数变成 132',
      pass: /COLS_AFTER=132/.test(plain),
      detail: /(COLS_AFTER=\d+)/.exec(plain)?.[1] ?? '没抓到'
    }
  ]

  for (const check of checks) {
    console.log(`  ${check.pass ? green('✓') : red('✗')} ${check.label}　${dim(check.detail)}`)
  }

  const failed = checks.filter((check) => !check.pass)
  console.log('')
  if (failed.length > 0) {
    console.log(red(`有 ${failed.length} 项没过。原始输出（去掉控制序列）：`))
    console.log(dim(plain.slice(0, 1500)))
    process.exitCode = 1
  } else {
    console.log(green('全部通过'))
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
