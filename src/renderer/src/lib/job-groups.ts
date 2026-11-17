/**
 * 把同一批提交的作业合成一组。
 *
 * ## 真正的收益不是"折叠"，是**通知降噪**
 *
 * 一次实验交 30 个 job，`squeue` 里就是 30 行，跑完还会弹 30 条通知。
 * 折叠只是视觉上的缓解；把"30 条推送"变成"1 条汇总"才是每天都能感觉到的。
 *
 * ## 规则刻意保守
 *
 * 三条全满足才算一组：**同名 + 同分区 + 相邻提交间隔 ≤ 30 分钟**。
 * 为什么默认关闭：同名不同批（每天跑一次 `eval`）会被合到一起，那比不合并更误导。
 * 用户显式打开，说明他知道自己这批是怎么交的。
 */
export interface GroupableJob {
  id: string
  name: string
  partition: string
  state: string
  submitTime: number | null
}

export interface JobGroupCounts {
  total: number
  running: number
  pending: number
  /** 正常结束 + 被取消（取消不算失败） */
  done: number
  failed: number
}

export interface JobGroup<T extends GroupableJob = GroupableJob> {
  /** 稳定 id：`g:<name>:<首个提交秒>`。随机 id 会让组在每次刷新后重排 */
  id: string
  name: string
  partition: string
  jobs: T[]
  counts: JobGroupCounts
  firstSubmit: number
}

export const GROUP_WINDOW_MINUTES = 30

function isFailed(state: string): boolean {
  return (
    state === 'failed' ||
    state === 'timeout' ||
    state === 'node-fail' ||
    state === 'out-of-memory' ||
    state === 'preempted'
  )
}

function isDone(state: string): boolean {
  return state === 'completed' || state === 'cancelled'
}

function isPending(state: string): boolean {
  return state === 'pending' || state === 'requeued'
}

function isRunning(state: string): boolean {
  return state === 'running' || state === 'completing' || state === 'configuring' || state === 'suspended'
}

/**
 * 分组。`enabled: false` 时每个作业各成一组（组数 = 作业数），
 * 界面用 `enabled` 决定要不要画组头，这里不返回 null 省得调用方到处判空。
 */
export function groupJobs<T extends GroupableJob>(
  jobs: readonly T[],
  options: { enabled: boolean; windowMinutes?: number }
): Array<JobGroup<T>> {
  const windowMs = (options.windowMinutes ?? GROUP_WINDOW_MINUTES) * 60_000

  // 先按提交时间排（没有时间的排最后），再按 id 数值序，保证同批内部顺序稳定
  const sorted = [...jobs].sort((a, b) => {
    const at = a.submitTime ?? Number.MAX_SAFE_INTEGER
    const bt = b.submitTime ?? Number.MAX_SAFE_INTEGER
    if (at !== bt) return at - bt
    return Number(a.id) - Number(b.id) || a.id.localeCompare(b.id)
  })

  if (!options.enabled) {
    return sorted.map((job) => makeGroup([job], job.submitTime ?? 0))
  }

  const groups: Array<JobGroup<T>> = []
  let open: T[] | null = null
  let openKey = ''
  let lastSubmit = 0

  const flush = (): void => {
    if (open && open.length > 0) groups.push(makeGroup(open, open[0]!.submitTime ?? 0))
    open = null
  }

  for (const job of sorted) {
    const key = `${job.name}\u0000${job.partition}`
    const at = job.submitTime ?? Number.MAX_SAFE_INTEGER
    const continues = open !== null && key === openKey && at - lastSubmit <= windowMs

    if (!continues) {
      flush()
      open = [job]
      openKey = key
      lastSubmit = at
      continue
    }

    open!.push(job)
    lastSubmit = at
  }
  flush()

  return groups
}

function makeGroup<T extends GroupableJob>(jobs: T[], firstSubmit: number): JobGroup<T> {
  const counts: JobGroupCounts = { total: jobs.length, running: 0, pending: 0, done: 0, failed: 0 }
  for (const job of jobs) {
    if (isFailed(job.state)) counts.failed += 1
    else if (isDone(job.state)) counts.done += 1
    else if (isPending(job.state)) counts.pending += 1
    else if (isRunning(job.state)) counts.running += 1
  }

  const head = jobs[0]!
  return {
    id: `g:${head.name}:${Math.floor(firstSubmit / 1000)}`,
    name: head.name,
    partition: head.partition,
    jobs: [...jobs],
    counts,
    firstSubmit
  }
}

/** 作业 id → 它属于哪一组、以及是不是组里第一个（第一个前面要画组头） */
export function groupIndex<T extends GroupableJob>(
  groups: ReadonlyArray<JobGroup<T>>
): Map<string, { group: JobGroup<T>; isFirst: boolean }> {
  const index = new Map<string, { group: JobGroup<T>; isFirst: boolean }>()
  for (const group of groups) {
    group.jobs.forEach((job, position) => {
      index.set(job.id, { group, isFirst: position === 0 })
    })
  }
  return index
}

/** 一句话概括，组头和通知都用它 */
export function describeGroup(group: JobGroup): string {
  const parts = [`${group.counts.done}/${group.counts.total} 完成`]
  if (group.counts.failed > 0) parts.push(`${group.counts.failed} 失败`)
  if (group.counts.running > 0) parts.push(`${group.counts.running} 运行中`)
  if (group.counts.pending > 0) parts.push(`${group.counts.pending} 排队`)
  return parts.join(' · ')
}
