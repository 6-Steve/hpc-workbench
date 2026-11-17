/**
 * tar 流式**下载**验证。
 *
 *   npm run tar-down-check                 用集群上已有的目录下载（默认找 home 下的测试目录）
 *   npm run tar-down-check -- --size 256   先造一个 256 MB 的远端目录再下（需要能写 home）
 *   npm run tar-down-check -- --remote /path/to/dir
 *   npm run tar-down-check -- --keep-local 保留本地下载结果
 *
 * 关心三件事：吞吐（MB/s）、耗时、以及**下载下来的文件数和字节数是否和远端一致**。
 * 不一致说明解包环节有丢数据，必须查。
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { ConfigError, loadProfiles, pickProfile } from '../src/main/profiles'
import { formatSshError } from '../src/main/ssh/errors'
import { KnownHostsStore } from '../src/main/ssh/known-hosts'
import { ConnectionPool } from '../src/main/ssh/pool'
import { shq } from '../src/main/ssh/shell'
import { downloadDirectory } from '../src/main/transfer/tar-download'
import { formatBytes, formatRate } from '../src/main/transfer/progress'

interface Args {
  remote?: string
  profile?: string
  keepLocal: boolean
  keepRemoteArtifact: boolean
}

const COLOR = Boolean(process.stdout.isTTY) && !process.env['NO_COLOR']
const paint = (code: string) => (text: string) => (COLOR ? `\x1b[${code}m${text}\x1b[0m` : text)
const dim = paint('2')
const bold = paint('1')
const green = paint('32')
const red = paint('31')

function parseArgs(argv: string[]): Args {
  const args: Args = { keepLocal: false, keepRemoteArtifact: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!
    switch (token) {
      case '--remote':
        args.remote = argv[++i]
        break
      case '--profile':
        args.profile = argv[++i]
        break
      case '--keep-local':
        args.keepLocal = true
        break
      case '--keep-remote':
        args.keepRemoteArtifact = true
        break
      default:
        throw new Error(`认不出的参数：${token}`)
    }
  }
  return args
}

/** 递归统计本地目录：文件数与字节数 */
async function localTotals(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0

  const visit = async (current: string): Promise<void> => {
    for (const item of await readdir(current, { withFileTypes: true })) {
      const abs = join(current, item.name)
      if (item.isDirectory()) {
        await visit(abs)
        continue
      }
      if (item.isFile()) {
        files += 1
        bytes += (await stat(abs)).size
      }
    }
  }

  await visit(dir)
  return { files, bytes }
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
  console.log(bold('HPC 工作台 · tar 流式下载验证'))
  console.log(dim('─'.repeat(58)))

  const pool = new ConnectionPool({
    knownHosts: new KnownHostsStore(join(loaded.dir, 'known_hosts.json')),
    onLog: (message) => console.error(dim(`  ${message}`))
  })

  const localRoot = await mkdtemp(join(tmpdir(), 'hpc-tardown-'))
  let createdRemoteDir: string | null = null
  let exitCode = 0

  try {
    const session = await pool.acquire(profile)

    let remoteDir = args.remote
    if (!remoteDir) {
      // 没有指定就自己造一个：一个 512 MB 大文件 + 200 个小文件，
      // 这样吞吐和"每文件固定开销"两件事能同时看出来
      const home = await session.exec('printf %s "$HOME"')
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
      remoteDir = `${home.stdout.trim()}/.hpc-workbench-tardown-${stamp}`
      createdRemoteDir = remoteDir

      console.log(`${dim('远端目录')}  ${remoteDir}（本次生成）`)
      const seed = await session.exec(
        [
          `mkdir -p ${shq(`${remoteDir}/small`)} ${shq(`${remoteDir}/big`)}`,
          `head -c 536870912 /dev/urandom > ${shq(`${remoteDir}/big/dataset.bin`)}`,
          `for i in $(seq 1 200); do head -c 65536 /dev/urandom > ${shq(`${remoteDir}/small`)}/chunk-$i.bin; done`
        ].join(' && '),
        { timeoutMs: 300_000 }
      )
      if (seed.code !== 0) {
        console.error(red(`✗ 生成远端测试数据失败：${seed.stderr.trim()}`))
        return 1
      }
    } else {
      console.log(`${dim('远端目录')}  ${remoteDir}`)
    }

    const dest = join(localRoot, posix.basename(remoteDir.replace(/\/+$/, '')))
    console.log(`${dim('下载到')}    ${dest}`)
    console.log('')
    console.log(dim('开始下载…'))

    let lastPrint = 0
    const started = Date.now()

    const result = await downloadDirectory(session, {
      remoteDir,
      localDir: dest,
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
    const local = await localTotals(dest)

    // 和远端对账：文件数必须严格相等，字节数用 du 的口径比（du 会把目录项算进去）
    const remote = await session.exec(`find ${shq(remoteDir)} -type f | wc -l && du -sb ${shq(remoteDir)} | cut -f1`)
    const [remoteFilesRaw = '', remoteBytesRaw = ''] = remote.stdout.trim().split('\n')
    const remoteFiles = Number.parseInt(remoteFilesRaw.trim(), 10)
    const remoteBytes = Number.parseInt(remoteBytesRaw.trim(), 10)

    console.log('')
    console.log(bold('结果'))
    console.log(`  文件数      ${result.files}（另有 ${result.dirs} 个目录，跳过 ${result.skippedLinks} 个符号链接）`)
    console.log(`  落盘字节    ${formatBytes(local.bytes)}`)
    console.log(`  传输字节    ${formatBytes(result.bytes)}${dim('（tar 流，含头部开销）')}`)
    console.log(`  远端文件数  ${remoteFilesRaw.trim()}`)
    console.log(`  远端 du     ${formatBytes(remoteBytes)}`)
    console.log(`  下载耗时    ${(result.durationMs / 1000).toFixed(1)}s（含建连 ${(wall / 1000).toFixed(1)}s）`)
    console.log(`  吞吐        ${formatRate(result.bytesPerSecond)}`)

    // 对账口径要注意：result.bytes 是**流过的 tar 字节数**（含每条 512 字节头 + 结尾 1024 结束块），
    // 不是纯文件内容。真正该比的是「本地落盘的总字节」和「远端 du 的总字节」。
    const filesOk = local.files === remoteFiles && result.files === remoteFiles
    const bytesOk = Math.abs(local.bytes - remoteBytes) <= 4096 * (result.dirs + 1)
    console.log(`  对账        ${filesOk && bytesOk ? green('✓ 一致') : red('✗ 不一致（解包可能丢数据）')}`)

    // 抽一个大文件算 sha256，做端到端校验
    const bigLocal = join(dest, 'big', 'dataset.bin')
    const bigExists = await stat(bigLocal).then(
      () => true,
      () => false
    )
    if (bigExists) {
      const sha = async (file: string | 'remote'): Promise<string> => {
        if (file === 'remote') {
          const out = await session.exec(`sha256sum ${shq(`${remoteDir}/big/dataset.bin`)} | cut -d' ' -f1`, {
            timeoutMs: 300_000
          })
          return out.stdout.trim()
        }
        return new Promise<string>((resolve, reject) => {
          const hash = createHash('sha256')
          createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject)
        })
      }
      const [localSha, remoteSha] = [await sha(bigLocal), await sha('remote')]
      console.log(`  sha256      本地 ${localSha.slice(0, 16)}… / 远端 ${remoteSha.slice(0, 16)}…`)
      console.log(`  大文件校验  ${localSha === remoteSha ? green('✓ 一致') : red('✗ 不一致')}`)
      if (localSha !== remoteSha) exitCode = 1
    }

    if (!filesOk || !bytesOk) exitCode = 1

    if (createdRemoteDir && !args.keepRemoteArtifact) {
      await session.exec(`rm -rf ${shq(createdRemoteDir)}`)
      console.log(dim(`\n已清理远端测试目录`))
    }
  } catch (err) {
    console.error('')
    console.error(red('✗ 下载失败'))
    console.error(formatSshError(err))
    exitCode = 1
  } finally {
    await pool.closeAll()
    if (!args.keepLocal) {
      await rm(localRoot, { recursive: true, force: true }).catch(() => {})
    } else {
      console.log(dim(`\n下载结果保留在：${localRoot}`))
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
