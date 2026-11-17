/**
 * 传输服务：把「计划 → 确认 → 入队」串起来，并持有唯一的队列实例。
 *
 * 计划按 id 缓存 10 分钟：确认时直接取回，**不重新扫描**。
 * 大目录扫一次已经要几秒，让用户点"确认"再扫一遍是没必要的折磨。
 */
import { SshError } from '../ssh/errors'
import type { Session } from '../ssh/session'
import type { PlanRequest, TransferPlan } from './planner'
import { planTransfer } from './planner'
import type { CancelOutcome, ConflictPolicy, QueueSnapshot } from './queue'
import { TransferQueue } from './queue'

export interface TransferServiceDeps {
  /** 惰性取连接：只有真的要传的时候才建连 */
  getSession: () => Promise<Session>
  onUpdate?: (snapshot: QueueSnapshot) => void
}

const PLAN_TTL_MS = 10 * 60_000

export class TransferService {
  private readonly plans = new Map<string, TransferPlan>()
  private queue: TransferQueue | null = null

  constructor(private readonly deps: TransferServiceDeps) {}

  /** 扫描 + 推荐策略，返回给界面做确认框 */
  async plan(request: PlanRequest): Promise<TransferPlan> {
    if (request.paths.length === 0) {
      throw new SshError({ kind: 'config', message: '没有选中任何东西', raw: JSON.stringify(request) })
    }

    const session = await this.deps.getSession()
    const plan = await planTransfer(session, request)

    this.plans.set(plan.id, plan)
    this.prune()
    return plan
  }

  /** 用户点了确认之后才真正开始 */
  async start(planId: string, onConflict: ConflictPolicy = 'fail'): Promise<QueueSnapshot> {
    const plan = this.plans.get(planId)
    if (!plan) {
      throw new SshError({
        kind: 'config',
        message: '这个传输计划已经失效了',
        hint: '重新拖一次即可（计划只保留 10 分钟）。',
        raw: planId
      })
    }
    if (plan.items.length === 0) {
      throw new SshError({
        kind: 'config',
        message: '这个计划里没有能传输的条目',
        hint: plan.unsupported.map((item) => item.reason).join('；'),
        raw: JSON.stringify(plan.unsupported)
      })
    }

    // 覆盖一个目录 = 先 rm -rf 整个目录再传。代价太大，不给这个选项。
    if (onConflict === 'overwrite' && plan.items.some((item) => item.kind === 'dir')) {
      throw new SshError({
        kind: 'config',
        message: '目录不支持"覆盖"',
        hint:
          plan.direction === 'upload'
            ? '覆盖目录意味着先删掉远端整个目录，风险太大。请改选"跳过"或"改名"。'
            : '覆盖目录意味着先删掉本地整个目录，风险太大。请改选"跳过"或"改名"。',
        raw: plan.items.filter((item) => item.kind === 'dir').map((item) => item.target).join('\n')
      })
    }

    const session = await this.deps.getSession()

    // 队列跟着连接走：换了 session 就重建，避免拿着已断开的连接干活
    if (!this.queue) {
      this.queue = new TransferQueue({
        session,
        concurrency: 2,
        onUpdate: this.deps.onUpdate,
        onConflict
      })
    } else {
      this.queue.setConflictPolicy(onConflict)
    }

    for (const item of plan.items) {
      this.queue.enqueue({
        direction: plan.direction,
        kind: item.kind === 'dir' ? 'directory' : 'file',
        localPath: plan.direction === 'upload' ? item.source : item.target,
        remotePath: plan.direction === 'upload' ? item.target : item.source,
        label: item.name,
        sizeHint: item.stats.totalBytes
      })
    }

    this.plans.delete(planId)
    return this.queue.snapshot()
  }

  snapshot(): QueueSnapshot | null {
    return this.queue?.snapshot() ?? null
  }

  /**
   * 有没有正在跑或排队的任务。
   *
   * 切换跳板机前要问这一句：队列里那 187 MB 是挂在旧机器上的连接在传，
   * 换机器等于把它们全部作废。**宁可拒绝切换，也不要静默丢掉用户的数据。**
   */
  hasActive(): boolean {
    const snapshot = this.snapshot()
    if (!snapshot) return false
    return snapshot.running > 0 || snapshot.queued > 0
  }

  /**
   * 取消任务。
   *
   * `cleanup` 为 true 时连已经传上去的半截文件一起删掉（用户在确认框里选的）。
   * 排队中的任务不受影响——它从没开始过，磁盘上什么都没有。
   */
  async cancel(taskId: string, cleanup = false): Promise<CancelOutcome> {
    if (!this.queue) return { result: 'not-found' }
    return this.queue.cancel(taskId, cleanup)
  }

  private prune(): void {
    const cutoff = Date.now() - PLAN_TTL_MS
    for (const [id, plan] of this.plans) {
      if (plan.createdAt < cutoff) this.plans.delete(id)
    }
  }
}
