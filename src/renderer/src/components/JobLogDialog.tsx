import { useCallback, useEffect, useRef, useState } from 'react'
import { explainIpcError, stalePreloadError } from '../lib/preload'
import { formatDuration, formatTime } from '../lib/format'

interface JobLogDialogProps {
  jobId: string
  /** 历史表格里现成的就带上，能省一次查询；没有也能查 */
  jobName?: string | null
  workDir?: string | null
  onClose: () => void
}

/** 日志区最多留这么多字符（约 3000 行），超了从头砍。训练日志能刷到几十 MB，不封顶会把渲染层撑爆 */
const MAX_LOG_CHARS = 200_000

const STATE_LABEL: Record<string, { text: string; className: string }> = {
  running: { text: '运行中', className: 'border-state-ok/25 bg-state-ok/[0.06] text-state-ok' },
  pending: { text: '排队中', className: 'border-state-wait/25 bg-state-wait/[0.06] text-state-wait' },
  completed: { text: '已完成', className: 'border-ink-200 bg-ink-50 text-ink-600' },
  failed: { text: '失败', className: 'border-state-bad/25 bg-state-bad/[0.05] text-state-bad' },
  cancelled: { text: '已取消', className: 'border-ink-200 bg-ink-50 text-ink-500' },
  timeout: { text: '超时', className: 'border-state-wait/25 bg-state-wait/[0.06] text-state-wait' },
  'out-of-memory': { text: '内存超限', className: 'border-state-bad/25 bg-state-bad/[0.05] text-state-bad' },
  'node-fail': { text: '节点故障', className: 'border-state-bad/25 bg-state-bad/[0.05] text-state-bad' }
}

/** 只在末尾保留 MAX_LOG_CHARS，避免长时间跟随把内存吃光 */
function keepTail(text: string): string {
  return text.length > MAX_LOG_CHARS ? text.slice(text.length - MAX_LOG_CHARS) : text
}

/**
 * 作业详情 + 输出日志。
 *
 * 两条取数据的路子，也解释了为什么以前运行中的作业看不了日志：
 * - **详情**用 `scontrol show job --json`，它给 `standard_output`（**精确**的输出路径）。
 *   `sacct` 只给工作目录，输出文件名得靠猜，而真实作业大量用 `--output xxx.log`，
 *   猜 `.out` 必然落空。作业结束后 5 分钟会被控制器清理，那时才退回 `sacct`。
 * - **日志**先读最后 200 行；需要时切到「跟随」（`tail -F`），增量文本由主进程按 120ms 合并后推过来。
 */
export function JobLogDialog({ jobId, jobName, workDir, onClose }: JobLogDialogProps): JSX.Element {
  const [detail, setDetail] = useState<JobDetail | null>(null)
  const [detailSource, setDetailSource] = useState<'scontrol' | 'sacct' | null>(null)

  const [state, setState] = useState<JobLogResponse | null>(null)
  const [content, setContent] = useState('')
  const [copied, setCopied] = useState(false)

  /** 跟随中的 streamId；null 表示没在跟随 */
  const [streamId, setStreamId] = useState<string | null>(null)
  const [endNotice, setEndNotice] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)

  const preRef = useRef<HTMLPreElement | null>(null)
  /** 跟随期间用户往上翻过就不自动滚到底，否则会被硬拽回去 */
  const stickToBottom = useRef(true)
  /** 卸载清理时要读当前 streamId，用 ref 避免把 effect 依赖搞成每次重建 */
  const streamRef = useRef<string | null>(null)

  const setStream = useCallback((id: string | null) => {
    streamRef.current = id
    setStreamId(id)
  }, [])

  // —— 详情 ——
  useEffect(() => {
    if (typeof window.hpc?.readJobDetail !== 'function') return
    void (async () => {
      try {
        const response = await window.hpc.readJobDetail({ jobId })
        if (response.ok && response.detail) {
          setDetail(response.detail)
          setDetailSource(response.source ?? null)
        }
      } catch {
        // 详情只是锦上添花，拿不到就不显示，不要拿它挡住日志
      }
    })()
  }, [jobId])

  // —— 首屏日志（最后 200 行）——
  useEffect(() => {
    void (async () => {
      if (typeof window.hpc?.readJobLog !== 'function') {
        setState({ ok: false, error: stalePreloadError('作业日志') })
        return
      }
      try {
        const response = await window.hpc.readJobLog({ jobId, jobName, workDir })
        setState(response)
        if (response.ok) setContent(keepTail(response.content ?? ''))
      } catch (err) {
        setState({ ok: false, error: explainIpcError(err, '作业日志') })
      }
    })()
  }, [jobId, jobName, workDir])

  // —— 跟随：注册推送监听 ——
  useEffect(() => {
    if (typeof window.hpc?.onJobLogChunk !== 'function') return

    window.hpc.onJobLogChunk((payload) => {
      if (payload.streamId !== streamRef.current) return
      setContent((text) => keepTail(text + payload.text))
    })

    window.hpc.onJobLogEnd((payload) => {
      if (payload.streamId !== streamRef.current) return
      setEndNotice(payload.reason)
      setStream(null)
    })
  }, [setStream])

  // 卸载时一定要停：远端 tail -f 不会因为关了弹窗就自己退出
  useEffect(() => {
    return () => {
      const id = streamRef.current
      if (id !== null) void window.hpc.stopJobLog(id)
      streamRef.current = null
    }
  }, [])

  // 跟随 + 贴底时才自动滚动
  useEffect(() => {
    if (streamId === null || !stickToBottom.current) return
    const node = preRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [content, streamId])

  const toggleFollow = useCallback(async (): Promise<void> => {
    setEndNotice(null)

    const current = streamRef.current
    if (current !== null) {
      await window.hpc.stopJobLog(current)
      setStream(null)
      return
    }

    if (typeof window.hpc?.startJobLog !== 'function') {
      setEndNotice('这个功能要重启应用才生效（窗口里的 preload 是旧版本）')
      return
    }

    setStarting(true)
    try {
      // `tail -n 200 -F` 会把最后 200 行重发一遍，先清空避免内容翻倍
      setContent('')
      const response = await window.hpc.startJobLog({ jobId, jobName, workDir })
      if (!response.ok) {
        const error = response.error
        setEndNotice([error?.message, error?.hint].filter(Boolean).join(' · ') || '无法开始跟随')
        return
      }
      if (response.path) setState({ ok: true, path: response.path, source: response.source })
      stickToBottom.current = true
      setStream(response.streamId ?? null)
    } catch (err) {
      setEndNotice(explainIpcError(err, '跟随日志').message)
    } finally {
      setStarting(false)
    }
  }, [jobId, jobName, workDir, setStream])

  const copy = useCallback(async (): Promise<void> => {
    if (content.length === 0) return
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // 剪贴板被拒绝就算了，用户还能手动选中复制
    }
  }, [content])

  const following = streamId !== null
  const stateStyle = detail ? STATE_LABEL[detail.state] : undefined
  const logPath = state?.path ?? detail?.stdoutPath ?? null

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-inverse/25 px-6"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
    >
      <div className="flex max-h-[88vh] w-full max-w-[880px] flex-col overflow-hidden rounded-surface border border-ink-200 bg-surface shadow-pop">
        <header className="relative shrink-0 border-b border-ink-100 px-5 py-3 pr-12">
          <div className="flex items-center gap-2">
            <h2 className="text-emph font-semibold text-ink-900">
              作业 <span className="font-mono">{jobId}</span>
            </h2>
            {detail && (
              <>
                <span className="max-w-[240px] truncate text-body text-ink-500" title={detail.name}>
                  {detail.name}
                </span>
                {stateStyle && (
                  <span
                    className={`inline-flex rounded-control border px-1.5 py-0.5 text-meta font-medium ${stateStyle.className}`}
                  >
                    {stateStyle.text}
                  </span>
                )}
              </>
            )}
            {detailSource === 'sacct' && (
              <span className="rounded bg-ink-100 px-1.5 py-0.5 text-meta text-ink-500">
                取自历史记录（调度器已清理）
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate font-mono text-meta text-ink-500" title={logPath ?? ''}>
            {logPath ?? (state ? '没有输出文件路径' : '定位日志中…')}
            {state?.source === 'sacct' && logPath ? '（按命名约定推断）' : ''}
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

        {/* 详情：一眼看清这作业申请了什么、什么时候跑的 */}
        {detail && (
          <div className="grid shrink-0 grid-cols-2 gap-x-5 gap-y-1.5 border-b border-ink-100 bg-ink-50/40 px-5 py-2.5 compact:grid-cols-3">
            <DetailItem label="分区" value={detail.partition || '—'} />
            <DetailItem label="节点" value={detail.nodes ?? '尚未分配'} />
            <DetailItem
              label="资源"
              value={
                [
                  detail.nodeCount ? `${detail.nodeCount} 节点` : null,
                  detail.cpus ? `${detail.cpus} 核` : null,
                  detail.gpus ? `${detail.gpus} 卡` : null,
                  detail.memoryMb ? `${Math.round(detail.memoryMb / 1024)} GB` : null
                ]
                  .filter(Boolean)
                  .join(' · ') || '—'
              }
            />
            <DetailItem label="时限" value={formatDuration(detail.timeLimitMinutes)} />
            <DetailItem
              label="开始"
              value={detail.startTime !== null && detail.startTime > 0 ? formatTime(detail.startTime * 1000) : '未开始'}
            />
            <DetailItem
              label={detail.state === 'running' ? '预计结束' : '结束'}
              value={detail.endTime !== null && detail.endTime > 0 ? formatTime(detail.endTime * 1000) : '—'}
            />
            {detail.command && <DetailItem label="脚本" value={detail.command} className="col-span-2" mono />}
            {detail.workDir && <DetailItem label="工作目录" value={detail.workDir} className="col-span-2" mono />}
            {detail.stateReasonText.length > 0 && (
              <DetailItem label="状态说明" value={detail.stateReasonText} className="col-span-3" />
            )}
            {detail.exitCode !== null && (
              <DetailItem
                label="退出码"
                value={
                  detail.exitCode +
                  (detail.derivedExitCode !== null && detail.derivedExitCode !== detail.exitCode
                    ? `（实际 ${detail.derivedExitCode}）`
                    : '')
                }
              />
            )}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-hidden px-5 py-3">
          {!state && <p className="py-8 text-center text-body text-ink-500">读取中…</p>}

          {content.length > 0 && (
            <pre
              ref={preRef}
              onScroll={(event) => {
                const node = event.currentTarget
                stickToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40
              }}
              className="selectable max-h-[52vh] overflow-auto whitespace-pre-wrap break-all rounded-surface bg-ink-50/70 p-3 font-mono text-sub leading-relaxed text-ink-800"
            >
              {content.trim() || '（日志是空的）'}
            </pre>
          )}

          {content.length === 0 && state?.ok && !following && (
            <p className="py-8 text-center text-body text-ink-500">
              日志是空的。作业可能还没写出第一行——点「跟随输出」会一直等它出现。
            </p>
          )}

          {state && !state.ok && (
            <div className="rounded-surface border border-state-bad/25 bg-state-bad/[0.06] px-3 py-2.5">
              <p className="text-body font-medium text-state-bad">{state.error?.message}</p>
              {state.error?.hint && <p className="mt-1 text-sub text-state-bad">→ {state.error.hint}</p>}
              {state.tried && state.tried.length > 0 && (
                <div className="mt-1.5">
                  <p className="text-meta text-state-bad">试过这些路径：</p>
                  <pre className="selectable mt-0.5 whitespace-pre-wrap break-all font-mono text-meta text-state-bad">
                    {state.tried.join('\n')}
                  </pre>
                </div>
              )}
            </div>
          )}

          {endNotice && (
            <p className="mt-2 rounded-surface border border-state-wait/25 bg-state-wait/[0.06] px-3 py-1.5 text-sub text-state-wait">
              {endNotice}
            </p>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-ink-100 bg-ink-50/40 px-5 py-2.5">
          <p className="min-w-0 truncate text-meta text-ink-500">
            {following ? (
              <span className="inline-flex items-center gap-1.5 text-state-ok">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-state-ok/70 opacity-75" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-state-ok" />
                </span>
                正在跟随输出（tail -F）
              </span>
            ) : (
              '只显示最后 200 行。要看后续输出就点「跟随输出」。'
            )}
          </p>

          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => void toggleFollow()}
              disabled={starting}
              className={
                'rounded border px-2.5 py-1 text-sub transition disabled:opacity-50 ' +
                (following
                  ? 'border-state-bad/25 bg-surface text-state-bad hover:bg-state-bad/[0.05]'
                  : 'border-ink-200 bg-surface text-ink-700 hover:bg-ink-50')
              }
            >
              {starting ? '启动中…' : following ? '停止跟随' : '跟随输出'}
            </button>
            {content.length > 0 && (
              <button
                type="button"
                onClick={() => void copy()}
                className="rounded border border-ink-200 bg-surface px-2.5 py-1 text-sub text-ink-700 transition hover:bg-ink-50"
              >
                {copied ? '已复制' : '复制全文'}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  )
}

function DetailItem({
  label,
  value,
  className = '',
  mono = false
}: {
  label: string
  value: string
  className?: string
  mono?: boolean
}): JSX.Element {
  return (
    <div className={'min-w-0 ' + className}>
      <span className="text-meta text-ink-500">{label}</span>
      <p className={'truncate ' + (mono ? 'font-mono text-meta text-ink-600' : 'text-ink-700')} title={value}>
        {value}
      </p>
    </div>
  )
}
