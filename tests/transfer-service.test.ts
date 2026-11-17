import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { validateProfiles } from '../src/main/profiles'
import { KnownHostsStore } from '../src/main/ssh/known-hosts'
import { Session } from '../src/main/ssh/session'
import { TransferService } from '../src/main/transfer/service'
import { createFakeCluster, type FakeCluster } from './helpers/fake-cluster'
import { makeTestKey } from './helpers/test-key'

let cluster: FakeCluster
let session: Session
let workDir: string
let service: TransferService

beforeAll(async () => {
  cluster = await createFakeCluster({
    files: { '/home/user01/remote.bin': Buffer.alloc(500, 9) }
  })

  workDir = mkdtempSync(join(tmpdir(), 'hpc-service-test-'))
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
  service = new TransferService({ getSession: async () => session })
})

afterAll(async () => {
  await session?.close()
  await cluster?.close()
  rmSync(workDir, { recursive: true, force: true })
})

describe('TransferService：计划生命周期', () => {
  it('计划能缓存住，确认之后才真正入队', async () => {
    const file = join(workDir, 'a.txt')
    writeFileSync(file, 'hello')

    const plan = await service.plan({ direction: 'upload', paths: [file], targetDir: '/home/user01' })
    expect(service.snapshot()).toBeNull() // 还没确认，队列都不该存在

    const snapshot = await service.start(plan.id)
    // 队列是服务级单例，任务是累加的——只找本次这一条
    expect(snapshot.tasks.filter((task) => task.label === 'a.txt')).toHaveLength(1)
  })

  it('同一个计划不能确认两次', async () => {
    const file = join(workDir, 'b.txt')
    writeFileSync(file, 'hello')

    const plan = await service.plan({ direction: 'upload', paths: [file], targetDir: '/home/user01' })
    await service.start(plan.id)

    await expect(service.start(plan.id)).rejects.toThrow(/失效/)
  })

  it('空路径直接拒绝，不生成计划', async () => {
    await expect(service.plan({ direction: 'upload', paths: [], targetDir: '/home/user01' })).rejects.toThrow(
      /没有选中/
    )
  })
})

describe('TransferService：冲突策略', () => {
  it('文件可以用 overwrite', async () => {
    const file = join(workDir, 'c.txt')
    writeFileSync(file, 'hello')

    const plan = await service.plan({ direction: 'upload', paths: [file], targetDir: '/home/user01' })
    const snapshot = await service.start(plan.id, 'overwrite')
    expect(snapshot.tasks.filter((task) => task.label === 'c.txt')).toHaveLength(1)
  })

  it('目录不允许 overwrite：会先删掉远端整个目录，风险太大', async () => {
    const dir = join(workDir, 'dataset')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'x.bin'), Buffer.alloc(10))

    const plan = await service.plan({ direction: 'upload', paths: [dir], targetDir: '/home/user01' })

    await expect(service.start(plan.id, 'overwrite')).rejects.toThrow(/目录不支持/)
  })

  it('目录被拒绝后计划仍然有效，改选 skip 就能继续', async () => {
    const dir = join(workDir, 'dataset2')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'y.bin'), Buffer.alloc(10))

    const plan = await service.plan({ direction: 'upload', paths: [dir], targetDir: '/home/user01' })
    await expect(service.start(plan.id, 'overwrite')).rejects.toThrow()

    // 计划没被消费掉，用户换个策略不该重新拖一次
    const snapshot = await service.start(plan.id, 'skip')
    expect(snapshot.tasks.filter((task) => task.label === 'dataset2')).toHaveLength(1)
  })
})
