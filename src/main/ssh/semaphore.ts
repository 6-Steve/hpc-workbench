/**
 * 计数信号量：限制同一连接上的并发 exec 通道数。
 *
 * 为什么要限：SSH 每个 exec 占一个 channel，服务端 MaxSessions 默认 10，
 * 超了直接 `channel open failure`，错误信息很不直观（docs/04 E5）。
 */
export class Semaphore {
  private readonly limit: number
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`Semaphore 的 limit 必须是正整数，收到 ${limit}`)
    }
    this.limit = limit
  }

  get inFlight(): number {
    return this.active
  }

  get waiting(): number {
    return this.waiters.length
  }

  /** 拿到一个名额，返回释放函数（幂等） */
  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1
    } else {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
      // 被唤醒时名额已经从"前任持有者"手里转交过来，不再 +1
    }

    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiters.shift()
      if (next) {
        next()
      } else {
        this.active -= 1
      }
    }
  }

  /** 包一层：保证异常路径也会释放 */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire()
    try {
      return await fn()
    } finally {
      release()
    }
  }
}
