/**
 * 全局搜索 / 命令面板（Ctrl+K）。
 *
 * 形态选的是"顶部居中一个输入框 + 下面一串结果"，而不是标题栏里挂个搜索框：
 * 标题栏里那个位置只够放几个字，搜作业号或型号根本打不全。
 *
 * 键盘优先：↑↓ 选、Enter 执行、Esc 关。鼠标也能点，但设计上假设你不离开键盘。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  RESULT_LIMIT,
  groupResults,
  rankItems,
  type PaletteItem,
  type PaletteKind
} from '../lib/command-palette'

const KIND_LABEL: Record<PaletteKind, string> = {
  action: '动作',
  nav: '导航',
  job: '作业'
}

const KIND_CLASS: Record<PaletteKind, string> = {
  action: 'border-accent-500/25 bg-accent-500/[0.06] text-accent-600',
  nav: 'border-state-info/25 bg-state-info/[0.05] text-state-info',
  job: 'border-ink-200 bg-ink-50 text-ink-600'
}

export function CommandPalette({
  items,
  recentIds,
  onRun,
  onClose
}: {
  items: PaletteItem[]
  recentIds: string[]
  onRun: (item: PaletteItem) => void
  onClose: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)

  /**
   * 排序 → 再截断。
   *
   * 顺序不能反：先截断等于"只看最近 100 条历史"，用户搜不到就会以为数据没加载。
   * 全量打分是纯字符串比较，几百条也是微秒级，没必要为它牺牲正确性。
   */
  const ranked = useMemo(() => rankItems(items, query, recentIds), [items, query, recentIds])
  const results = useMemo(() => ranked.slice(0, RESULT_LIMIT), [ranked])

  /**
   * 空查询时按类型分段。
   *
   * 刚打开面板看到的是"2 个动作 + 7 个导航 + 一长串作业"的一条长列表，
   * 想找「资源」得往下翻过一屏作业。分段之后导航项在第一屏就能看全。
   * 一旦开始输入，说明用户已有明确目标，这时只保留排序、去掉标题行。
   */
  const showGroupHeadings = query.trim().length === 0
  const groups = useMemo(() => groupResults(results, showGroupHeadings), [results, showGroupHeadings])

  // 结果变了就把选中项拉回第一个，否则会出现"高亮在看不见的位置"
  useEffect(() => {
    setActive(0)
  }, [query])

  // 键盘移动后保证选中项在可视范围内
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)
    node?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const runActive = useCallback(() => {
    const target = results[active]
    if (target) onRun(target)
  }, [active, results, onRun])

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((index) => (results.length === 0 ? 0 : (index + 1) % results.length))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((index) => (results.length === 0 ? 0 : (index - 1 + results.length) % results.length))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      runActive()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-inverse/25 px-6 pt-[12vh]" onClick={onClose}>
      <div
        className="flex max-h-[62vh] w-full max-w-[560px] flex-col overflow-hidden rounded-surface border border-ink-200 bg-surface shadow-pop"
        // 点面板内部不该把面板关掉
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-ink-100 px-3.5 py-2.5">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0 text-ink-500">
            <circle cx="7" cy="7" r="4.4" stroke="currentColor" strokeWidth="1.3" />
            <path d="M10.4 10.4 14 14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜索页面、动作、作业……"
            className="min-w-0 flex-1 bg-transparent text-emph text-ink-900 outline-none placeholder:text-ink-300"
          />
          <kbd className="shrink-0 rounded border border-ink-200 bg-ink-50 px-1.5 py-0.5 font-mono text-meta text-ink-500">
            Esc
          </kbd>
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
          {results.length === 0 && (
            <p className="px-3.5 py-8 text-center text-body text-ink-500">
              没有匹配的条目。试试页面名（文件 / 作业 / 资源）或作业号。
            </p>
          )}

          {groups.map((group) => (
            <div key={group.kind}>
              {/*
                组标题只在**空查询**时出现。输入了词就只剩排序、不再分段——
                否则每敲一个字，标题行都在你眼前闪动。
              */}
              {showGroupHeadings && (
                <div className="flex items-baseline justify-between px-3.5 pb-0.5 pt-2">
                  <span className="text-meta font-medium uppercase tracking-wide text-ink-500">
                    {KIND_LABEL[group.kind]}
                  </span>
                  <span className="text-meta text-ink-500">{group.items.length}</span>
                </div>
              )}

              {group.items.map((item, offset) => {
                // 扁平数组里的绝对下标——键盘和滚动都依赖它，不能换成 offset
                const index = group.startIndex + offset
                const isActive = index === active
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-index={index}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => onRun(item)}
                    className={
                      'flex w-full items-center gap-2 px-3.5 py-1.5 text-left transition ' +
                      (isActive ? 'bg-state-info/[0.05]' : 'hover:bg-ink-50/70')
                    }
                  >
                    {/*
                      有组标题时就不再逐行贴类型徽章——同一段里每行都写着「导航」
                      是纯噪声。只有输入查询（不分段）时才靠徽章区分类型。
                    */}
                    {!showGroupHeadings && (
                      <span
                        className={`shrink-0 rounded border px-1 py-[1px] text-meta ${KIND_CLASS[item.kind]}`}
                      >
                        {KIND_LABEL[item.kind]}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body text-ink-900">{item.title}</span>
                      {item.subtitle && (
                        <span className="block truncate text-meta text-ink-500">{item.subtitle}</span>
                      )}
                    </span>
                    {isActive && (
                      <kbd className="shrink-0 rounded border border-ink-200 bg-surface px-1 py-[1px] font-mono text-meta text-ink-500">
                        Enter
                      </kbd>
                    )}
                  </button>
                )
              })}
            </div>
          ))}
        </div>

        <footer className="flex shrink-0 items-center justify-between border-t border-ink-100 bg-ink-50/50 px-3.5 py-1.5 text-meta text-ink-500">
          <span>↑↓ 选择 · Enter 执行 · Esc 关闭</span>
          {/*
            被截断时要说清楚：`results` 只有前 100 条，但匹配总数可能更多。
            不提示的话，用户会以为"就这些"，而实际上多敲一个字就能收窄。
          */}
          <span>
            {ranked.length > results.length
              ? `${results.length} / ${ranked.length} 条（多打几个字收窄）`
              : `${results.length} 条`}
          </span>
        </footer>
      </div>
    </div>
  )
}
