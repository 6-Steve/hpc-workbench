import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { clearListingCache, invalidateListing, listRemoteDir } from '../src/main/fs/listing'
import { validateProfiles } from '../src/main/profiles'
import { KnownHostsStore } from '../src/main/ssh/known-hosts'
import { Session } from '../src/main/ssh/session'
import { createFakeCluster, type FakeCluster } from './helpers/fake-cluster'
import { makeTestKey } from './helpers/test-key'

let cluster: FakeCluster
let session: Session
let workDir: string
let home: string

beforeAll(async () => {
  cluster = await createFakeCluster({
    files: {
      '/home/user01/a.txt': Buffer.from('a'),
      '/home/user01/b.txt': Buffer.from('b'),
      '/home/user01/data/c.bin': Buffer.from('c')
    }
  })

  workDir = mkdtempSync(join(tmpdir(), 'hpc-cache-test-'))
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
  home = await new Promise<string>((resolve, reject) => {
    void session.sftp().then((sftp) => sftp.realpath('.', (err, p) => (err ? reject(err) : resolve(p))))
  })
})

afterAll(async () => {
  await session?.close()
  await cluster?.close()
  rmSync(workDir, { recursive: true, force: true })
})

beforeEach(() => {
  clearListingCache()
  cluster.fs.opendirCalls.length = 0
})

describe('远端目录缓存', () => {
  it('同一个目录连读两次，只真的读了一次', async () => {
    const first = await listRemoteDir(session, home)
    expect(first.entries.length).toBeGreaterThan(0)
    expect(cluster.fs.opendirCalls).toHaveLength(1)

    const second = await listRemoteDir(session, home)
    // 命中缓存：没有新的 OPENDIR
    expect(cluster.fs.opendirCalls).toHaveLength(1)
    // 内容一致（同一个对象也无所谓，反正是只读的）
    expect(second.entries.map((e) => e.name)).toEqual(first.entries.map((e) => e.name))
  })

  it('noCache 绕过缓存，一定真读', async () => {
    await listRemoteDir(session, home)
    expect(cluster.fs.opendirCalls).toHaveLength(1)

    await listRemoteDir(session, home, { noCache: true })
    expect(cluster.fs.opendirCalls).toHaveLength(2)

    // 再来一次还是真读
    await listRemoteDir(session, home, { noCache: true })
    expect(cluster.fs.opendirCalls).toHaveLength(3)
  })

  it('invalidate 之后会重新读，能看到新文件', async () => {
    const before = await listRemoteDir(session, home)
    expect(before.entries.some((e) => e.name === 'new.txt')).toBe(false)

    // 模拟"外部"新增了一个文件（比如从回收站还原）
    cluster.fs.write(`${home}/new.txt`, Buffer.from('new'))

    // 不 invalidate 的话还是旧数据
    const cached = await listRemoteDir(session, home)
    expect(cached.entries.some((e) => e.name === 'new.txt')).toBe(false)

    // invalidate 之后就能看到
    invalidateListing(session, `${home}/new.txt`)
    const fresh = await listRemoteDir(session, home)
    expect(fresh.entries.some((e) => e.name === 'new.txt')).toBe(true)
  })

  it('删掉一个文件后 invalidate 该路径，父目录也跟着失效', async () => {
    // 先读一次把父目录塞进缓存
    await listRemoteDir(session, home)
    expect(cluster.fs.opendirCalls).toHaveLength(1)

    cluster.fs.unlink(`${home}/a.txt`)
    invalidateListing(session, `${home}/a.txt`)

    const after = await listRemoteDir(session, home)
    expect(after.entries.some((e) => e.name === 'a.txt')).toBe(false)
  })

  it('不同目录各自独立缓存', async () => {
    await listRemoteDir(session, home)
    await listRemoteDir(session, `${home}/data`)
    expect(cluster.fs.opendirCalls).toHaveLength(2)

    // 各自再读一次，都命中
    await listRemoteDir(session, home)
    await listRemoteDir(session, `${home}/data`)
    expect(cluster.fs.opendirCalls).toHaveLength(2)
  })
})
