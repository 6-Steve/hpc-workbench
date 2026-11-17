/**
 * 连接池：一个 profile 只保持一条 TCP 连接，所有操作共享。
 *
 * 为什么不每次新建连接：SSH 握手要 3-5 次往返，30 ms RTT 下就是 150 ms 纯等待。
 * 用户连点五个目录，不复用就白等 750 ms。
 *
 * 断线策略：懒重连。连接一断就从表里摘掉，下一次 acquire 重新建；
 * 已经发出去的操作失败且错误可重试时，自动重建并重放一次。
 */
import type { ResolvedProfile } from '../profiles'
import type { TraceInput } from '../../shared/trace'
import { normalizeSshError } from './errors'
import type { KnownHostsStore } from './known-hosts'
import { Session } from './session'

export interface PoolOptions {
  knownHosts?: KnownHostsStore
  onLog?: (message: string) => void
  /** 每条命令执行完都会回调一次，给「命令记录」用；见 SessionOptions.onTrace */
  onTrace?: (input: TraceInput) => void
  /** 重连前的等待，默认 300 ms，给网络抖动一点恢复时间 */
  retryDelayMs?: number
}

interface Entry {
  session?: Session
  pending?: Promise<Session>
}

export interface PoolSnapshot {
  profileId: string
  alive: boolean
}

export class ConnectionPool {
  private readonly entries = new Map<string, Entry>()
  private readonly options: PoolOptions
  private disposed = false

  constructor(options: PoolOptions = {}) {
    this.options = options
  }

  /** 拿到可用连接；复用、去重并发建连、断线重建都在这里 */
  async acquire(profile: ResolvedProfile): Promise<Session> {
    if (this.disposed) throw new Error('连接池已关闭')

    const entry = this.entries.get(profile.id) ?? {}
    this.entries.set(profile.id, entry)

    if (entry.session?.isAlive) return entry.session
    if (entry.pending) return entry.pending

    const pending = Session.open(profile, {
      knownHosts: this.options.knownHosts,
      onLog: this.options.onLog,
      onTrace: this.options.onTrace
    })
    entry.pending = pending

    try {
      const session = await pending
      entry.session = session
      session.onClose(() => {
        const current = this.entries.get(profile.id)
        // 只有"连接自己掉了"才值得说一声；我们主动 close / invalidate 时表里已经没有它了
        const unexpected = current?.session === session
        if (unexpected) this.entries.delete(profile.id)
        if (unexpected && !this.disposed) this.options.onLog?.(`与 ${profile.host} 的连接已关闭`)
      })
      return session
    } finally {
      if (entry.pending === pending) entry.pending = undefined
    }
  }

  /**
   * 在连接上跑一段逻辑，连接级错误自动重连重放一次。
   * 注意：只对"连接挂了"这类可重试错误重放，业务错误（命令非 0 退出）不重放。
   */
  async run<T>(profile: ResolvedProfile, fn: (session: Session) => Promise<T>): Promise<T> {
    const attempt = async (): Promise<T> => {
      const session = await this.acquire(profile)
      return fn(session)
    }

    try {
      return await attempt()
    } catch (err) {
      const normalized = normalizeSshError(err)
      if (!normalized.retryable || this.disposed) throw normalized

      this.options.onLog?.(`连接异常（${normalized.kind}），重连后重试一次`)
      this.invalidate(profile.id)
      await delay(this.options.retryDelayMs ?? 300)
      return attempt()
    }
  }

  /** 强制丢弃某个 profile 的连接，下次 acquire 会重建 */
  invalidate(profileId: string): void {
    const entry = this.entries.get(profileId)
    if (!entry) return
    this.entries.delete(profileId)
    void entry.session?.close()
  }

  async close(profileId: string): Promise<void> {
    const entry = this.entries.get(profileId)
    if (!entry) return
    this.entries.delete(profileId)
    await entry.session?.close()
  }

  /**
   * 切换跳板机：把"旧机器"和"将来要用的机器"的连接都丢掉。
   *
   * 两条都要丢的理由不一样：
   * - 旧 id：它现在是死的配置，留着只是占着一条 SSH 连接（服务端也算 MaxSessions）
   * - 新 id：**它可能还挂着一条陈旧连接**。用户切回 02 是因为 01 卡了，
   *   如果 02 上有一条十分钟前就半死的连接，复用它等于把卡顿带过来
   *
   * 返回真正关掉的连接条数，界面要据此告诉用户"断了 N 条连接"。
   */
  async drop(...profileIds: string[]): Promise<number> {
    let closed = 0
    for (const id of profileIds) {
      const entry = this.entries.get(id)
      if (!entry) continue
      this.entries.delete(id)
      closed += 1
      await entry.session?.close()
    }
    return closed
  }

  async closeAll(): Promise<void> {
    this.disposed = true
    const sessions = [...this.entries.values()].map((e) => e.session).filter((s): s is Session => !!s)
    this.entries.clear()
    await Promise.allSettled(sessions.map((s) => s.close()))
  }

  snapshot(): PoolSnapshot[] {
    return [...this.entries.entries()].map(([profileId, entry]) => ({
      profileId,
      alive: entry.session?.isAlive ?? false
    }))
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
