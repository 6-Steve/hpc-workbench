/**
 * 单流 SFTP 验证：上传 → 核对大小 → 下载回来 → 比对 sha256。
 *
 *   npm run sftp-check               默认 256 MB 单文件
 *   npm run sftp-check -- --size 64
 *   npm run sftp-check -- --keep     保留两端文件
 *
 * 关注三点：上下行吞吐、往返是否一致、以及和 tar 的数量级差
 * （tar 在 2001 个文件的混合负载上是 23.9 MB/s，见 docs/02 §2.2）。
 */
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ConfigError, loadProfiles, pickProfile } from '../src/main/profiles'
import { formatSshError } from '../src/main/ssh/errors'
import { KnownHostsStore } from '../src/main/ssh/known-hosts'
import { ConnectionPool } from '../src/main/ssh/pool'
import { downloadFile, ensureRemoteDir, uploadFile } from '../src/main/transfer/sftp'
import { formatBytes, formatRate } from '../src/main/transfer/progress'

interface Args {
  sizeMb: number
  profile?: string
  keep: boolean
}

const COLOR = Boolean(process.stdout.isTTY) && !process.env['NO_COLOR']
const paint = (code: string) => (text: string) => (COLOR ? `\x1b[${code}m${text}\x1b[0m` : text)
const dim = paint('2')
const bold = paint('1')
const green = paint('32')
const red = paint('31')

function parseArgs(argv: string[]): Args {
  const args: Args = { sizeMb: 256, keep: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!
    if (token === '--size') args.sizeMb = Number(argv[++i] ?? 256)
    else if (token === '--profile') args.profile = argv[++i]
    else if (token === '--keep') args.keep = true
    else throw new Error(`认不出的参数：${token}`)
  }
  return args
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve())
      .on('error', reject)
  })
  return hash.digest('hex')
}

async function makeFile(path: string, sizeMb: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(path)
    const chunk = randomBytes(1024 * 1024)
    let written = 0
    const pump = (): void => {
      while (written < sizeMb) {
        written += 1
        if (!stream.write(chunk)) {
          stream.once('drain', pump)
          return
        }
      }
      stream.end()
    }
    stream.on('finish', resolve)
    stream.on('error', reject)
    pump()
  })
}

function progressPrinter(label: string): (sample: { bytes: number; bytesPerSecond: number; percent: number | null }) => void {
  let last = 0
  return (sample) => {
    const now = Date.now()
    if (now - last < 800) return
    last = now
    const line = `  ${label} ${formatBytes(sample.bytes)}  ${formatRate(sample.bytesPerSecond)}  ${sample.percent ?? 0}%`
    process.stderr.write(process.stderr.isTTY ? `\r${line.padEnd(52)}` : `${line}\n`)
  }
}

function clearLine(): void {
  if (process.stderr.isTTY) process.stderr.write('\r' + ' '.repeat(52) + '\r')
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  let loaded
  try {
    loaded = loadProfiles(join(process.cwd(), 'config', 'profiles.json'))
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
  console.log(bold('HPC 工作台 · 单流 SFTP 验证'))
  console.log(dim('─'.repeat(58)))

  const localDir = await mkdtemp(join(tmpdir(), 'hpc-sftpcheck-'))
  const localPath = join(localDir, 'payload.bin')
  const backPath = join(localDir, 'payload-back.bin')

  process.stderr.write(dim(`  生成 ${args.sizeMb} MB 测试文件…`))
  await makeFile(localPath, args.sizeMb)
  const info = await stat(localPath)
  process.stderr.write(dim(' 完成\n'))
  console.log(`${dim('本地文件')}  ${formatBytes(info.size)}`)

  const pool = new ConnectionPool({
    knownHosts: new KnownHostsStore(join(loaded.dir, 'known_hosts.json')),
    onLog: (message) => console.error(dim(`  ${message}`))
  })

  let remoteDir: string | undefined
  let session: Awaited<ReturnType<ConnectionPool['acquire']>> | undefined
  let exitCode = 0

  try {
    session = await pool.acquire(profile)
    const home = await session.exec('printf %s "$HOME"')
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    remoteDir = `${home.stdout.trim()}/.hpc-workbench-sftpcheck-${stamp}`
    await ensureRemoteDir(session, remoteDir)

    const remotePath = `${remoteDir}/payload.bin`
    console.log(`${dim('远端目录')}  ${remoteDir}`)
    console.log('')

    const up = await uploadFile(session, localPath, remotePath, { onProgress: progressPrinter('↑') })
    clearLine()
    console.log(`${green('✓')} 上传     ${(up.durationMs / 1000).toFixed(1)}s  ${formatRate(up.bytesPerSecond)}`)

    const sizeCheck = await session.exec(`stat -c %s ${remotePath}`)
    const remoteSize = Number.parseInt(sizeCheck.stdout.trim(), 10)
    const sizeOk = remoteSize === info.size
    console.log(
      `${sizeOk ? green('✓') : red('✗')} 远端大小 ${remoteSize} 字节` + (sizeOk ? '' : `（本地 ${info.size}）`)
    )
    if (!sizeOk) exitCode = 1

    const down = await downloadFile(session, remotePath, backPath, { onProgress: progressPrinter('↓') })
    clearLine()
    console.log(`${green('✓')} 下载     ${(down.durationMs / 1000).toFixed(1)}s  ${formatRate(down.bytesPerSecond)}`)

    const [hashLocal, hashBack] = await Promise.all([sha256(localPath), sha256(backPath)])
    const sameHash = hashLocal === hashBack
    console.log(`${sameHash ? green('✓') : red('✗')} 内容一致 ${sameHash ? 'sha256 相同' : 'sha256 不同！'}`)
    if (!sameHash) exitCode = 1

    console.log('')
    console.log(dim(`参考：tar 混合负载 23.9 MB/s、单流上限约 42 MB/s（docs/02 §2.2）`))

    if (args.keep) {
      console.log(dim(`\n已保留远端：${remoteDir}`))
    } else {
      await session.exec(`rm -rf ${remoteDir}`)
      console.log(dim('\n已清理远端目录'))
    }
  } catch (err) {
    console.error('')
    console.error(red('✗ 传输失败'))
    console.error(formatSshError(err))
    exitCode = 1
    if (remoteDir && session) {
      try {
        await session.exec(`rm -rf ${remoteDir}`)
      } catch {
        /* 清理失败不影响结论 */
      }
    }
  } finally {
    await pool.closeAll()
    if (!args.keep) await rm(localDir, { recursive: true, force: true }).catch(() => {})
    else console.log(dim(`本地文件保留在：${localDir}`))
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
