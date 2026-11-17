/**
 * 连接层端到端测试：本地起一个 ssh2 假集群，模拟 23.02.3 的 CLI 输出。
 *
 * 这一层没有别的办法测——单元测试覆盖不到握手、认证、channel、host key 校验。
 * 假集群的返回值和 docs/03 的实测样本一致（sinfo/scontrol 没有 --json，squeue/sacct 有）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ResolvedProfile } from '../src/main/profiles'
import { validateProfiles } from '../src/main/profiles'
import { probeCapabilities } from '../src/main/ssh/capabilities'
import { SshError } from '../src/main/ssh/errors'
import { KnownHostsStore } from '../src/main/ssh/known-hosts'
import { Session } from '../src/main/ssh/session'
import { createFakeCluster, type CannedCommand, type FakeCluster } from './helpers/fake-cluster'
import { makeTestKey } from './helpers/test-key'

const CANNED: Record<string, CannedCommand> = {
  'sinfo -V': { stdout: 'slurm 23.02.3\n', code: 0 },
  'uname -srm': { stdout: 'Linux 5.15.0-186-generic x86_64\n', code: 0 },
  'printf %s "$HOME"': { stdout: '/home/user01\n', code: 0 },
  'command -v sbatch': { stdout: '/usr/bin/sbatch\n', code: 0 },
  'test -x /usr/lpp/mmfs/bin/mmlsquota && echo found || echo missing': { stdout: 'found\n', code: 0 },
  'sinfo --json': { stdout: '', stderr: "sinfo: unrecognized option '--json'\n", code: 1 },
  'squeue --me --json': { stdout: '{"jobs": []}\n', code: 0 },
  'sacct --json -S now-1hours -E now': { stdout: '{"jobs": []}\n', code: 0 },
  'scontrol show node --json': { stdout: '', stderr: 'scontrol: error: Invalid option --json\n', code: 1 },
  'echo hello': { stdout: 'hello\n', code: 0 },
  'echo boom': { stdout: '', stderr: 'boom\n', code: 3 }
}

let cluster: FakeCluster
let profile: ResolvedProfile
let dir: string
let knownHostsPath: string
let port: number
let session: Session

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hpc-e2e-'))
  const clientKeyPath = join(dir, 'id_ed25519')
  writeFileSync(clientKeyPath, makeTestKey())

  cluster = await createFakeCluster({
    commands: CANNED,
    handleCommand: (command, stream) => {
      // 跟随日志：故意把一个汉字劈成两半发出去，验证 StringDecoder
      if (command.startsWith('tail -n 200 -F -- /tmp/split.log')) {
        const full = Buffer.from('第一行\n中文测试\n', 'utf8')
        const cut = Buffer.byteLength('第一行\n', 'utf8') + 1 // 切在「中」的三个字节中间
        stream.write(full.subarray(0, cut))
        setTimeout(() => {
          stream.write(full.subarray(cut))
          stream.exit(0)
          stream.end()
        }, 30)
        return true
      }

      // 永不结束的跟随：给中止功能用
      if (command.startsWith('tail -n 200 -F -- /tmp/never.log')) {
        stream.write('starting\n')
        return true // 不 end，等客户端中止
      }

      // 读 stdin 的命令：用来验证 Session.pipe 与背压
      if (command !== 'count-stdin' && command !== 'fail-stdin') return false

      let total = 0
      stream.on('data', (chunk: Buffer) => {
        total += chunk.length
      })
      stream.on('end', () => {
        stream.write(String(total))
        stream.exit(command === 'fail-stdin' ? 3 : 0)
        stream.end()
      })
      return true
    }
  })

  port = cluster.port

  knownHostsPath = join(dir, 'known_hosts.json')
  const loaded = validateProfiles(
    {
      defaultProfile: 'fake',
      profiles: [
        {
          id: 'fake',
          host: '127.0.0.1',
          port,
          username: 'user01',
          auth: { method: 'key', privateKeyPath: clientKeyPath },
          maxConcurrent: 3
        }
      ]
    },
    join(dir, 'profiles.json')
  )
  profile = loaded.profiles[0]!

  session = await Session.open(profile, { knownHosts: new KnownHostsStore(knownHostsPath) })
})

afterAll(async () => {
  await session?.close()
  await cluster?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('Session 端到端', () => {
  it('握手、认证与 host key 记录', () => {
    expect(session.isAlive).toBe(true)
    expect(session.hostKey?.algorithm).toBe('ssh-ed25519')
    expect(session.hostKey?.fingerprint.startsWith('SHA256:')).toBe(true)
    expect(session.hostKey?.verdict).toBe('new')
  })

  it('exec 拿回 stdout 与退出码', async () => {
    const result = await session.exec('echo hello')
    expect(result.stdout.trim()).toBe('hello')
    expect(result.code).toBe(0)
    expect(result.truncated).toBe(false)
  })

  it('命令非 0 退出时不抛异常，stderr 原样带出', async () => {
    const result = await session.exec('echo boom')
    expect(result.code).toBe(3)
    expect(result.stderr.trim()).toBe('boom')
  })

  it('并发 exec 不会打爆通道', async () => {
    const results = await Promise.all(Array.from({ length: 9 }, () => session.exec('echo hello')))
    expect(results.every((r) => r.stdout.trim() === 'hello')).toBe(true)
  })

  it('pipe 能把本地流灌进远端命令并拿回退出码', async () => {
    const payload = Buffer.alloc(256 * 1024, 0x41)
    const result = await session.pipe('count-stdin', Readable.from(payload))

    expect(result.bytes).toBe(payload.length)
    expect(result.code).toBe(0)
  })

  it('pipe 在远端失败时返回退出码，而不是抛一个看不懂的管道错误', async () => {
    const result = await session.pipe('fail-stdin', Readable.from(Buffer.alloc(8 * 1024, 0x42)))
    expect(result.code).toBe(3)
  })

  it('能力探测按实测的 23.02.3 情况给出结果', async () => {
    const caps = await probeCapabilities(session, profile)

    expect(caps.sinfoJson).toBe(false)
    expect(caps.scontrolJson).toBe(false)
    expect(caps.squeueJson).toBe(true)
    expect(caps.sacctJson).toBe(true)
    expect(caps.slurmVersionNumber).toBe('23.02.3')
    expect(caps.home).toBe('/home/user01')
    expect(caps.sbatchAvailable).toBe(true)
    expect(caps.quotaToolFound).toBe(true)
    expect(caps.evidence.sinfoJson!.code).toBe(1)
  })

  it('连接关闭后 exec 抛可重试错误，而不是静默返回空', async () => {
    const extra = await Session.open(profile, { knownHosts: new KnownHostsStore(null) })
    await extra.close()

    await expect(extra.exec('echo hello')).rejects.toBeInstanceOf(SshError)
  })

  it('主机指纹变了就拒绝连接', async () => {
    const tampered = new KnownHostsStore(null)
    tampered.remember('127.0.0.1', port, 'ssh-ed25519', 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')

    await expect(Session.open(profile, { knownHosts: tampered })).rejects.toMatchObject({ kind: 'hostkey' })
  })

  it('profile 不允许自动信任时，未知主机也拒绝', async () => {
    const strict = { ...profile, trustNewHostKey: false }
    await expect(Session.open(strict, { knownHosts: new KnownHostsStore(null) })).rejects.toMatchObject({
      kind: 'hostkey'
    })
  })
})

/**
 * 跟随日志（`tail -f`）。
 *
 * 这一组锁的是三件容易静默出错的事：
 * 1. UTF-8 汉字被 chunk 边界劈开时不能变成乱码；
 * 2. 长连接**不能占信号量**，否则开几个跟随就把 exec 通道饿死；
 * 3. 用户关掉弹窗时必须能主动中止，否则远端 tail 会一直挂着。
 */
describe('Session.tail（跟随日志）', () => {
  it('多字节字符被 chunk 切开也不会乱码', async () => {
    let text = ''
    const result = await session.tail('tail -n 200 -F -- /tmp/split.log', {
      onText: (chunk) => {
        text += chunk
      }
    })

    // 假集群把一个汉字劈成两半发过来；直接 toString('utf8') 这里会是「中」变乱码
    expect(text).toBe('第一行\n中文测试\n')
    expect(result.code).toBe(0)
    expect(result.aborted).toBe(false)
  })

  it('跟随期间不占用 exec 的并发名额', async () => {
    const controller = new AbortController()
    let received = ''
    const following = session.tail('tail -n 200 -F -- /tmp/never.log', {
      onText: (chunk) => {
        received += chunk
      },
      signal: controller.signal
    })

    // 等第一块数据到，确认通道真的开着
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(received).toContain('starting')

    // maxConcurrent = 3。如果 tail 占了名额，这里 5 条并发会被卡住。
    // 走的是信号量之外，所以应当全部立刻完成。
    const started = Date.now()
    const results = await Promise.all(Array.from({ length: 5 }, () => session.exec('echo hello')))
    expect(results.every((r) => r.stdout.trim() === 'hello')).toBe(true)
    expect(Date.now() - started).toBeLessThan(2000)

    controller.abort()
    const result = await following
    expect(result.aborted).toBe(true)
  })

  it('中止后 promise 正常结束，不抛异常', async () => {
    const controller = new AbortController()
    const following = session.tail('tail -n 200 -F -- /tmp/never.log', {
      onText: () => {},
      signal: controller.signal
    })

    controller.abort()
    await expect(following).resolves.toMatchObject({ aborted: true })
  })
})
