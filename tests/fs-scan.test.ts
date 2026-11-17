import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { scanLocalPath, scanRemotePath, remoteKindOf } from '../src/main/fs/scan'
import { validateProfiles } from '../src/main/profiles'
import { KnownHostsStore } from '../src/main/ssh/known-hosts'
import { Session } from '../src/main/ssh/session'
import { createFakeCluster, type FakeCluster } from './helpers/fake-cluster'
import { makeTestKey } from './helpers/test-key'

let cluster: FakeCluster
let session: Session
let workDir: string

beforeAll(async () => {
  cluster = await createFakeCluster({
    files: {
      '/home/user01/a.bin': Buffer.alloc(100, 1),
      '/home/user01/sub/b.bin': Buffer.alloc(300, 2),
      '/home/user01/sub/deep/c.bin': Buffer.alloc(50, 3)
    }
  })

  workDir = mkdtempSync(join(tmpdir(), 'hpc-scan-test-'))
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

describe('scanLocalPath', () => {
  it('单个文件：文件数 1，最大文件就是它自己', async () => {
    const file = join(workDir, 'one.bin')
    writeFileSync(file, Buffer.alloc(123))

    const stats = await scanLocalPath(file)
    expect(stats).toMatchObject({ fileCount: 1, dirCount: 0, totalBytes: 123, largestFileBytes: 123 })
  })

  it('目录：递归统计文件数、总字节、最大文件', async () => {
    const root = join(workDir, 'tree')
    mkdirSync(join(root, 'x', 'y'), { recursive: true })
    writeFileSync(join(root, 'a.txt'), Buffer.alloc(10))
    writeFileSync(join(root, 'x', 'b.txt'), Buffer.alloc(200))
    writeFileSync(join(root, 'x', 'y', 'c.txt'), Buffer.alloc(30))

    const stats = await scanLocalPath(root)
    expect(stats.fileCount).toBe(3)
    expect(stats.dirCount).toBe(2)
    expect(stats.totalBytes).toBe(240)
    expect(stats.largestFileBytes).toBe(200)
    expect(stats.truncated).toBe(false)
  })

  it('空目录不报错', async () => {
    const empty = join(workDir, 'empty-scan')
    mkdirSync(empty, { recursive: true })
    expect((await scanLocalPath(empty)).fileCount).toBe(0)
  })

  it('路径不存在时报错', async () => {
    await expect(scanLocalPath(join(workDir, 'nope'))).rejects.toThrow(/读不到/)
  })
})

describe('scanRemotePath', () => {
  it('远端目录：递归统计', async () => {
    const stats = await scanRemotePath(session, '/home/user01')
    expect(stats.fileCount).toBe(3)
    expect(stats.dirCount).toBe(2)
    expect(stats.totalBytes).toBe(450)
    expect(stats.largestFileBytes).toBe(300)
  })

  it('远端单文件', async () => {
    const stats = await scanRemotePath(session, '/home/user01/a.bin')
    expect(stats).toMatchObject({ fileCount: 1, totalBytes: 100 })
  })
})

describe('remoteKindOf', () => {
  it('区分文件与目录', async () => {
    expect(await remoteKindOf(session, '/home/user01/a.bin')).toBe('file')
    expect(await remoteKindOf(session, '/home/user01/sub')).toBe('dir')
  })

  it('不存在返回 null', async () => {
    expect(await remoteKindOf(session, '/home/user01/nope')).toBeNull()
  })
})
