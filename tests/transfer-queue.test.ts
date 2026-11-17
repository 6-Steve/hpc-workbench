import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { validateProfiles } from '../src/main/profiles'
import { KnownHostsStore } from '../src/main/ssh/known-hosts'
import { Session } from '../src/main/ssh/session'
import { TransferQueue, type QueueOptions, type QueueSnapshot } from '../src/main/transfer/queue'
import { createFakeCluster, type FakeCluster } from './helpers/fake-cluster'
import { makeTestKey } from './helpers/test-key'

let cluster: FakeCluster
let session: Session
let workDir: string

beforeAll(async () => {
  cluster = await createFakeCluster()
  workDir = mkdtempSync(join(tmpdir(), 'hpc-queue-test-'))

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

function localFile(name: string, content: string): string {
  const path = join(workDir, name)
  writeFileSync(path, content)
  return path
}

function makeQueue(options: Partial<QueueOptions> = {}): TransferQueue {
  return new TransferQueue({ session, concurrency: 2, maxRetries: 1, retryBaseMs: 10, ...options })
}

describe('TransferQueue', () => {
  it('并发跑多个不同目标，全部成功', async () => {
    const queue = makeQueue()
    const ids = ['a', 'b', 'c'].map((name) =>
      queue.enqueue({
        direction: 'upload',
        localPath: localFile(`${name}.txt`, name),
        remotePath: `/home/user01/q/${name}.txt`
      })
    )

    await queue.whenIdle()
    const snapshot = queue.snapshot()

    expect(snapshot.tasks.map((task) => task.status)).toEqual(['succeeded', 'succeeded', 'succeeded'])
    expect(ids).toHaveLength(3)
    expect(cluster.fs.read('/home/user01/q/a.txt')?.toString()).toBe('a')
    queue.dispose()
  })

  it('并发数不超过配置值', async () => {
    let maxRunning = 0
    const queue = makeQueue({
      concurrency: 2,
      onUpdate: (snapshot: QueueSnapshot) => {
        maxRunning = Math.max(maxRunning, snapshot.running)
      }
    })

    for (let i = 0; i < 6; i += 1) {
      queue.enqueue({
        direction: 'upload',
        localPath: localFile(`conc-${i}.txt`, `payload-${i}`),
        remotePath: `/home/user01/conc/${i}.txt`
      })
    }

    await queue.whenIdle()
    expect(maxRunning).toBeLessThanOrEqual(2)
    expect(queue.snapshot().tasks.every((task) => task.status === 'succeeded')).toBe(true)
    queue.dispose()
  })

  it('同一目标路径加锁：第二个任务等到第一个完成后才跑，冲突按 skip 处理', async () => {
    const queue = makeQueue({ onConflict: 'skip' })

    queue.enqueue({
      direction: 'upload',
      localPath: localFile('same-1.txt', 'first'),
      remotePath: '/home/user01/same.txt'
    })
    queue.enqueue({
      direction: 'upload',
      localPath: localFile('same-2.txt', 'second'),
      remotePath: '/home/user01/same.txt'
    })

    await queue.whenIdle()
    const statuses = queue.snapshot().tasks.map((task) => task.status)

    // 串行执行 + skip 策略 → 一个成功、一个跳过；并发执行则会出现两个都过存在性检查的竞态
    expect(statuses).toEqual(['succeeded', 'skipped'])
    expect(cluster.fs.read('/home/user01/same.txt')?.toString()).toBe('first')
    queue.dispose()
  })

  it('冲突策略 fail：目标已存在时标记失败并带上原因', async () => {
    cluster.fs.write('/home/user01/exists.txt', Buffer.from('old'))
    const queue = makeQueue({ onConflict: 'fail' })

    queue.enqueue({
      direction: 'upload',
      localPath: localFile('exists-local.txt', 'new'),
      remotePath: '/home/user01/exists.txt'
    })

    await queue.whenIdle()
    const task = queue.snapshot().tasks[0]!

    expect(task.status).toBe('failed')
    expect(task.error?.message).toContain('已存在')
    expect(cluster.fs.read('/home/user01/exists.txt')?.toString()).toBe('old')
    queue.dispose()
  })

  it('冲突策略 rename：写到带序号的新名字，原文件不动', async () => {
    cluster.fs.write('/home/user01/dup.txt', Buffer.from('old'))
    const queue = makeQueue({ onConflict: 'rename' })

    queue.enqueue({
      direction: 'upload',
      localPath: localFile('dup-local.txt', 'new'),
      remotePath: '/home/user01/dup.txt'
    })

    await queue.whenIdle()
    const task = queue.snapshot().tasks[0]!

    expect(task.status).toBe('succeeded')
    expect(task.remotePath).toBe('/home/user01/dup (1).txt')
    expect(cluster.fs.read('/home/user01/dup.txt')?.toString()).toBe('old')
    expect(cluster.fs.read('/home/user01/dup (1).txt')?.toString()).toBe('new')
    queue.dispose()
  })

  it('冲突策略 overwrite：直接替换', async () => {
    cluster.fs.write('/home/user01/ow.txt', Buffer.from('old'))
    const queue = makeQueue({ onConflict: 'overwrite' })

    queue.enqueue({
      direction: 'upload',
      localPath: localFile('ow-local.txt', 'new content'),
      remotePath: '/home/user01/ow.txt'
    })

    await queue.whenIdle()
    expect(queue.snapshot().tasks[0]!.status).toBe('succeeded')
    expect(cluster.fs.read('/home/user01/ow.txt')?.toString()).toBe('new content')
    queue.dispose()
  })

  it('能取消还在排队的任务，且它不会被执行', async () => {
    const queue = makeQueue({ concurrency: 1 })

    queue.enqueue({
      direction: 'upload',
      localPath: localFile('first.txt', 'first'),
      remotePath: '/home/user01/serial/first.txt'
    })
    const second = queue.enqueue({
      direction: 'upload',
      localPath: localFile('second.txt', 'second'),
      remotePath: '/home/user01/serial/second.txt'
    })

    expect(await queue.cancel(second)).toEqual({ result: 'removed' })
    await queue.whenIdle()

    expect(queue.snapshot().tasks[1]!.status).toBe('cancelled')
    expect(cluster.fs.isFile('/home/user01/serial/second.txt')).toBe(false)
    queue.dispose()
  })

  /**
   * 运行中的任务能真的停下来。
   *
   * 这条替换了原来的「已经在跑的任务取消会返回 too-late」——那时取消运行中的
   * 传输是个明确不做的功能，界面上根本没有按钮。用户实测后要求加上：
   * 传一个 187 MB 的文件时只能干等，没法反悔。
   */
  it('运行中的任务能被取消，并返回已传字节数', async () => {
    const queue = makeQueue({ concurrency: 1 })

    /*
     * 大小要"大到 40 ms 传不完"，但**不要求它一定没传完**。
     *
     * 这条断言以前是 `bytesDone < payload.length`，在本地回环跑 50 MB/s 时
     * 8 MB 只要 160 ms 还好；但一旦取消的实现变成"等 ssh2 手里的块写完再 settle"，
     * 快机器上可能刚好写完 —— 那就变成"取消了一个已经传完的任务"，是**合法结果**，
     * 不该让测试红。真正要守的是"别把 0 报成 N、别把 N 报成 0 之外的胡说"。
     */
    const payload = Buffer.alloc(24 * 1024 * 1024, 'z')
    const path = join(workDir, 'cancel-big.bin')
    writeFileSync(path, payload)

    const id = queue.enqueue({
      direction: 'upload',
      localPath: path,
      remotePath: '/home/user01/cancel-big.bin'
    })

    // 等它真的进入 running 并传了一点
    await new Promise((resolve) => setTimeout(resolve, 40))

    const outcome = await queue.cancel(id)
    expect(outcome.result).toBe('aborted')
    await queue.whenIdle()

    const task = queue.snapshot().tasks[0]!
    expect(task.status).toBe('cancelled')
    // 目标文件不该出现——`.part` 没被改名
    expect(cluster.fs.isFile('/home/user01/cancel-big.bin')).toBe(false)
    if (outcome.result === 'aborted') {
      expect(outcome.bytesDone).toBeGreaterThanOrEqual(0)
      // 不能超过文件本身（报多了用户会以为传完了）
      expect(outcome.bytesDone).toBeLessThanOrEqual(payload.length)
    }
    queue.dispose()
  })

  it('取消后默认不删半截文件，`cleanup: true` 才删', async () => {
    const queue = makeQueue({ concurrency: 1 })
    const payload = Buffer.alloc(8 * 1024 * 1024, 'y')
    const path = join(workDir, 'cancel-cleanup.bin')
    writeFileSync(path, payload)

    const id = queue.enqueue({
      direction: 'upload',
      localPath: path,
      remotePath: '/home/user01/cancel-cleanup.bin'
    })
    await new Promise((resolve) => setTimeout(resolve, 40))

    const outcome = await queue.cancel(id, true)
    await queue.whenIdle()

    expect(outcome.result).toBe('aborted')
    /*
     * 清理是异步的（要等 `emit()` 之后再发 unlink），所以这里不能断言得太死。
     * 能确定的是：**目标名从来没出现过**（`.part` → 目标名的 rename 没发生），
     * 而 `.part` 最终会被删掉——给它一点时间。
     */
    const partial = '/home/user01/cancel-cleanup.bin.part'
    expect(cluster.fs.isFile('/home/user01/cancel-cleanup.bin')).toBe(false)
    for (let i = 0; i < 50 && cluster.fs.isFile(partial); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(cluster.fs.isFile(partial)).toBe(false)
    queue.dispose()
  })

  it('可重试的错误会按退避重试，次数用完才标记失败', async () => {
    // 故意用一个已经关闭的会话：sftp() 会抛可重试的 NOT_CONNECTED
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
      join(workDir, 'profiles-dead.json')
    )
    const deadSession = await Session.open(loaded.profiles[0]!, { knownHosts: new KnownHostsStore(null) })
    await deadSession.close()

    const queue = new TransferQueue({
      session: deadSession,
      concurrency: 1,
      maxRetries: 2,
      retryBaseMs: 10
    })

    queue.enqueue({
      direction: 'upload',
      localPath: localFile('retry.txt', 'retry'),
      remotePath: '/home/user01/retry.txt'
    })

    await queue.whenIdle()
    const task = queue.snapshot().tasks[0]!

    expect(task.status).toBe('failed')
    expect(task.attempt).toBe(3) // 首次 + 两次重试
    expect(task.error?.retryable).toBe(true)
    queue.dispose()
  })

  it('下载同样走队列，并且本地已存在时不静默覆盖', async () => {
    cluster.fs.write('/home/user01/dl-q.txt', Buffer.from('remote content'))

    const target = join(workDir, 'dl-q.txt')
    writeFileSync(target, 'local old')

    const queue = makeQueue({ onConflict: 'fail' })
    queue.enqueue({ direction: 'download', remotePath: '/home/user01/dl-q.txt', localPath: target })

    await queue.whenIdle()
    const task = queue.snapshot().tasks[0]!

    expect(task.status).toBe('failed')
    expect(task.error?.message).toContain('本地已存在')
    queue.dispose()
  })
})

/**
 * 进度聚合（`snapshot().doneBytes`）。
 *
 * 这一组守的是一个**用户在界面上直接看得见的 bug**：
 * 传一个 187 MB 的文件，底栏写 `0 B / 187 MB · 0%`、条子是空的，
 * 而同一行里的速度显示 `678 KB/s`。两个数字自相矛盾，用户只能以为卡死了。
 *
 * 根因是 `doneBytes` 只累加 `succeeded` / `skipped` 的任务——
 * **正在传的那个不贡献任何字节**，所以只有一个任务时进度恒为 0，
 * 直到它传完才"啪"地跳到 100%。而且所有单测都是等 `whenIdle()` 之后
 * 才读快照（那时任务已是 succeeded），所以一条都没发现。
 */
describe('TransferQueue · 进度聚合', () => {
  /** 传一个够大的文件，把每次 onUpdate 的快照收下来 */
  function watchProgress(queue: TransferQueue): Array<{ doneBytes: number; totalBytes: number }> {
    const samples: Array<{ doneBytes: number; totalBytes: number }> = []
    const original = (queue as unknown as { emit: () => void }).emit.bind(queue)
    ;(queue as unknown as { emit: () => void }).emit = () => {
      const snapshot = queue.snapshot()
      samples.push({ doneBytes: snapshot.doneBytes, totalBytes: snapshot.totalBytes })
      original()
    }
    return samples
  }

  it('单个任务传输过程中，doneBytes 会跟着涨（不是恒为 0）', async () => {
    // 8 MB：32 KB 一块，足够产生多次进度回调
    const payload = Buffer.alloc(8 * 1024 * 1024, 'x')
    const path = join(workDir, 'progress-big.bin')
    writeFileSync(path, payload)

    const queue = makeQueue({ concurrency: 1 })
    const samples = watchProgress(queue)

    queue.enqueue({ direction: 'upload', localPath: path, remotePath: '/home/user01/progress-big.bin' })
    await queue.whenIdle()

    // 传输**进行中**（status 还是 running）时就应该有非零且递增的 doneBytes
    const mid = samples.filter((sample) => sample.doneBytes > 0 && sample.doneBytes < sample.totalBytes)
    expect(mid.length, '应该有"传到一半"的中间快照；没有说明 doneBytes 只在结束时才动').toBeGreaterThan(0)

    // 且这些中间值确实是递增的
    const mids = mid.map((sample) => sample.doneBytes)
    expect(mids).toEqual([...mids].sort((a, b) => a - b))

    // 结束时必须打满
    const last = samples.at(-1)!
    expect(last.doneBytes).toBe(last.totalBytes)
    expect(last.totalBytes).toBe(payload.length)
    queue.dispose()
  })

  it('doneBytes 永远不会超过 totalBytes（分母一时缺失也不崩）', async () => {
    const queue = makeQueue()
    const samples = watchProgress(queue)

    // 不给 sizeHint：totalBytes 一开始是 null，要等 stat 之后才有值
    queue.enqueue({
      direction: 'upload',
      localPath: localFile('no-hint.txt', 'a'.repeat(1000)),
      remotePath: '/home/user01/no-hint.txt'
    })
    await queue.whenIdle()

    for (const sample of samples) {
      expect(sample.doneBytes).toBeLessThanOrEqual(sample.totalBytes)
    }
    queue.dispose()
  })

  it('失败的任务不贡献进度（否则进度条会先涨后跌）', async () => {
    cluster.fs.write('/home/user01/prog-exists.txt', Buffer.from('old'))
    const queue = makeQueue({ onConflict: 'fail' })

    queue.enqueue({
      direction: 'upload',
      localPath: localFile('prog-exists-local.txt', 'new'),
      remotePath: '/home/user01/prog-exists.txt'
    })
    queue.enqueue({
      direction: 'upload',
      localPath: localFile('prog-ok.txt', 'ok'),
      remotePath: '/home/user01/prog-ok.txt'
    })

    await queue.whenIdle()
    const snapshot = queue.snapshot()
    const failedTask = snapshot.tasks.find((task) => task.status === 'failed')!

    // 分母含失败任务（体积确实是计划的一部分），分子只算真正落地的
    expect(failedTask).toBeDefined()
    expect(snapshot.doneBytes).toBe(snapshot.totalBytes - (failedTask.totalBytes ?? failedTask.bytes))
    queue.dispose()
  })
})
