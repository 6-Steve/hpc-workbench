import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { validateProfiles } from '../src/main/profiles'
import { KnownHostsStore } from '../src/main/ssh/known-hosts'
import { Session } from '../src/main/ssh/session'
import { planTransfer } from '../src/main/transfer/planner'
import { createFakeCluster, type FakeCluster } from './helpers/fake-cluster'
import { makeTestKey } from './helpers/test-key'

let cluster: FakeCluster
let session: Session
let workDir: string

beforeAll(async () => {
  cluster = await createFakeCluster({
    files: { '/home/user01/remote.bin': Buffer.alloc(500, 9) }
  })

  workDir = mkdtempSync(join(tmpdir(), 'hpc-plan-test-'))
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

describe('planTransfer：上传', () => {
  it('单个小文件：推荐单流 SFTP，目标路径拼在目录后面', async () => {
    const file = join(workDir, 'small.txt')
    writeFileSync(file, 'hello')

    const plan = await planTransfer(session, {
      direction: 'upload',
      paths: [file],
      targetDir: '/home/user01'
    })

    expect(plan.direction).toBe('upload')
    expect(plan.items).toHaveLength(1)
    expect(plan.items[0]!.target).toBe('/home/user01/small.txt')
    expect(plan.decision.effective).toBe('sftp')
    expect(plan.stats.fileCount).toBe(1)
  })

  it('目标目录结尾有斜杠时不会拼出双斜杠', async () => {
    const file = join(workDir, 'slash.txt')
    writeFileSync(file, 'x')

    const plan = await planTransfer(session, { direction: 'upload', paths: [file], targetDir: '/home/user01/' })
    expect(plan.items[0]!.target).toBe('/home/user01/slash.txt')
  })

  it('包含目录时强制走 tar，理由说清楚是"保持目录结构"', async () => {
    const dir = join(workDir, 'dataset')
    mkdirSync(join(dir, 'inner'), { recursive: true })
    writeFileSync(join(dir, 'a.bin'), Buffer.alloc(10))
    writeFileSync(join(dir, 'inner', 'b.bin'), Buffer.alloc(20))

    const plan = await planTransfer(session, { direction: 'upload', paths: [dir], targetDir: '/home/user01' })

    expect(plan.items[0]!.kind).toBe('dir')
    expect(plan.decision.effective).toBe('tar')
    expect(plan.decision.reason).toContain('目录')
    expect(plan.stats.fileCount).toBe(2)
    expect(plan.stats.totalBytes).toBe(30)
  })

  it('一次拖多个：统计是合并后的', async () => {
    const one = join(workDir, 'multi-1.bin')
    const two = join(workDir, 'multi-2.bin')
    writeFileSync(one, Buffer.alloc(100))
    writeFileSync(two, Buffer.alloc(250))

    const plan = await planTransfer(session, { direction: 'upload', paths: [one, two], targetDir: '/home/user01/m' })

    expect(plan.items).toHaveLength(2)
    expect(plan.stats.fileCount).toBe(2)
    expect(plan.stats.totalBytes).toBe(350)
    expect(plan.stats.largestFileBytes).toBe(250)
  })

  it('summary 带上文件数、体积和目标目录', async () => {
    const file = join(workDir, 'summary.txt')
    writeFileSync(file, 'x')

    const plan = await planTransfer(session, { direction: 'upload', paths: [file], targetDir: '/home/user01' })
    expect(plan.summary).toContain('/home/user01')
    expect(plan.summary).toContain('1')
  })
})

describe('planTransfer：下载', () => {
  it('单个远端文件可以计划', async () => {
    const plan = await planTransfer(session, {
      direction: 'download',
      paths: ['/home/user01/remote.bin'],
      targetDir: workDir
    })

    expect(plan.items).toHaveLength(1)
    expect(plan.items[0]!.target).toBe(join(workDir, 'remote.bin'))
    expect(plan.stats.totalBytes).toBe(500)
  })

  it('远端目录现在支持下载了，走 tar 并说明理由', async () => {
    const plan = await planTransfer(session, {
      direction: 'download',
      paths: ['/home/user01'],
      targetDir: workDir
    })

    expect(plan.unsupported).toHaveLength(0)
    expect(plan.items).toHaveLength(1)
    expect(plan.items[0]!.kind).toBe('dir')
    expect(plan.decision.effective).toBe('tar')
    // 下载侧的措辞要能自解释为什么不用 SFTP 逐文件传
    expect(plan.decision.reason).toContain('目录结构')
    expect(plan.decision.reason).toContain('无需安装 tar')
  })

  it('远端不存在的路径进 unsupported', async () => {
    const plan = await planTransfer(session, {
      direction: 'download',
      paths: ['/home/user01/nope.txt'],
      targetDir: workDir
    })
    expect(plan.unsupported).toHaveLength(1)
  })
})
