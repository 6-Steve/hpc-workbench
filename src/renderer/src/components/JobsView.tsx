import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { describeResources, formatAgo, formatDuration, formatTime } from '../lib/format'
import { JobLogDialog } from './JobLogDialog'
import { SubmitJobDialog } from './SubmitJobDialog'
import { Card, EmptyState, PageHeader, PageShell } from './ui'
import { describeGroup, groupIndex, groupJobs } from '../lib/job-groups'

/** 状态 → 样式和中文标签。中国用户习惯：绿色=正常，黄色=等待，红色=异常 */
const STATE_STYLE: Record<JobState, { label: string; className: string }> = {
  running: { label: '运行中', className: 'border-state-ok/25 bg-state-ok/[0.06] text-state-ok' },
  pending: { label: '排队中', className: 'border-state-wait/25 bg-state-wait/[0.06] text-state-wait' },
  configuring: { label: '启动中', className: 'border-state-info/25 bg-state-info/[0.05] text-state-info' },
  completing: { label: '收尾中', className: 'border-state-info/25 bg-state-info/[0.05] text-state-info' },
  suspended: { label: '已挂起', className: 'border-ink-200 bg-ink-50 text-ink-600' },
  requeued: { label: '重新排队', className: 'border-state-wait/25 bg-state-wait/[0.06] text-state-wait' },
  failed: { label: '失败', className: 'border-state-bad/25 bg-state-bad/[0.05] text-state-bad' },
  'node-fail': { label: '节点故障', className: 'border-state-bad/25 bg-state-bad/[0.05] text-state-bad' },
  'out-of-memory': { label: '内存超限', className: 'border-state-bad/25 bg-state-bad/[0.05] text-state-bad' },
  timeout: { label: '超时', className: 'border-state-bad/25 bg-state-bad/[0.05] text-state-bad' },
  cancelled: { label: '已取消', className: 'border-ink-200 bg-ink-50 text-ink-500' },
  completed: { label: '已完成', className: 'border-ink-200 bg-ink-50 text-ink-500' },
  preempted: { label: '被抢占', className: 'border-state-wait/25 bg-state-wait/[0.06] text-state-wait' },
  unknown: { label: '未知', className: 'border-ink-200 bg-ink-50 text-ink-500' }
}

/** 统一的错误展示：消息 + 建议 + 原始输出。原始输出必须能看，否则用户没法自救 */
function renderError(error: PlainError | null): JSX.Element | null {
  if (!error) return null
  return (
    <div className="mb-4 rounded-surface border border-state-bad/25 bg-state-bad/[0.06] px-4 py-3">
      <p className="selectable text-body font-medium text-state-bad">{error.message}</p>
      {error.hint && <p className="selectable mt-1 text-sub text-state-bad">→ {error.hint}</p>}
      {error.raw && (
        <pre className="selectable mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-surface/70 p-2 font-mono text-meta text-state-bad">
          {error.raw}
        </pre>
      )}
    </div>
  )
}

/** 自动刷新间隔（毫秒）。作业状态变化不频繁，5 秒足够又不至于一直发命令 */
const AUTO_REFRESH_MS = 5000

/**
 * 作业列表页。
 *
 * 这是「HPC 工作台」区别于普通文件管理器的核心：不登终端也能知道
 * 自己的作业在排队还是在跑、卡在什么原因上、要不要取消。
 */
export function JobsView({
  submitRequest = false,
  onSubmitRequestHandled,
  refreshKey = 0
}: {
  /**
   * "外面要求打开提交弹窗"（命令面板的「提交作业」）。
   *
   * 用**可消费的请求**而不是自增计数器：计数器的做法要靠"跳过首次渲染"
   * 来判断哪次是新的，而 React 的 StrictMode 会把 effect 立刻再跑一遍，
   * 第二次就绕过了那个守卫——表现是**每次点「作业」都会自动弹出提交表单**。
   * 请求由父组件置位、本组件消费后清掉，重复执行也不会有副作用。
   */
  submitRequest?: boolean
  /** 消费掉请求，父组件把标志清回 false */
  onSubmitRequestHandled?: () => void
  /**
   * 变了就整份重拉（含历史）。切换跳板机时由 App 递增。
   *
   * 用计数器而不是布尔：切换可能发生多次，布尔只能触发一次。
   */
  refreshKey?: number
} = {}): JSX.Element {
  const [jobs, setJobs] = useState<Job[] | null>(null)
  /** 按批次合并（默认关：同名不同批会被合到一起，那比不合更误导） */
  const [mergeGroups, setMergeGroups] = useState(false)
  /** 折叠了哪些批次 */
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<PlainError | null>(null)
  const [loading, setLoading] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [cancelling, setCancelling] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // —— 历史（sacct）——
  const [mode, setMode] = useState<'current' | 'history'>('current')
  const [history, setHistory] = useState<JobHistory[] | null>(null)
  const [historyError, setHistoryError] = useState<PlainError | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  /** 要看日志的作业 */
  const [logJob, setLogJob] = useState<{ id: string; name: string; workDir: string | null } | null>(null)

  /** 防止"上一次还没回来就发下一次"，自动刷新很容易踩这个 */
  const inFlight = useRef(false)

  // 命令面板让我打开提交弹窗。没有请求时什么都不做
  useEffect(() => {
    if (!submitRequest) return
    setSubmitting(true)
    onSubmitRequestHandled?.()
  }, [submitRequest, onSubmitRequestHandled])

  const load = useCallback(async (silent = false): Promise<void> => {
    if (inFlight.current) return
    inFlight.current = true
    if (!silent) setLoading(true)

    try {
      const response = await window.hpc.listJobs()
      if (response.ok && response.jobs) {
        setJobs(response.jobs)
        setError(null)
        setLastUpdated(Date.now())
      } else {
        setError(response.error ?? { kind: 'ipc', message: '没有拿到作业列表', raw: JSON.stringify(response) })
      }
    } catch (err) {
      setError({ kind: 'ipc', message: '查询作业失败', hint: '看开发终端日志。', raw: String(err) })
    } finally {
      inFlight.current = false
      setLoading(false)
    }
  }, [])

  const loadHistory = useCallback(async (): Promise<void> => {
    setHistoryLoading(true)
    setHistoryError(null)
    try {
      const response = await window.hpc.listJobHistory({ days: 7 })
      if (response.ok && response.jobs) {
        // sacct 按作业号升序给，这里倒过来，最近的排最上面
        const sorted = [...response.jobs].sort((a, b) => Number(b.id) - Number(a.id))
        setHistory(sorted)
      } else {
        setHistoryError(response.error ?? { kind: 'ipc', message: '没有拿到历史作业', raw: JSON.stringify(response) })
      }
    } catch (err) {
      setHistoryError({ kind: 'ipc', message: '查询历史作业失败', raw: String(err) })
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  useEffect(() => {
    // 切了跳板机：旧的作业列表属于另一台机器，先清空再去拉。
    // 不清空的话，新机器的数据回来之前会一直显示旧机器的工作业——那是假信息。
    setJobs(null)
    setHistory(null)
    setError(null)
    setHistoryError(null)
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, refreshKey])

  // 切到历史才去查——sacct 比 squeue 慢，没必要一进页面就发
  useEffect(() => {
    if (mode === 'history' && history === null) void loadHistory()
  }, [mode, history, loadHistory])

  useEffect(() => {
    if (!autoRefresh) return
    const timer = window.setInterval(() => void load(true), AUTO_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [autoRefresh, load])

  const cancelJob = useCallback(
    async (job: Job): Promise<void> => {
      setCancelling(job.id)
      setNotice(null)
      try {
        const response = await window.hpc.cancelJob(job.id)
        if (response.ok) {
          setNotice(`已取消作业 ${job.id}`)
          await load(true)
        } else {
          setError(response.error ?? { kind: 'ipc', message: '取消失败', raw: JSON.stringify(response) })
        }
      } finally {
        setCancelling(null)
      }
    },
    [load]
  )

  const running = (jobs ?? []).filter((job) => job.state === 'running').length
  const pending = (jobs ?? []).filter((job) => job.state === 'pending').length

  /** 合并后的批次。历史页不做（sacct 是七天流水，按批看没有意义） */
  const groups = useMemo(
    () => (mode === 'current' && mergeGroups ? groupJobs(jobs ?? [], { enabled: true }) : []),
    [jobs, mergeGroups, mode]
  )
  const groupOf = useMemo(() => groupIndex(groups), [groups])

  /** 折叠的批次不参与列表渲染 */
  const visibleJobs = useMemo(() => {
    const all = jobs ?? []
    if (groups.length === 0) return all
    return all.filter((job) => {
      const info = groupOf.get(job.id)
      return info ? !collapsedGroups[info.group.id] : true
    })
  }, [jobs, groups, groupOf, collapsedGroups])

  return (
    <PageShell>
      <PageHeader
        title="作业"
        description={
          mode === 'current'
            ? jobs === null
              ? '正在读取…'
              : `${jobs.length} 个作业${running > 0 ? ` · ${running} 个在跑` : ''}${
                  pending > 0 ? ` · ${pending} 个排队` : ''
                }`
            : history === null
              ? '正在读取…'
              : `最近 7 天 ${history.length} 个作业`
        }
        aside={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSubmitting(true)}
              className="rounded-surface bg-inverse px-3 py-1.5 text-body font-medium text-white transition hover:bg-ink-800"
            >
              提交作业
            </button>

            {mode === 'current' ? (
              <>
                <label className="flex cursor-pointer items-center gap-1.5 text-sub text-ink-500">
                  <input
                    type="checkbox"
                    checked={autoRefresh}
                    onChange={(event) => setAutoRefresh(event.target.checked)}
                    className="h-3 w-3 accent-ink-700"
                  />
                  每 5 秒自动刷新
                </label>
                <button
                  type="button"
                  onClick={() => void load()}
                  disabled={loading}
                  className="rounded-surface border border-ink-200 bg-surface px-3 py-1.5 text-body text-ink-700 transition hover:bg-ink-50 disabled:opacity-50"
                >
                  {loading ? '刷新中…' : '刷新'}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => void loadHistory()}
                disabled={historyLoading}
                className="rounded-surface border border-ink-200 bg-surface px-3 py-1.5 text-body text-ink-700 transition hover:bg-ink-50 disabled:opacity-50"
              >
                {historyLoading ? '刷新中…' : '刷新'}
              </button>
            )}
          </div>
        }
      />

      {/* 当前队列 / 历史 切换 */}
      <div className="mb-4 flex gap-1 rounded-surface bg-ink-100/70 p-0.5">
        {(
          [
            { id: 'current' as const, label: '当前队列' },
            { id: 'history' as const, label: '历史（7 天）' }
          ]
        ).map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setMode(item.id)}
            className={
              'rounded-control px-3 py-1 text-body transition ' +
              (mode === item.id ? 'bg-surface font-medium text-ink-900 shadow-card' : 'text-ink-500 hover:text-ink-700')
            }
          >
            {item.label}
          </button>
        ))}
      </div>

      {mode === 'current' ? (
        <>
          {lastUpdated && <p className="mb-3 text-sub text-ink-300">{formatAgo(lastUpdated / 1000)}更新</p>}

          <label className="mb-2 flex items-center gap-1.5 text-sub text-ink-600">
            <input
              type="checkbox"
              checked={mergeGroups}
              onChange={(event) => setMergeGroups(event.target.checked)}
            />
            按批次合并
            <span className="text-meta text-ink-500">（同名 + 同分区 + 提交间隔 30 分钟内）</span>
          </label>

          {mergeGroups && groups.length > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              {groups.map((group) => {
                const collapsed = collapsedGroups[group.id] === true
                const failed = group.counts.failed > 0
                return (
                  <button
                    key={group.id}
                    type="button"
                    onClick={() =>
                      setCollapsedGroups((prev) => ({ ...prev, [group.id]: !collapsed }))
                    }
                    title={collapsed ? '展开这一批' : '折叠这一批'}
                    className={
                      'rounded-control border px-2 py-1 text-meta transition ' +
                      (collapsed
                        ? 'border-ink-200 bg-ink-50 text-ink-500 hover:bg-ink-100'
                        : failed
                          ? 'border-state-bad/25 bg-state-bad/[0.06] text-ink-800 hover:bg-state-bad/[0.1]'
                          : 'border-state-ok/25 bg-state-ok/[0.06] text-ink-800 hover:bg-state-ok/[0.1]')
                    }
                  >
                    <span className="text-ink-500">{collapsed ? '▸' : '▾'}</span>
                    <span className="ml-1 font-mono">{group.name}</span>
                    <span className="ml-1.5 font-mono tabular-nums">{describeGroup(group)}</span>
                  </button>
                )
              })}
            </div>
          )}
          {renderError(error)}
          {notice && (
            <p className="mb-4 rounded-surface border border-state-ok/25 bg-state-ok/[0.06] px-4 py-2 text-body text-state-ok">
              {notice}
            </p>
          )}

          {jobs !== null && jobs.length === 0 && !error && (
            <Card title="队列">
              <EmptyState
                title="队列是空的"
                hint={
                  <>
                    现在没有排队或运行中的作业。提交一个之后它会出现在这里。如果刚刚提交过却看不到，
                    检查一下提交时是不是用了别的账号——这里只查当前登录用户的作业（
                    <code className="font-mono text-sub">squeue --me</code>）。
                  </>
                }
              />
            </Card>
          )}

          {jobs !== null && jobs.length > 0 && (
            <div className="overflow-hidden rounded-surface border border-ink-200/80 bg-surface shadow-card">
              <div className="flex items-center gap-3 border-b border-ink-100 px-4 py-2 text-meta uppercase tracking-wide text-ink-500">
                <span className="w-16 shrink-0">作业号</span>
                <span className="min-w-0 flex-1">名称</span>
                <span className="w-20 shrink-0">状态</span>
                <span className="w-20 shrink-0">分区</span>
                <span className="w-28 shrink-0">资源</span>
                <span className="w-24 shrink-0">时限</span>
                <span className="w-28 shrink-0 text-right">操作</span>
              </div>

              {visibleJobs.map((job) => {
                const style = STATE_STYLE[job.state]
                const canCancel =
                  job.state === 'pending' || job.state === 'running' || job.state === 'configuring'

                return (
                  <div
                    key={job.id}
                    className="flex items-center gap-3 border-b border-ink-50 px-4 py-2 text-body last:border-b-0 hover:bg-ink-50/40"
                  >
                    <span className="w-16 shrink-0 font-mono text-sub text-ink-500">{job.id}</span>

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-ink-800" title={job.name}>
                        {job.name}
                      </p>
                      {/* 排队原因是最容易让人困惑的地方：用一句人话说明为什么还没跑 */}
                      <p className="truncate text-sub text-ink-500">
                        {job.state === 'running' && job.nodes ? `跑在 ${job.nodes}` : job.reasonText}
                        {/* 排队中的作业，squeue 会给出预计开始时间（调度器的最佳猜测） */}
                        {job.state === 'pending'
                          ? job.startTime && job.startTime * 1000 > Date.now()
                            ? `　·　预计 ${formatTime(job.startTime * 1000)} 启动`
                            : job.heldByUser
                              ? ''
                              : '　·　暂无启动预测'
                          : ''}
                        {job.submitTime ? `　·　提交于 ${formatAgo(job.submitTime)}` : ''}
                      </p>
                    </div>

                    <span className="w-20 shrink-0">
                      <span
                        className={`inline-flex rounded-control border px-1.5 py-0.5 text-meta font-medium ${style.className}`}
                      >
                        {style.label}
                      </span>
                    </span>

                    <span className="w-20 shrink-0 truncate text-ink-600">{job.partition || '—'}</span>

                    <span className="w-28 shrink-0 font-mono text-sub text-ink-500">
                      {describeResources(job.nodeCount, job.cpus, job.gpusRequested)}
                    </span>

                    <span className="w-24 shrink-0 text-sub text-ink-500">
                      {formatDuration(job.timeLimitMinutes)}
                    </span>

                    <span className="w-28 shrink-0 text-right">
                      <div className="flex items-center justify-end gap-1">
                        {/*
                          运行中的作业也能看日志了：squeue 不给工作目录，
                          但 scontrol show job --json 给精确的 standard_output。
                        */}
                        <button
                          type="button"
                          onClick={() => setLogJob({ id: job.id, name: job.name, workDir: null })}
                          className="rounded border border-ink-200 bg-surface px-1.5 py-0.5 text-meta text-state-info transition hover:border-state-info/25 hover:bg-state-info/[0.05]"
                        >
                          看
                        </button>
                        {canCancel ? (
                          <button
                            type="button"
                            onClick={() => void cancelJob(job)}
                            disabled={cancelling === job.id}
                            className="rounded border border-ink-200 bg-surface px-1.5 py-0.5 text-meta text-state-bad transition hover:border-state-bad/25 hover:bg-state-bad/[0.05] disabled:opacity-50"
                          >
                            {cancelling === job.id ? '取消中…' : '取消'}
                          </button>
                        ) : (
                          <span className="px-1.5 text-meta text-ink-300">—</span>
                        )}
                      </div>
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </>
      ) : (
        <>
          {renderError(historyError)}

          {history !== null && history.length === 0 && !historyError && (
            <Card title="历史">
              <EmptyState
                title="最近 7 天没有作业记录"
                hint={
                  <>
                    跑过作业之后，这里会留下记录。数据来自{' '}
                    <code className="font-mono text-sub">sacct</code>；如果集群没开记账服务，
                    这里会是空的，但当前队列不受影响。
                  </>
                }
              />
            </Card>
          )}

          {history !== null && history.length > 0 && (
            <div className="overflow-hidden rounded-surface border border-ink-200/80 bg-surface shadow-card">
              <div className="flex items-center gap-3 border-b border-ink-100 px-4 py-2 text-meta uppercase tracking-wide text-ink-500">
                <span className="w-16 shrink-0">作业号</span>
                <span className="min-w-0 flex-1">名称</span>
                <span className="w-20 shrink-0">状态</span>
                <span className="w-28 shrink-0">开始时间</span>
                <span className="w-20 shrink-0">耗时</span>
                <span className="w-24 shrink-0">资源</span>
                <span className="w-14 shrink-0 text-right">退出码</span>
                <span className="w-14 shrink-0 text-right">日志</span>
              </div>

              {history.map((job) => {
                const style = STATE_STYLE[job.state]
                return (
                  <div
                    key={job.id}
                    className="flex items-center gap-3 border-b border-ink-50 px-4 py-2 text-body last:border-b-0 hover:bg-ink-50/40"
                  >
                    <span className="w-16 shrink-0 font-mono text-sub text-ink-500">{job.id}</span>

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-ink-800" title={job.name}>
                        {job.name}
                      </p>
                      <p className="truncate text-sub text-ink-500">
                        {job.nodes ? `${job.nodes}` : job.partition || '—'}
                        {job.stateReason ? `　·　${job.stateReason}` : ''}
                      </p>
                      {/* 这条很重要：状态失败但退出码是 0，说明失败在 batch 脚本里，sacct 看不出根因 */}
                      {job.exitCodeMisleading && (
                        <p className="mt-0.5 truncate text-sub text-state-wait">
                          退出码是 0 但状态是失败 —— 通常是脚本里某条命令挂了，去看 .out 日志
                        </p>
                      )}
                      {job.state === 'failed' && job.exitReturnCode === 2 && (
                        <p className="mt-0.5 truncate text-sub text-state-wait">
                          退出码 2 —— 多半是命令里引用的文件不存在（比如 python xxx.py 找不到那个脚本），去看 .out
                        </p>
                      )}
                    </div>

                    <span className="w-20 shrink-0">
                      <span
                        className={`inline-flex rounded-control border px-1.5 py-0.5 text-meta font-medium ${style.className}`}
                      >
                        {style.label}
                      </span>
                    </span>

                    <span className="w-28 shrink-0 font-mono text-sub text-ink-500">
                      {formatTime(job.startTime ? job.startTime * 1000 : null)}
                    </span>

                    <span className="w-20 shrink-0 text-sub text-ink-500">
                      {job.elapsedSeconds === null ? '—' : formatDuration(job.elapsedSeconds / 60)}
                    </span>

                    <span className="w-24 shrink-0 font-mono text-sub text-ink-500">
                      {describeResources(job.nodeCount, job.cpus, job.gpus)}
                    </span>

                    <span className="w-14 shrink-0 text-right font-mono text-sub text-ink-500">
                      {job.exitReturnCode ?? '—'}
                    </span>

                    <span className="w-14 shrink-0 text-right">
                      <button
                        type="button"
                        onClick={() => setLogJob({ id: job.id, name: job.name, workDir: job.workDir })}
                        className="rounded border border-ink-200 bg-surface px-1.5 py-0.5 text-meta text-state-info transition hover:border-state-info/25 hover:bg-state-info/[0.05]"
                      >
                        看
                      </button>
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}

    {logJob && (
      <JobLogDialog
        jobId={logJob.id}
        jobName={logJob.name}
        workDir={logJob.workDir}
        onClose={() => setLogJob(null)}
      />
    )}

    {submitting && (
      <SubmitJobDialog
        onClose={() => setSubmitting(false)}
        onSubmitted={(jobId) => {
          setSubmitting(false)
          setNotice(`已提交，作业号 ${jobId}`)
          setMode('current')
          void load(true)
        }}
      />
    )}
    </PageShell>
  )
}
