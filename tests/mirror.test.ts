import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MIRROR_ROOT, clearMirror, prepareDragFile } from '../src/main/transfer/mirror'
import { validateProfiles } from '../src/main/profiles'
import { KnownHostsStore } from '../src/main/ssh/known-hosts'
import { Session } from '../src/main/ssh/session'
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
      '/home/user01/run.log': Buffer.from('epoch 1 loss 0.5\n'),
      '/home/user01/out/a.bin': Buffer.alloc(300, 7),
      '/home/user01/out/sub/b.bin': Buffer.alloc(120, 3)
    }
  })
  cluster.fs.mkdir('/home/user01/out/sub')

  workDir = mkdtempSync(join(tmpdir(), 'hpc-mirror-test-'))
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
  await clearMirror()
  rmSync(workDir, { recursive: true, force: true })
})

beforeEach(async () => {
  await clearMirror()
})

describe('prepareDragFile：把远端文件镜像到本地', () => {
  it('文件落地后内容一致，且不在缓存里', async () => {
    const result = await prepareDragFile(session, '/home/user01/run.log')

    expect(existsSync(result.localPath)).toBe(true)
    expect(result.cached).toBe(false)
    expect(readFileSync(result.localPath, 'utf8')).toBe('epoch 1 loss 0.5\n')
    expect(readFileSync(result.localPath).length).toBe(result.bytes)
  })

  it('第二次拖同一个文件命中缓存，不重新下载', async () => {
    const first = await prepareDragFile(session, '/home/user01/run.log')
    expect(first.cached).toBe(false)

    const second = await prepareDragFile(session, '/home/user01/run.log')
    expect(second.cached).toBe(true)
    expect(second.localPath).toBe(first.localPath)
  })

  it('远端大小变了就重新拉，不拿旧副本糊弄', async () => {
    const first = await prepareDragFile(session, '/home/user01/run.log')

    /*
     * ⚠️ 换上去的内容**必须改变长度**。
     *
     * 这里原来写的是同样 17 字节的 `epoch 2 loss 0.1\n`，于是"大小"这一半的键
     * 根本没被验到，全靠 mtime 兜着；而 SFTP 的 mtime 只有**秒级**精度——
     * 两次写入落在同一秒时缓存命中，用例就随机失败
     * （实测：先连过两次，第三次挂，看着像代码回归，其实是掷骰子）。
     */
    cluster.fs.write('/home/user01/run.log', Buffer.from('epoch 2 loss 0.1234\n'))

    const second = await prepareDragFile(session, '/home/user01/run.log')
    expect(second.cached).toBe(false)
    expect(readFileSync(second.localPath, 'utf8')).toBe('epoch 2 loss 0.1234\n')
    expect(first.localPath).toBe(second.localPath)
  })

  /*
   * 这一条才是"双键"存在的理由：日志被**原地改写、长度不变**（`loss 0.5` → `loss 0.1`）。
   * 只比大小会拖出旧副本，所以必须同时比 mtime。
   *
   * mtime 用 `setMtime` 定死，不靠 `Date.now()` 制造差异——秒级精度下那不可靠。
   */
  it('大小没变、只是 mtime 变了，也要重新拉', async () => {
    const first = await prepareDragFile(session, '/home/user01/run.log')
    const baseline = cluster.fs.mtimeOf('/home/user01/run.log') ?? Date.now()

    cluster.fs.write('/home/user01/run.log', Buffer.from('epoch 9 loss 0.1\n'))
    cluster.fs.setMtime('/home/user01/run.log', baseline + 5_000)

    const second = await prepareDragFile(session, '/home/user01/run.log')
    expect(second.cached).toBe(false)
    expect(readFileSync(second.localPath, 'utf8')).toBe('epoch 9 loss 0.1\n')
    expect(first.localPath).toBe(second.localPath)
  })

  it('目录会整包落地，带目录结构', async () => {
    const result = await prepareDragFile(session, '/home/user01/out')

    expect(statSync(result.localPath).isDirectory()).toBe(true)
    expect(readFileSync(join(result.localPath, 'a.bin')).length).toBe(300)
    expect(readFileSync(join(result.localPath, 'sub', 'b.bin')).length).toBe(120)
  })

  it('远端不存在时给出可读错误', async () => {
    await expect(prepareDragFile(session, '/home/user01/nope.txt')).rejects.toThrow(/读不到远端路径/)
  })

  it('不同远端路径互不覆盖', async () => {
    const a = await prepareDragFile(session, '/home/user01/run.log')
    const b = await prepareDragFile(session, '/home/user01/out/a.bin')

    expect(a.localPath).not.toBe(b.localPath)
    expect(readFileSync(a.localPath, 'utf8')).toContain('epoch')
    expect(readFileSync(b.localPath).length).toBe(300)
  })
})

describe('clearMirror：启动时的缓存清理', () => {
  it('清空镜像目录，并报告清掉了多少', async () => {
    await prepareDragFile(session, '/home/user01/run.log')
    await prepareDragFile(session, '/home/user01/out/a.bin')
    expect(existsSync(MIRROR_ROOT)).toBe(true)

    const result = await clearMirror()

    // 两个文件 + 两个 sidecar(.mirror.json)
    expect(result.files).toBeGreaterThanOrEqual(2)
    expect(result.bytes).toBeGreaterThan(0)
    expect(existsSync(MIRROR_ROOT)).toBe(false)
  })

  it('目录本来就不存在时不报错', async () => {
    await clearMirror()
    await expect(clearMirror()).resolves.toEqual({ files: 0, bytes: 0 })
  })
})
