/**
 * 命令台：把应用背后真正发往集群的命令摊开。
 *
 * 为什么它值得存在
 * ----------------
 * 这个应用干的活就是"发命令、解析文本、画成界面"。数字一旦不对，第一反应必然是
 * "它到底发了什么、远端回了什么"。没有这一层，只能翻代码猜或另开终端重敲一遍。
 *
 * 三条设计取舍
 * ------------
 * 1. **底部抽屉而不是独立页签**：它是"对账用的"，要能在任何页面就地打开，
 *    切页签就丢了现场感。
 * 2. **默认收着**：正常使用时它只是噪音。开着的时候也确实占地方，
 *    所以高度定死在 264px，不抢主区域。
 * 3. **只读**：没有任何输入框可以"执行命令"。想敲命令请去终端页——
 *    那个是真正的 PTY，这里是历史记录。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  commandSummary,
  formatClock,
  formatDuration,
  isFailed,
  TRACE_LIMIT,
  type TraceEntry,
  type TraceRecord
} from '../../../shared/trace'
import { traceShortcut } from '../lib/platform'

interface TracePanelProps {
  onClose: () => void
}

/** 合并两批记录：按 id 去重 + 升序 + 只留最近 TRACE_LIMIT 条 */
function mergeEntries(a: TraceEntry[], b: TraceEntry[]): TraceEntry[] {
  const map = new Map<number, TraceEntry>()
  for (const entry of [...a, ...b]) map.set(entry.id, entry)
  const merged = [...map.values()].sort((x, y) => x.id - y.id)
  return merged.length > TRACE_LIMIT ? merged.slice(merged.length - TRACE_LIMIT) : merged
}

function CodeBadge({ entry }: { entry: TraceEntry }): JSX.Element {
  if (entry.error) {
    return (
      <span className="shrink-0 rounded bg-state-bad/[0.05] px-1 py-[1px] font-mono text-meta text-state-bad" title={entry.error}>
        未执行
      </span>
    )
  }
  if (entry.code === null) {
    return (
      <span className="shrink-0 rounded bg-ink-100 px-1 py-[1px] font-mono text-meta text-ink-500">信号</span>
    )
  }
  return (
    <span
      className={`shrink-0 rounded px-1 py-[1px] font-mono text-meta ${
        entry.code === 0 ? 'bg-ink-100 text-ink-500' : 'bg-state-bad/[0.05] text-state-bad'
      }`}
    >
      {entry.code}
    </span>
  )
}

/** 一段等宽输出。空内容直接不渲染，避免一堆空白框 */
function OutputBlock({ label, text, tone }: { label: string; text: string; tone: 'ink' | 'red' }): JSX.Element | null {
  if (!text.trim()) return null
  return (
    <div className="mt-1.5">
      <p className={`text-meta uppercase tracking-wide ${tone === 'red' ? 'text-state-bad' : 'text-ink-500'}`}>
        {label}
      </p>
      <pre
        className={`selectable mt-0.5 max-h-52 overflow-auto whitespace-pre-wrap break-all rounded border border-ink-100 p-2 font-mono text-meta leading-relaxed ${
          tone === 'red' ? 'bg-state-bad/[0.05] text-state-bad' : 'bg-ink-50/70 text-ink-700'
        }`}
      >
        {text}
      </pre>
    </div>
  )
}

function EntryRow({
  entry,
  expanded,
  full,
  loading,
  onToggle,
  onLoadFull
}: {
  entry: TraceEntry
  expanded: boolean
  full: TraceRecord | undefined
  loading: boolean
  onToggle: () => void
  onLoadFull: () => void
}): JSX.Element {
  const failed = isFailed(entry)
  const [copied, setCopied] = useState<'cmd' | 'out' | null>(null)

  const copy = async (what: 'cmd' | 'out'): Promise<void> => {
    const text = what === 'cmd' ? entry.command : full?.fullStdout || entry.stdout
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what)
      window.setTimeout(() => setCopied(null), 1200)
    } catch {
      // 剪贴板被拒（无焦点/权限）就算了，不弹窗打断
    }
  }

  return (
    <div className={`border-b border-ink-100/70 last:border-b-0 ${failed ? 'bg-state-bad/[0.03]' : ''}`}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-baseline gap-2 px-3 py-1 text-left transition hover:bg-ink-50/70"
      >
        <span className="shrink-0 font-mono text-meta tabular-nums text-ink-500">{formatClock(entry.at)}</span>
        <span className="shrink-0 font-mono text-meta tabular-nums text-ink-300">
          {formatDuration(entry.durationMs)}
        </span>
        <CodeBadge entry={entry} />
        <span
          className={`min-w-0 flex-1 truncate font-mono text-sub ${
            failed ? 'text-state-bad' : 'text-ink-700'
          }`}
          title={entry.command}
        >
          {commandSummary(entry.command)}
        </span>
        {entry.truncated && (
          <span className="shrink-0 text-meta text-state-wait" title="远端输出超过上限，被丢弃了一部分">
            截断
          </span>
        )}
        <span className="shrink-0 text-meta text-ink-300">{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className="px-3 pb-2.5 pl-[74px]">
          {entry.error && (
            <p className="mb-1 rounded border border-state-bad/25 bg-state-bad/[0.05] px-2 py-1 text-sub text-state-bad">
              命令没有跑成：{entry.error}
            </p>
          )}

          <div className="mt-1">
            <p className="text-meta uppercase tracking-wide text-ink-500">命令</p>
            <pre className="selectable mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border border-ink-100 bg-surface p-2 font-mono text-meta leading-relaxed text-ink-800">
              {entry.command}
            </pre>
          </div>

          <OutputBlock label="stdout" text={(full?.fullStdout ?? entry.stdout) || ''} tone="ink" />
          <OutputBlock label="stderr" text={(full?.fullStderr ?? entry.stderr) || ''} tone="red" />

          {!full && (entry.stdoutChars > entry.stdout.length || entry.stderrChars > entry.stderr.length) && (
            <p className="mt-1.5 text-meta text-state-wait">
              预览只显示了开头，原始输出共 {Math.max(entry.stdoutChars, entry.stderrChars)} 字。
              {loading ? '正在取完整…' : '点下面「看完整输出」。'}
            </p>
          )}

          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-meta text-ink-500">
            <span className="font-mono">{entry.host}</span>
            <button type="button" onClick={() => void copy('cmd')} className="text-ink-500 underline-offset-2 hover:underline">
              {copied === 'cmd' ? '已复制' : '复制命令'}
            </button>
            <button type="button" onClick={() => void copy('out')} className="text-ink-500 underline-offset-2 hover:underline">
              {copied === 'out' ? '已复制' : '复制输出'}
            </button>
            {!full && (
              <button
                type="button"
                onClick={onLoadFull}
                className="text-ink-500 underline-offset-2 hover:underline disabled:text-ink-300"
                disabled={loading}
              >
                {loading ? '正在取…' : '看完整输出'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export function TracePanel({ onClose }: TracePanelProps): JSX.Element {
  const [entries, setEntries] = useState<TraceEntry[]>([])
  const [filter, setFilter] = useState('')
  const [onlyFailed, setOnlyFailed] = useState(false)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [follow, setFollow] = useState(true)
  const [fullCache, setFullCache] = useState<Record<number, TraceRecord>>({})
  const [loadingId, setLoadingId] = useState<number | null>(null)
  /** preload 是旧版本时这几个方法根本不存在，直接调会炸掉整棵树 */
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    // 老旧 preload 的兜底：宁可显示一句"重开应用"，也不要抛 TypeError 白屏
    if (typeof window.hpc.traceList !== 'function' || typeof window.hpc.onTraceEntry !== 'function') {
      setUnavailable('这个窗口里的 preload 还是旧版本，读不到命令记录。把应用完全关掉、重新打开即可。')
      return
    }

    // 顺序很重要：**先订阅再拉历史**。反过来的话，两次调用之间执行完的命令会漏掉。
    window.hpc.onTraceEntry((entry) => {
      setEntries((prev) => mergeEntries(prev, [entry]))
    })

    let cancelled = false
    void (async () => {
      try {
        const response = await window.hpc.traceList()
        if (!cancelled && response.ok) setEntries((prev) => mergeEntries(response.entries, prev))
      } catch {
        // 拉历史失败不影响实时流
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  const visible = useMemo(() => {
    const keyword = filter.trim().toLowerCase()
    return entries.filter((entry) => {
      if (onlyFailed && !isFailed(entry)) return false
      if (!keyword) return true
      return [entry.command, entry.stdout, entry.stderr, entry.error ?? ''].some((text) =>
        text.toLowerCase().includes(keyword)
      )
    })
  }, [entries, filter, onlyFailed])

  // 新记录进来时贴着底部；用户往上翻过就不再自动跳，免得正在看的东西被顶走
  useEffect(() => {
    if (!follow) return
    const element = listRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [visible, follow])

  const onScroll = useCallback(() => {
    const element = listRef.current
    if (!element) return
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24
    setFollow(atBottom)
  }, [])

  const loadFull = useCallback(
    async (id: number) => {
      if (fullCache[id] || loadingId === id) return
      setLoadingId(id)
      try {
        const response = await window.hpc.traceDetail(id)
        if (response.ok && response.record) {
          const record = response.record
          setFullCache((cache) => ({ ...cache, [id]: record }))
        }
      } catch {
        // 忽略：列表里的预览还在，不至于什么都看不到
      } finally {
        setLoadingId(null)
      }
    },
    [fullCache, loadingId]
  )

  /**
   * 展开某一条。
   *
   * 「顺手取完整输出」放在这里而不是放进子组件的 effect：展开是一次明确的人为动作，
   * 在事件里做副作用不会因为 StrictMode 的重复渲染重复发请求，
   * 也不需要一个每次渲染都变新引用的回调当依赖。
   */
  const toggle = useCallback(
    (entry: TraceEntry): void => {
      const next = expandedId === entry.id ? null : entry.id
      setExpandedId(next)
      if (next === null) return
      const clipped = entry.stdoutChars > entry.stdout.length || entry.stderrChars > entry.stderr.length
      if (clipped) void loadFull(entry.id)
    },
    [expandedId, loadFull]
  )

  const failedCount = entries.filter(isFailed).length

  /**
   * 浮层而不是挤压布局。
   *
   * 原来是 `section.flex h-[264px] shrink-0` 直接插在 App 的列布局末尾，
   * 也就是**一开就吃掉 264px**：文件页底部的传输进度条被推出可视区，
   * 资源页的"费用试算"直接滚出屏幕。而命令台的用途恰恰是"边看页面边对账"，
   * 把页面内容挤走就自相矛盾了。
   *
   * 现在改成 `absolute inset-x-0 bottom-0`：主布局高度恒定，
   * 命令台浮在内容之上，底下垫一层点击即关的遮罩。
   * Esc 关闭由 App 的全局 keydown 负责，这里不重复绑。
   */
  return (
    <>
      <div
        className="absolute inset-x-0 top-0 bottom-[264px] z-20 bg-ink-950/16"
        onClick={onClose}
        aria-hidden="true"
      />
      <section className="absolute inset-x-0 bottom-0 z-30 flex h-[264px] flex-col border-t border-ink-200 bg-surface shadow-pop">
        <header className="flex shrink-0 items-center gap-2 border-b border-ink-100 px-3 py-1.5">
          <span className="shrink-0 text-body font-medium text-ink-800">命令记录</span>
          <span className="shrink-0 font-mono text-meta tabular-nums text-ink-500">
            {visible.length === entries.length ? entries.length : `${visible.length}/${entries.length}`}
          </span>
          {failedCount > 0 && (
            <span className="shrink-0 rounded bg-state-bad/[0.05] px-1 py-[1px] font-mono text-meta text-state-bad">
              {failedCount} 失败
            </span>
          )}

          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="过滤命令或输出…"
            className="ml-1 min-w-0 max-w-[280px] flex-1 rounded-control border border-ink-200 bg-surface px-2 py-[3px] font-mono text-sub text-ink-700 outline-none placeholder:text-ink-300 focus:border-ink-400"
          />

          <button
            type="button"
            onClick={() => setOnlyFailed((value) => !value)}
            className={`shrink-0 rounded-control border px-1.5 py-[3px] text-meta transition ${
              onlyFailed
                ? 'border-state-bad/35 bg-state-bad/[0.05] text-state-bad'
                : 'border-ink-200 text-ink-500 hover:border-ink-300 hover:text-ink-700'
            }`}
          >
            只看失败
          </button>
          <button
            type="button"
            onClick={() => setFollow((value) => !value)}
            className={`shrink-0 rounded-control border px-1.5 py-[3px] text-meta transition ${
              follow
                ? 'border-state-ok/35 bg-state-ok/[0.06] text-state-ok'
                : 'border-ink-200 text-ink-500 hover:border-ink-300 hover:text-ink-700'
            }`}
            title="新命令进来时自动滚到底部"
          >
            {follow ? '跟随中' : '已暂停'}
          </button>
          <button
            type="button"
            onClick={() => {
              void window.hpc.traceClear().then(() => {
                setEntries([])
                setFullCache({})
                setExpandedId(null)
              })
            }}
          className="shrink-0 rounded-control border border-ink-200 px-1.5 py-[3px] text-meta text-ink-500 transition hover:border-ink-300 hover:text-ink-700"
        >
          清空
        </button>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-control border border-ink-200 px-1.5 py-[3px] text-meta text-ink-500 transition hover:border-ink-300 hover:text-ink-700"
          title={`收起（${traceShortcut}）`}
        >
          收起
        </button>
      </header>

      <div ref={listRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-auto">
        {unavailable ? (
          <div className="px-4 py-6 text-body leading-relaxed text-state-wait">{unavailable}</div>
        ) : visible.length === 0 ? (
          <div className="px-4 py-6 text-body leading-relaxed text-ink-500">
            {entries.length === 0 ? (
              <>
                <p className="text-ink-600">这里会列出每条真正发往集群的命令，以及它返回了什么。</p>
                <p className="mt-1">
                  比如点「作业」页会发 <code className="font-mono text-sub">squeue --me --json</code>，
                  看资源页会发 <code className="font-mono text-sub">scontrol show node --json</code>，
                  价格走 <code className="font-mono text-sub">scir-watch -s</code>。
                </p>
                <p className="mt-1">
                  队列和库存每 20 秒轮询一次，所以这里会持续有新记录——只留最近 {TRACE_LIMIT} 条。
                </p>
              </>
            ) : (
              <p>没有匹配的记录。过滤词换个写法，或者取消「只看失败」。</p>
            )}
          </div>
        ) : (
          visible.map((entry) => (
            <EntryRow
              key={entry.id}
              entry={entry}
              expanded={expandedId === entry.id}
              full={fullCache[entry.id]}
              loading={loadingId === entry.id}
              onToggle={() => toggle(entry)}
              onLoadFull={() => void loadFull(entry.id)}
            />
          ))
        )}
      </div>
      </section>
    </>
  )
}
