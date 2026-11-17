/**
 * tar 流式传输验证（Phase 0 第 6 项）。
 *
 *   npm run tar-check                  生成 1 GB 本地目录 → 传到集群 → 核对 → 清理
 *   npm run tar-check -- --size 256    小一点先试
 *   npm run tar-check -- --keep        保留远端的目录（默认传完就删）
 *   npm run tar-check -- --keep-local  保留本地测试数据
 *
 * 关注三个数：吞吐（MB/s）、总耗时、以及**核对是否一致**。
 * 只要核对不一致，就说明有静默丢数据，必须查。
 */
import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ConfigError, loadProfiles, pickProfile } from '../src/main/profiles'
import { formatSshError } from '../src/main/ssh/errors'
import { KnownHostsStore } from '../src/main/ssh/known-hosts'
import { ConnectionPool } from '../src/main/ssh/pool'
import { removeRemotePath, uploadDirectory } from '../src/main/transfer/tar'
import { formatBytes, formatRate } from '../src/main/transfer/progress'

interface Args {
  sizeMb: number
  smallCount: number
  profile?: string
  keepRemote: boolean
  keepLocal: boolean
  remote?: string
}

const COLOR = Boolean(process.stdout.isTTY) && !process.env['NO_COLOR']
const paint = (code: string) => (text: string) => (COLOR ? `\x1b[${code}m${text}\x1b[0m` : text)
const dim = paint('2')
const bold = paint('1')
const green = paint('32')
const red = paint('31')

function parseArgs(argv: string[]): Args {
  const args: Args = { sizeMb: 1024, smallCount: 2000, keepRemote: false, keepLocal: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!
    switch (token) {
      case '--size':
        args.sizeMb = Number(argv[++i] ?? 1024)
        break
      case '--small':
        args.smallCount = Number(argv[++i] ?? 2000)
        break
      case '--profile':
        args.profile = argv[++i]
        break
      case '--remote':
        args.remote = argv[++i]
        break
      case '--keep':
        args.keepRemote = true
        break
      case '--keep-local':
        args.keepLocal = true
        break
      default:
        throw new Error(`认不出的参数：${token}`)
    }
  }
  return args
}

/** 生成测试目录：一个大文件撑吞吐，一堆小文件测每文件开销 */
async function generateLocal(dir: string, args: Args): Promise<{ bigMb: number; smallKb: number }> {
  await mkdir(join(dir, 'small'), { recursive: true })
  await mkdir(join(dir, 'big'), { recursive: true })

  const smallKb = 64
  const smallTotalMb = (args.smallCount * smallKb) / 1024
  const bigMb = Math.max(1, Math.round(args.sizeMb - smallTotalMb))

  const block = randomBytes(64 * 1024)

  process.stderr.write(dim(`  生成 ${args.smallCount} 个小文件（每个 ${smallKb} KB）…`))
  for (let i = 0; i < args.smallCount; i += 1) {
    await writeFile(join(dir, 'small', `chunk-${String(i).padStart(5, '0')}.bin`), block)
  }
  process.stderr.write(dim(' 完成\n'))

  process.stderr.write(dim(`  生成 1 个大文件（${bigMb} MB）…`))
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createWriteStream(join(dir, 'big', 'dataset.bin'))
    const chunk = randomBytes(1024 * 1024)
    let written = 0
    const pump = (): void => {
      while (written < bigMb) {
        written += 1
        if (!stream.write(chunk)) {
          stream.once('drain', pump)
          return
        }
      }
      stream.end()
    }
    stream.on('finish', resolvePromise)
    stream.on('error', reject)
    pump()
  })
  process.stderr.write(dim(' 完成\n'))

  return { bigMb, smallKb }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const configPath = join(process.cwd(), 'config', 'profiles.json')

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
  console.log('')
  console.log(bold('HPC 工作台 · tar 流式传输验证'))
  console.log(dim('─'.repeat(58)))

  // 本地测试数据放在系统临时目录，不污染仓库
  const localDir = await mkdtemp(join(tmpdir(), 'hpc-tarcheck-'))
  console.log(`${dim('本地目录')}  ${localDir}`)
  const { bigMb, smallKb } = await generateLocal(localDir, args)
  console.log(`${dim('数据构成')}  1 × ${bigMb} MB + ${args.smallCount} × ${smallKb} KB`)

  const pool = new ConnectionPool({
    knownHosts: new KnownHostsStore(join(loaded.dir, 'known_hosts.json')),
    onLog: (message) => console.error(dim(`  ${message}`))
  })

  let remoteDir = args.remote
  let exitCode = 0

  try {
    const session = await pool.acquire(profile)

    if (!remoteDir) {
      const home = await session.exec('printf %s "$HOME"')
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
      remoteDir = `${home.stdout.trim()}/.hpc-workbench-tarcheck-${stamp}`
    }

    console.log(`${dim('远端目录')}  ${remoteDir}`)
    console.log('')
    console.log(dim('开始上传…'))

    let lastPrint = 0
    const started = Date.now()

    const result = await uploadDirectory(session, {
      localDir,
      remoteDir,
      onProgress: (sample) => {
        const now = Date.now()
        if (now - lastPrint < 1000) return
        lastPrint = now
        const line = `  ${formatBytes(sample.bytes)}  ${formatRate(sample.bytesPerSecond)}  ${sample.percent ?? 0}%`
        process.stderr.write(process.stderr.isTTY ? `\r${line.padEnd(48)}` : `${line}\n`)
      }
    })

    if (process.stderr.isTTY) process.stderr.write('\r' + ' '.repeat(48) + '\r')

    const wall = Date.now() - started
    console.log('')
    console.log(bold('结果'))
    console.log(`  文件数      ${result.files}（另有 ${result.dirs} 个目录，跳过 ${result.skippedLinks} 个符号链接）`)
    console.log(`  本地字节    ${formatBytes(result.bytes)}`)
    console.log(`  远端 du     ${result.remoteBytes === null ? '—' : formatBytes(result.remoteBytes)}`)
    console.log(`  远端文件数  ${result.remoteFiles ?? '—'}`)
    console.log(`  上传耗时    ${(result.durationMs / 1000).toFixed(1)}s（含建连 ${(wall / 1000).toFixed(1)}s）`)
    console.log(`  吞吐        ${formatRate(result.bytesPerSecond)}`)
    console.log(
      `  核对        ${result.verified ? green('✓ 一致') : red('✗ 不一致（可能有静默丢数据）')}`
    )

    if (!result.verified) exitCode = 1

    if (args.keepRemote) {
      console.log('')
      console.log(dim(`已保留远端目录：${remoteDir}`))
    } else {
      await removeRemotePath(session, remoteDir)
      console.log(dim(`\n已清理远端目录`))
    }
  } catch (err) {
    console.error('')
    console.error(red('✗ 传输失败'))
    console.error(formatSshError(err))
    exitCode = 1
  } finally {
    await pool.closeAll()
    if (!args.keepLocal) {
      await rm(localDir, { recursive: true, force: true }).catch(() => {})
    } else {
      console.log(dim(`本地测试数据保留在：${localDir}`))
    }
  }

  console.log('')
  return exitCode
}


main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    console.error('')
    console.error(red('检查脚本自己崩了'))
    console.error(err)
    process.exitCode = 1
  })
