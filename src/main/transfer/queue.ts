/**
 * 传输队列：并发控制、失败重试、**按目标路径加锁**、冲突策略。
 *
 * 为什么必须加锁：两个任务写同一个目标时，各自的 `.part` 会互相覆盖，
 * 最后谁都说不清结果是谁的。这类 bug 不报错、只在偶发时出现，是同类工具最隐蔽的问题。
 *
 * 本版本的限制（刻意写在最显眼处）：
 * - 只支持**排队中**的任务取消；已经在跑的一次传输无法中途叫停。
 *   要做到这一点需要把 fastPut 换成自己分块读写，顺带才能做断点续传——留给下一步。
 */
import { basename, dirname, extname, join } from 'node:path'
import { stat, unlink } from 'node:fs/promises'
import { SshError, isAbort } from '../ssh/errors'
import type { Session } from '../ssh/session'
import { ALREADY_EXISTS, downloadFile, remoteFileSize, uploadFile, type SshErrorWithPartial } from './sftp'
import { downloadDirectory } from './tar-download'
import { uploadDirectory } from './tar'

export type TransferDirection = 'upload' | 'download'
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled'
export type ConflictPolicy = 'fail' | 'skip' | 'overwrite' | 'rename'

export interface TransferTaskInput {
  direction: TransferDirection
  localPath: string
  remotePath: string
  label?: string
  /** directory 走 tar 打包，file 走 SFTP 单流 */
  kind?: 'file' | 'directory'
  /** 计划阶段已经算好了体积，省一次 stat（目录也没法 stat 出总大小） */
  sizeHint?: number
}

export interface TaskError {
  message: string
  hint?: string
  raw?: string
  retryable: boolean
}

export interface TaskSnapshot {
  id: string
  direction: TransferDirection
  localPath: string
  remotePath: string
  label: string
  status: TaskStatus
  bytes: number
  totalBytes: number | null
  bytesPerSecond: number
  /** 第几次尝试，从 1 开始 */
  attempt: number
  error?: TaskError
  /**
   * 被取消时留下的半截文件路径（`.part`）。
   * 有值就说明磁盘上真的躺着一份残缺数据，界面要据此问用户删不删。
   */
  partialPath?: string
}

/**
 * 取消的结果。
 *
 * `aborted` 与 `removed` 的区别很重要：
 * - `removed` 是排队中的任务，从没开始过，**没有**残留文件
 * - `aborted` 是正在跑的，已经传了一部分，磁盘上有 `.part`，需要问用户
 */
export type CancelOutcome =
  | { result: 'removed' }
  | { result: 'aborted'; bytesDone: number; partialPath?: string }
  | { result: 'not-found' }

export interface QueueSnapshot {
  tasks: TaskSnapshot[]
  running: number
  queued: number
  finished: number
  doneBytes: number
  totalBytes: number
}

export interface QueueOptions {
  session: Session
  /** 同时进行的传输数，默认 2 */
  concurrency?: number
  /** 可重试错误的额外重试次数，默认 2 */
  maxRetries?: number
  /** 退避基数，默认 500ms（500 / 1000 / 2000 …） */
  retryBaseMs?: number
  /** 目标已存在时的策略，默认 fail */
  onConflict?: ConflictPolicy
  onUpdate?: (snapshot: QueueSnapshot) => void
}

interface Task extends TaskSnapshot {
  kind: 'file' | 'directory'
  sizeHint?: number
  /** 已用掉的重试次数 */
  retries: number
  /** 改名重试次数，单独计数，不占用可重试错误的额度 */
  renames: number
  /** 退避期间不让调度器碰它 */
  readyAt: number
  /** 运行中的中止开关；排队时为 undefined */
  abort?: AbortController
  /** 用户取消时是否要删掉已传的半截文件 */
  cleanupOnCancel: boolean
  /** `cancel()` 挂在这里等"真的停下来了"这一刻 */
  onSettled?: () => void
}

function toTaskError(err: unknown): TaskError {
  if (err instanceof SshError) {
    return { message: err.message, hint: err.hint, raw: err.raw, retryable: err.retryable }
  }
  return { message: (err as Error)?.message ?? String(err), retryable: false }
}

function isAlreadyExists(err: unknown): boolean {
  return err instanceof SshError && err.code === ALREADY_EXISTS
}

/** `a/b.txt` + 2 → `a/b (2).txt`；远端按 POSIX，本地按平台 */
function withSuffix(path: string, index: number, remote: boolean): string {
  const dir = remote ? path.slice(0, Math.max(path.lastIndexOf('/'), 0)) : dirname(path)
  const name = remote ? path.slice(path.lastIndexOf('/') + 1) : basename(path)
  const ext = remote ? (name.includes('.') ? name.slice(name.lastIndexOf('.')) : '') : extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name
  const renamed = `${stem} (${index})${ext}`

  return remote ? (dir ? `${dir}/${renamed}` : renamed) : join(dir, renamed)
}

export class TransferQueue {
  private readonly session: Session
  private readonly concurrency: number
  private readonly maxRetries: number
  private readonly retryBaseMs: number
  /** 冲突策略可以在两次计划之间改（用户在确认框里选），所以不是 readonly */
  private conflictPolicy: ConflictPolicy

  private readonly tasks = new Map<string, Task>()
  private readonly locks = new Set<string>()
  private readonly timers = new Set<NodeJS.Timeout>()
  private readonly idleWaiters: Array<() => void> = []

  private running = 0
  private counter = 0
  private disposed = false
  private notifyTimer: NodeJS.Timeout | undefined

  constructor(private readonly options: QueueOptions) {
    this.session = options.session
    this.concurrency = Math.max(1, options.concurrency ?? 2)
    this.maxRetries = Math.max(0, options.maxRetries ?? 2)
    this.retryBaseMs = Math.max(10, options.retryBaseMs ?? 500)
    this.conflictPolicy = options.onConflict ?? 'fail'
  }

  enqueue(input: TransferTaskInput): string {
    this.counter += 1
    const id = `t${this.counter}`

    this.tasks.set(id, {
      id,
      direction: input.direction,
      localPath: input.localPath,
      remotePath: input.remotePath,
      label: input.label ?? (input.direction === 'upload' ? basename(input.localPath) : input.remotePath),
      status: 'queued',
      bytes: 0,
      totalBytes: input.sizeHint ?? null,
      bytesPerSecond: 0,
      attempt: 0,
      kind: input.kind ?? 'file',
      sizeHint: input.sizeHint,
      retries: 0,
      renames: 0,
      readyAt: 0,
      cleanupOnCancel: false
    })

    this.emit()
    this.pump()
    return id
  }

  /**
   * 取消任务。
   *
   * - `queued` → 直接从队列拿掉，返回 `removed`
   * - `running` → 触发 abort，**传输会真的停下来**；返回 `aborted`。
   *   已传的部分留在 `<目标>.part` 里，由调用方决定删不删（`cleanupOnCancel`）。
   * - 其它状态 → `not-found`
   *
   * 返回 Promise 是因为运行中的取消**必须等它真的停下**才能知道传了多少：
   * 传的是"下一次 step 回调之后"才更新的字节数。立刻返回一个数字会少报上千字节。
   */
  async cancel(id: string, cleanup = false): Promise<CancelOutcome> {
    const task = this.tasks.get(id)
    if (!task) return { result: 'not-found' }

    if (task.status === 'queued') {
      task.status = 'cancelled'
      this.emit()
      this.checkIdle()
      return { result: 'removed' }
    }

    if (task.status === 'running') {
      /*
       * **不能在这里直接把 status 改成 cancelled**：传输还在动，改了状态会让
       * `pump()` 以为槽位空了从而启动下一个任务，而实际的 SFTP 通道刚被 reset。
       * 等 `run()` 的 catch 把它标成 cancelled 再返回。
       */
      task.cleanupOnCancel = cleanup
      const settles = new Promise<void>((resolve) => {
        task.onSettled = resolve
      })
      task.abort?.abort()
      await settles
      return { result: 'aborted', bytesDone: task.bytes, partialPath: task.partialPath }
    }

    return { result: 'not-found' }
  }

  snapshot(): QueueSnapshot {
    const tasks = [...this.tasks.values()].map((task) => this.publicView(task))

    /**
     * 分母：所有任务的**预期大小**（跑完的用实际大小兜底）。
     */
    const totalBytes = tasks.reduce((sum, task) => sum + (task.totalBytes ?? task.bytes), 0)

    /**
     * 分子：已传输的字节。
     *
     * ⚠️ 这里原来只累加 `succeeded` / `skipped` 的任务，结果是
     * **只有正在传的那一个任务时进度永远是 0**：一个 187 MB 的文件传了 3 分钟，
     * 条子还是空的、右上角写 `0 B / 187 MB · 0%`，
     * 而同一行里的速度显示 678 KB/s——两个数字自相矛盾，用户只能以为卡死了。
     *
     * 正确口径是"已落地多少字节"，与任务是否**已经结束**无关：
     * - `running` → 用它实时的 `bytes`
     * - `succeeded` / `skipped` → 计入全部
     * - `failed` / `cancelled` → 那部分是**真的传输过又作废了**（失败会重试，
     *   `bytes` 已归零或保留的是最后一次的值）。不计入，否则进度会倒退。
     * - `queued` → 还没开始，`bytes` 为 0，自然不计
     *
     * `bytes` 在传输过程中由 `onProgress` 持续更新（queue.execute），
     * 而 `run()` 每次开始会把 `bytes` 归零，所以重试不会把进度累加两次。
     */
    const doneBytes = tasks
      .filter((task) => task.status === 'succeeded' || task.status === 'skipped' || task.status === 'running')
      .reduce((sum, task) => sum + (task.status === 'running' ? task.bytes : (task.totalBytes ?? task.bytes)), 0)

    return {
      tasks,
      running: this.running,
      queued: tasks.filter((task) => task.status === 'queued').length,
      finished: tasks.filter((task) => ['succeeded', 'failed', 'skipped', 'cancelled'].includes(task.status)).length,
      doneBytes: Math.min(doneBytes, totalBytes),
      totalBytes
    }
  }

  /** 队列清空时兑现；UI 用它关闭"传输中"状态 */
  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve()
    return new Promise<void>((resolve) => this.idleWaiters.push(resolve))
  }

  dispose(): void {
    this.disposed = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    if (this.notifyTimer) clearTimeout(this.notifyTimer)
  }

  /**
   * 换冲突策略。只影响之后开始的任务，已在跑的不变。
   * 用户在确认框里选"覆盖/跳过/改名"，走的就是这里。
   */
  setConflictPolicy(policy: ConflictPolicy): void {
    this.conflictPolicy = policy
  }

  private publicView(task: Task): TaskSnapshot {
    return {
      id: task.id,
      direction: task.direction,
      localPath: task.localPath,
      remotePath: task.remotePath,
      label: task.label,
      status: task.status,
      bytes: task.bytes,
      totalBytes: task.totalBytes,
      bytesPerSecond: task.bytesPerSecond,
      attempt: task.attempt,
      error: task.error
    }
  }

  /** 同一目标路径同时只能有一个任务 */
  private lockKey(task: Task): string {
    return task.direction === 'upload' ? `r:${task.remotePath}` : `l:${task.localPath}`
  }

  private pump(): void {
    if (this.disposed) return

    const now = Date.now()
    while (this.running < this.concurrency) {
      const next = [...this.tasks.values()].find(
        (task) => task.status === 'queued' && task.readyAt <= now && !this.locks.has(this.lockKey(task))
      )
      if (!next) break
      void this.run(next)
    }

    // 还有人在退避里等着，到点再叫一次
    const waiting = [...this.tasks.values()]
      .filter((task) => task.status === 'queued' && task.readyAt > now)
      .map((task) => task.readyAt - now)
    if (waiting.length > 0 && this.running < this.concurrency) {
      this.schedulePump(Math.min(...waiting))
    }

    this.checkIdle()
  }

  private schedulePump(delayMs: number): void {
    if (this.disposed) return
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      this.pump()
    }, Math.max(10, delayMs))
    this.timers.add(timer)
  }

  private async run(task: Task): Promise<void> {
    const key = this.lockKey(task)
    this.locks.add(key)
    this.running += 1
    task.status = 'running'
    task.attempt += 1
    task.bytes = 0
    task.bytesPerSecond = 0
    task.error = undefined
    task.partialPath = undefined
    // 每次尝试一个新开关：上一次取消不该影响这一次
    task.abort = new AbortController()
    this.emit()

    try {
      await this.execute(task)
      task.status = 'succeeded'
    } catch (err) {
      this.handleFailure(task, err)
    } finally {
      task.abort = undefined
      task.onSettled?.()
      task.onSettled = undefined
      this.locks.delete(key)
      this.running -= 1
      this.emit()
      this.pump()
    }
  }

  private async execute(task: Task): Promise<void> {
    const onProgress = (sample: { bytes: number; bytesPerSecond: number }): void => {
      task.bytes = sample.bytes
      task.bytesPerSecond = sample.bytesPerSecond
      this.emit()
    }
    const signal = task.abort?.signal

    // 目录走 tar：一次打包，保住目录结构，也避免逐文件往返
    if (task.kind === 'directory') {
      if (task.direction === 'download') {
        await downloadDirectory(this.session, {
          remoteDir: task.remotePath,
          localDir: task.localPath,
          onProgress,
          expectBytes: task.totalBytes ?? undefined
        })
      } else {
        await uploadDirectory(this.session, {
          localDir: task.localPath,
          remoteDir: task.remotePath,
          onProgress
        })
      }
      task.bytes = task.totalBytes ?? task.bytes
      return
    }

    // 先拿总字节，进度才有分母
    if (task.totalBytes === null) {
      if (task.direction === 'upload') {
        const info = await stat(task.localPath)
        task.totalBytes = info.size
      } else {
        task.totalBytes = (await remoteFileSize(this.session, task.remotePath)) ?? null
      }
    }

    const overwrite = this.conflictPolicy === 'overwrite'

    if (task.direction === 'upload') {
      await uploadFile(this.session, task.localPath, task.remotePath, { onProgress, overwrite, signal })
    } else {
      await downloadFile(this.session, task.remotePath, task.localPath, { onProgress, overwrite, signal })
    }

    task.bytes = task.totalBytes ?? task.bytes
  }

  /** 同步决策，不 await：退避期间要把锁让出去，不能让 run() 一直占着 */
  private handleFailure(task: Task, err: unknown): void {
    /*
     * 用户取消排在最前面：它既不是"冲突"也不是"可重试的故障"。
     * 必须在这一层拦掉，否则下面 `retryable` 分支会把一个取消的任务重新排队——
     * 用户点了取消，几秒后它自己又跑起来了，这是最典型的"按了没反应"。
     */
    if (isAbort(err)) {
      const partial = (err as SshErrorWithPartial).partial
      task.status = 'cancelled'
      task.partialPath = partial?.partialRemotePath ?? partial?.partialLocalPath
      task.error = { message: '已取消', retryable: false }
      task.bytesPerSecond = 0
      /*
       * 取消也要报"真实传了多少"。
       *
       * `task.bytes` 来自 `onProgress`（`ProgressMeter` 每 100 ms 才采样一次），
       * 取消那一刻它最多落后 100 ms；更糟的是 `cancel()` 返回的 `bytesDone`
       * 读的就是这个值，用户会看到"已传 8 MB"而文件其实就是 8 MB——
       * 因为他点了取消，但 ssh2 已经把手里那块写完了。
       * 所以这里把 partial 里记账的字节数（由传输层每次 `step` 更新，粒度是 chunk）
       * 兜底给 `task.bytes`，它至少不会比实际多。
       */
      if (partial && partial.bytesDone > task.bytes) task.bytes = partial.bytesDone
      // 清理是异步的（要发远端命令），不能在这里 await——见 queueCleanup
      if (task.cleanupOnCancel && task.partialPath) {
        this.queueCleanup(task)
      }
      return
    }

    if (isAlreadyExists(err)) {
      if (this.conflictPolicy === 'skip') {
        task.status = 'skipped'
        return
      }
      if (this.conflictPolicy === 'rename') {
        if (task.renames >= 20) {
          task.status = 'failed'
          task.error = { message: '改名 20 次仍然冲突，已放弃', retryable: false }
          return
        }
        task.renames += 1
        if (task.direction === 'upload') {
          task.remotePath = withSuffix(task.remotePath, task.renames, true)
        } else {
          task.localPath = withSuffix(task.localPath, task.renames, false)
        }
        task.status = 'queued'
        return
      }
      // fail / overwrite（overwrite 理论上不会走到这里）
      task.status = 'failed'
      task.error = toTaskError(err)
      return
    }

    const info = toTaskError(err)
    if (info.retryable && task.retries < this.maxRetries) {
      task.retries += 1
      task.status = 'queued'
      task.error = info
      task.readyAt = Date.now() + this.retryBaseMs * 2 ** (task.retries - 1)
      this.schedulePump(task.readyAt - Date.now() + 5)
      return
    }

    task.status = 'failed'
    task.error = info
  }

  /**
   * 删掉取消后留下的半截文件。
   *
   * 异步、失败不抛：这是一次"善后"，失败了只记在任务上，不能影响队列本身。
   * 上传要 `rm` 远端文件，下载要 `unlink` 本地文件，路径已经由传输层放进 `partial`。
   */
  private queueCleanup(task: Task): void {
    const path = task.partialPath
    if (!path) return

    void (async () => {
      try {
        if (task.direction === 'upload') {
          const sftp = await this.session.sftp()
          await new Promise<void>((resolve, reject) => {
            sftp.unlink(path, (err) => (err ? reject(err) : resolve()))
          })
        } else {
          await unlink(path)
        }
        // 删掉了就把路径清空——界面据此不再提示"还有个半截文件"
        task.partialPath = undefined
      } catch {
        // 删不掉（权限、文件已经不在）就算了，保留 partialPath 让用户自己看一眼
      } finally {
        this.emit()
      }
    })()
  }

  private isIdle(): boolean {
    const active = [...this.tasks.values()].some((task) => task.status === 'queued' || task.status === 'running')
    return !active && this.locks.size === 0
  }

  private checkIdle(): void {
    if (!this.isIdle()) return
    while (this.idleWaiters.length > 0) {
      const resolve = this.idleWaiters.shift()!
      resolve()
    }
  }

  /** 100ms 合并一次，别让进度把 IPC 打满 */
  private emit(): void {
    if (!this.options.onUpdate) return
    if (this.notifyTimer) return
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined
      if (this.disposed) return
      this.options.onUpdate?.(this.snapshot())
    }, 100)
  }
}
