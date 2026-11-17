import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { validateProfiles } from '../src/main/profiles'
import { KnownHostsStore } from '../src/main/ssh/known-hosts'
import { Session } from '../src/main/ssh/session'
import { downloadDirectory, safeEntryName } from '../src/main/transfer/tar-download'
import { createFakeCluster, type FakeCluster } from './helpers/fake-cluster'
import { createShellHandler } from './helpers/remote-shell'
import { makeTestKey } from './helpers/test-key'

let cluster: FakeCluster
let session: Session
let workDir: string

beforeAll(async () => {
  cluster = await createFakeCluster({
    handleCommand: createShellHandler(),
    files: {
      '/home/user01/out/run.log': Buffer.from('epoch 1 loss 0.5\n'),
      '/home/user01/out/ckpt/model.pt': Buffer.alloc(1024, 7),
      '/home/user01/out/ckpt/deep/extra.bin': Buffer.alloc(256, 3)
    }
  })
  // MemoryFs 只从 files 建目录，补一下目录项，否则 test -d 认不到
  cluster.fs.mkdir('/home/user01/out/ckpt/deep')

  workDir = mkdtempSync(join(tmpdir(), 'hpc-tardl-test-'))
  writeFileSync(join(workDir, 'id_ed25519'), makeTestKey())

  const loaded = validateProfiles(
    {
      defaultProfile: 'fake',
      profiles: [
        {
          id: 'fake',
          host: '127.0.0.1',
          port: cluster.port,
          username: 'user01',
          auth: { method: 'key', privateKeyPath: join(workDir, 'id_ed25519') }
        }
      ]
    },
    join(workDir, 'profiles.json')
  )
  session = await Session.open(loaded.profiles[0]!, { knownHosts: new KnownHostsStore(null) })
})

afterAll(async () => {
  await session?.close()
  await cluster?.close()
  rmSync(workDir, { recursive: true, force: true })
})

describe('safeEntryName：解包路径校验', () => {
  it('普通相对路径原样放行', () => {
    expect(safeEntryName('a/b.txt')).toBe('a/b.txt')
    expect(safeEntryName('./a/b.txt')).toBe('a/b.txt')
  })

  it('拒绝跳出目标目录的路径', () => {
    expect(safeEntryName('../evil.txt')).toBeNull()
    expect(safeEntryName('a/../../evil.txt')).toBeNull()
    expect(safeEntryName('/etc/passwd')).toBeNull()
  })

  it('拒绝绝对路径和盘符', () => {
    expect(safeEntryName('C:/Windows/system32')).toBeNull()
    expect(safeEntryName('//server/share')).toBeNull()
  })

  it('拒绝空名和纯点名', () => {
    expect(safeEntryName('')).toBeNull()
    expect(safeEntryName('.')).toBeNull()
    expect(safeEntryName('./')).toBeNull()
  })

  it('Windows 反斜杠按分隔符处理，不能借此穿越', () => {
    expect(safeEntryName('..\\evil.txt')).toBeNull()
    expect(safeEntryName('a\\..\\..\\evil.txt')).toBeNull()
  })
})

describe('downloadDirectory：真实链路', () => {
  it('整目录下载后目录结构和内容都对，且不留 .partial', async () => {
    const dest = join(workDir, 'downloaded')

    const result = await downloadDirectory(session, {
      remoteDir: '/home/user01/out',
      localDir: dest
    })

    expect(result.files).toBe(3)
    expect(result.bytes).toBeGreaterThan(0)

    // 结构：dest 里直接是 out 的内容（和上传对称，不含目录本身）
    expect(readFileSync(join(dest, 'run.log'), 'utf8')).toBe('epoch 1 loss 0.5\n')
    expect(readFileSync(join(dest, 'ckpt', 'model.pt')).length).toBe(1024)
    expect(readFileSync(join(dest, 'ckpt', 'deep', 'extra.bin')).length).toBe(256)

    // .partial 必须已经改名掉，不能残留在 workDir 里
    expect(readdirSync(workDir).filter((name) => name.includes('.partial'))).toHaveLength(0)
  })

  it('目标目录已存在时拒绝，不做任何覆盖', async () => {
    const dest = join(workDir, 'already-there')
    await downloadDirectory(session, { remoteDir: '/home/user01/out', localDir: dest })

    await expect(downloadDirectory(session, { remoteDir: '/home/user01/out', localDir: dest })).rejects.toThrow(
      /已存在/
    )
  })

  it('远端目录不存在时给清晰报错，不留下 .partial', async () => {
    const dest = join(workDir, 'missing-src')

    await expect(downloadDirectory(session, { remoteDir: '/home/user01/nope', localDir: dest })).rejects.toThrow(
      /不存在/
    )

    expect(readdirSync(workDir).filter((name) => name.includes('.partial'))).toHaveLength(0)
  })
})
