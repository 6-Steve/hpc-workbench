import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listLocalDir, listRemoteDir } from '../src/main/fs/listing'
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
      '/home/user01/notes.txt': 'hello',
      '/home/user01/big.bin': Buffer.alloc(2048, 1),
      '/home/user01/project/main.py': 'print(1)'
    }
  })

  workDir = mkdtempSync(join(tmpdir(), 'hpc-listing-test-'))
  const keyPath = join(workDir, 'id_ed25519')
  writeFileSync(keyPath, makeTestKey())

  const loaded = validateProfiles(
    {
      defaultProfile: 'fake',
      profiles: [
        {
          id: 'fake',
          host: '127.0.0.1',
          port: cluster.port,
          username: 'user01',
          auth: { method: 'key', privateKeyPath: keyPath }
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

describe('listRemoteDir', () => {
  it('不传路径时用远端 home', async () => {
    const listing = await listRemoteDir(session)
    expect(listing.path).toBe('/home/user01')
    expect(listing.side).toBe('remote')
    expect(listing.separator).toBe('/')
  })

  it('目录在前，文件和目录都带大小与时间', async () => {
    const listing = await listRemoteDir(session, '/home/user01')

    expect(listing.entries.map((entry) => entry.name)).toEqual(['project', 'big.bin', 'notes.txt'])
    expect(listing.entries[0]!.kind).toBe('dir')
    expect(listing.entries[0]!.size).toBeNull()

    const big = listing.entries.find((entry) => entry.name === 'big.bin')!
    expect(big.kind).toBe('file')
    expect(big.size).toBe(2048)
    expect(big.mtime).toBeTypeOf('number')
  })

  it('上级路径正确；根目录没有上级', async () => {
    expect((await listRemoteDir(session, '/home/user01')).parent).toBe('/home')

    cluster.fs.mkdir('/root-only')
    const root = await listRemoteDir(session, '/')
    expect(root.parent).toBeNull()
  })

  it('子目录里的条目不会串到父目录', async () => {
    const listing = await listRemoteDir(session, '/home/user01/project')
    expect(listing.entries.map((entry) => entry.name)).toEqual(['main.py'])
  })

  it('目录不存在时报错，并给出可读原因', async () => {
    await expect(listRemoteDir(session, '/home/user01/nope')).rejects.toThrow(/读取目录/)
  })
})

describe('listLocalDir', () => {
  it('列出文件与子目录，目录排前面', async () => {
    const dir = join(workDir, 'sample')
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'x'.repeat(100))

    const listing = await listLocalDir(dir)

    expect(listing.side).toBe('local')
    expect(listing.entries.map((entry) => entry.name)).toEqual(['sub', 'a.txt'])
    expect(listing.entries[0]!.kind).toBe('dir')

    const file = listing.entries[1]!
    expect(file.kind).toBe('file')
    expect(file.size).toBe(100)
    expect(file.mtime).toBeTypeOf('number')
  })

  it('上级路径正确', async () => {
    const dir = join(workDir, 'sample')
    expect((await listLocalDir(dir)).parent).toBe(workDir)
  })

  it('目录不存在时报"目录不存在"，而不是抛原始 ENOENT', async () => {
    await expect(listLocalDir(join(workDir, 'missing-dir'))).rejects.toThrow(/目录不存在/)
  })

  it('空目录返回空数组，不是错误', async () => {
    const empty = join(workDir, 'empty')
    mkdirSync(empty, { recursive: true })
    const listing = await listLocalDir(empty)
    expect(listing.entries).toEqual([])
  })
})
