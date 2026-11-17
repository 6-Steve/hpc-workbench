import { useCallback, useEffect, useState } from 'react'
import { explainIpcError, formatPlainError, stalePreloadError } from '../lib/preload'

interface NodeJobsDialogProps {
  nodeName: string
  /** 这台机器的总核数，用来算"占了多少" */
  cpuTotal: number
  onClose: () => void
}

/**
 * 「这台机器上谁在用」独立弹框。
 *
 * 为什么不做行内展开：型号卡片是 2–3 列的网格，宽度只有两三百像素，
 * 塞进"作业号 / 用户 / 核数 / 作业名 / 结束时间"这一串必然被截断。
 * 与其缩字号硬塞，不如开个正经窗口。
 */
export function NodeJobsDialog({ nodeName, cpuTotal, onClose }: NodeJobsDialogProps): JSX.Element {
  const [jobs, setJobs] = useState<NodeJob[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setJobs(null)
    setError(null)

    if (typeof window.hpc?.listNodeJobs !== 'function') {
      setError(formatPlainError(stalePreloadError('查这台机器的占用')))
      return
    }

    try {
      const response = await window.hpc.listNodeJobs({ nodeName })
      if (response.ok) {
        setJobs(response.jobs ?? [])
      } else {
        setError(
          [response.error?.message, response.error?.hint, response.error?.raw].filter(Boolean).join(' · ') ||
            '查询失败，但没有返回原因'
        )
      }
    } catch (err) {
      setError(formatPlainError(explainIpcError(err, '查这台机器的占用')))
    }
  }, [nodeName])

  useEffect(() => {
    void load()
  }, [load])

  const usedCpus = (jobs ?? []).reduce((sum, job) => sum + job.cpus, 0)
  const overLimit = usedCpus > cpuTotal && cpuTotal > 0

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-inverse/25 px-6"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
    >
      <div className="flex max-h-[80vh] w-full max-w-[620px] flex-col overflow-hidden rounded-surface border border-ink-200 bg-surface shadow-pop">
        <header className="relative shrink-0 border-b border-ink-100 px-5 py-3 pr-12">
          <h2 className="text-emph font-semibold text-ink-900">
            <span className="font-mono">{nodeName}</span> 上正在跑的作业
          </h2>
          <p className="mt-0.5 text-sub text-ink-500">
            {jobs === null
              ? '读取中…'
              : `${jobs.length} 个作业，合计占用 ${usedCpus} / ${cpuTotal} 个核`}
          </p>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="absolute right-3 top-3 grid h-6 w-6 place-items-center rounded text-ink-500 transition hover:bg-ink-100 hover:text-ink-700"
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-3">
          {error && (
            <div className="rounded-surface border border-state-bad/25 bg-state-bad/[0.06] px-3 py-2">
              <p className="selectable text-body font-medium text-state-bad">查不到作业列表</p>
              <p className="selectable mt-1 break-all font-mono text-meta leading-relaxed text-state-bad">
                {error}
              </p>
              <p className="mt-1.5 text-sub leading-relaxed text-state-bad">
                如果上面提到「不是一个函数 / not a function」，说明 preload 的改动没生效——
                需要完全退出应用（不是关窗口）再重新启动。
              </p>
            </div>
          )}

          {jobs !== null && jobs.length === 0 && (
            <p className="py-6 text-center text-body text-ink-500">这台机器上没有运行中的作业</p>
          )}

          {jobs !== null && jobs.length > 0 && (
            <table className="w-full table-fixed text-sub">
              <thead>
                <tr className="border-b border-ink-100 text-left text-meta uppercase tracking-wide text-ink-500">
                  <th className="w-[70px] pb-1.5 font-normal">作业号</th>
                  <th className="w-[92px] pb-1.5 font-normal">用户</th>
                  <th className="w-[46px] pb-1.5 text-right font-normal">核</th>
                  <th className="w-[40px] pb-1.5 text-right font-normal">卡</th>
                  <th className="pb-1.5 pl-2 font-normal">名称</th>
                  <th className="w-[104px] pb-1.5 text-right font-normal">预计结束</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id} className="border-b border-ink-50 last:border-b-0">
                    <td className="py-1 font-mono text-meta text-ink-500">{job.id}</td>
                    <td className="truncate py-1 text-ink-700" title={job.user}>
                      {job.user}
                    </td>
                    <td className="py-1 text-right font-mono text-ink-800">{job.cpus}</td>
                    <td className="py-1 text-right font-mono text-ink-500">
                      {job.gres ? (job.gres.split(':').pop() ?? '—') : '—'}
                    </td>
                    <td className="truncate py-1 pl-2 text-ink-600" title={job.name}>
                      {job.name}
                    </td>
                    <td className="py-1 text-right font-mono text-meta text-ink-500">
                      {job.endTime ? job.endTime.slice(5, 16).replace('T', ' ') : '无时限'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {overLimit && (
            <p className="mt-2 rounded border border-state-wait/25 bg-state-wait/[0.06] px-2 py-1 text-meta text-state-wait">
              占用的核数超过这台机器的总数（{usedCpus} &gt; {cpuTotal}），
              可能是跨节点作业或其他用户的共享额度。
            </p>
          )}
        </div>

        <footer className="shrink-0 border-t border-ink-100 bg-ink-50/40 px-5 py-2.5">
          <p className="text-meta leading-relaxed text-ink-500">
            「预计结束」是按作业提交时的 <span className="font-mono">--time</span> 时限算出来的
            <strong className="font-medium text-ink-500">上限，不是预测值</strong>——
            作业经常提前跑完，没设时限的显示「无时限」。
          </p>
        </footer>
      </div>
    </div>
  )
}
