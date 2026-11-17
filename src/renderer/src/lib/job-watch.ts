/**
 * 从两次作业快照的差集里判断"发生了什么"。
 *
 * 这三个事件是"提交完就去干别的"时唯一需要知道的事：
 * - **开始跑了**：等着的作业终于上机
 * - **结束了**：跑完或被终止，需要去看结果（具体成功还是失败要再查一次）
 * - **还没跑就没了**：排队中被取消 / 被抢占，用户可能压根不知道
 *
 * 刻意**不通知"新出现的作业"**：那是用户自己刚提交的，界面已经弹过提示，
 * 再来一条"作业 211291 已提交"只是噪音。
 *
 * 状态用 `string` 而不是全局的 `JobState`：这个模块要能在 node 侧编译跑单测，
 * 而 `JobState` 声明在 `src/preload/index.d.ts` 里，node 侧看不见。
 */

export interface JobWatchEntry {
  id: string
  name: string
  /** 规范化后的状态字符串，只和 'pending' / 'running' 之类的字面量比较 */
  state: string
}

export type JobWatchEventKind = 'started' | 'finished' | 'dropped'

export interface JobWatchEvent {
  kind: JobWatchEventKind
  jobId: string
  jobName: string
  /** 事件发生前它是什么状态，用来把话说清楚 */
  fromState: string
}

/** 这些状态都算"已经上机了"，其中任何一个消失都按"结束"处理 */
const RAN_STATES = new Set(['running', 'completing'])

/** 这些状态算"还没上机"，消失就是没跑成 */
const WAITING_STATES = new Set(['pending', 'configuring', 'suspended'])

/**
 * @param previous 上一次的快照；null 表示第一次拿到数据（此时不产生任何事件，
 *                 否则一启动就会把当前队列里的作业全报一遍）
 */
export function diffJobSnapshots(
  previous: JobWatchEntry[] | null,
  next: JobWatchEntry[]
): JobWatchEvent[] {
  if (previous === null) return []

  const previousById = new Map(previous.map((job) => [job.id, job]))
  const nextById = new Map(next.map((job) => [job.id, job]))
  const events: JobWatchEvent[] = []

  // 1. 还在队列里的：看有没有从"等"变成"跑"
  for (const [id, current] of nextById) {
    const before = previousById.get(id)
    if (!before) continue // 新出现的作业，不通知
    if (current.state === before.state) continue

    const wasWaiting = WAITING_STATES.has(before.state)
    const nowRunning = RAN_STATES.has(current.state)
    if (wasWaiting && nowRunning) {
      events.push({ kind: 'started', jobId: id, jobName: current.name, fromState: before.state })
    }
  }

  // 2. 从队列里消失的：squeue 只列活跃作业，消失就是结束了
  for (const [id, before] of previousById) {
    if (nextById.has(id)) continue

    if (RAN_STATES.has(before.state)) {
      events.push({ kind: 'finished', jobId: id, jobName: before.name, fromState: before.state })
    } else if (WAITING_STATES.has(before.state)) {
      // 排队中直接没了的两种常见原因：用户自己 scancel、或者被抢占
      events.push({ kind: 'dropped', jobId: id, jobName: before.name, fromState: before.state })
    }
  }

  // 作业号大的排前面：新作业更可能是用户此刻关心的
  events.sort((a, b) => Number(b.jobId) - Number(a.jobId))
  return events
}
