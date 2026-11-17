/**
 * 顶部提示条（Banner）。
 *
 * 之前是两条各写一份的 JSX：preload 版本过期、配置文件缺失。
 * 它们会**同时出现**，加起来吃掉 100px 以上，而且都在页面最顶上——
 * 正好是最该留给内容的位置。三条一起出现时，用户会直接忽略全部。
 *
 * 这里的规则：
 * - 一次**只显示最严重的一条**，其余折叠成「还有 N 条提示」可展开；
 * - 严重度只有两级：`blocker`（功能真的坏着）与 `notice`（提醒一下）；
 * - 位置紧跟标题栏，视觉上属于"系统状态"而不是"页面内容"。
 *
 * 为什么不放在页面内容区顶部：那样会和每页自己的错误框混在一起，
 * 用户分不清"是这个页面出错"还是"整个应用有问题"。
 */

import { useState, type ReactNode } from 'react'

export type BannerLevel = 'blocker' | 'notice'

export interface BannerItem {
  id: string
  level: BannerLevel
  /** 左侧的小标签，尽量两个字（"未配置" / "版本旧"） */
  tag: string
  /** 一句话说清"现在怎么了"，可以用 <strong> 强调关键处 */
  message: ReactNode
  /** 补充说明，可折叠在下面 */
  detail?: ReactNode
  /** 右侧操作按钮 */
  actions?: Array<{ label: string; onClick: () => void; primary?: boolean }>
}

/** 排序：blocker 永远在前。同级保持传入顺序（调用方按重要性排好） */
function sortBySeverity(items: BannerItem[]): BannerItem[] {
  return [...items].sort((a, b) => {
    if (a.level === b.level) return 0
    return a.level === 'blocker' ? -1 : 1
  })
}

export function BannerStack({ items }: { items: BannerItem[] }): JSX.Element | null {
  const [expanded, setExpanded] = useState(false)

  if (items.length === 0) return null

  const sorted = sortBySeverity(items)
  const [top, ...rest] = sorted
  const visible = expanded ? sorted : [top]

  return (
    <div className="shrink-0 border-b border-ink-200/60 bg-surface">
      {visible.map((item) => (
        <BannerRow key={item.id} item={item} />
      ))}

      {rest.length > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex w-full items-center gap-1.5 bg-ink-50/60 px-4 py-1 text-meta text-ink-500 transition hover:bg-ink-100/70"
        >
          <svg
            width="9"
            height="9"
            viewBox="0 0 10 10"
            fill="none"
            className={'transition-transform ' + (expanded ? 'rotate-90' : '')}
          >
            <path d="M3.5 2 6.5 5 3.5 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {expanded ? '收起其余提示' : `还有 ${rest.length} 条提示`}
        </button>
      )}
    </div>
  )
}

function BannerRow({ item }: { item: BannerItem }): JSX.Element {
  // 两级严重度各一套配色，但都用 state-* 语义色：
  // blocker = wait（黄，功能坏着，要动手修）；notice = info（蓝，只是告知）。
  // 之前这里直接写了 amber-*/sky-*，和别处表示"等待/正常"的颜色不是同一个来源。
  const isBlocker = item.level === 'blocker'
  const shell = isBlocker
    ? 'border-state-wait/25 bg-state-wait/[0.06]'
    : 'border-state-info/25 bg-state-info/[0.05]'
  const tag = isBlocker ? 'bg-state-wait/15 text-state-wait' : 'bg-state-info/15 text-state-info'
  const text = isBlocker ? 'text-ink-900' : 'text-ink-800'
  const sub = 'text-ink-500'

  return (
    <div className={`border-b border-l-2 border-l-transparent px-4 py-1.5 last:border-b-0 ${shell}`}>
      <div className="flex flex-wrap items-start gap-x-2.5 gap-y-1">
        <span className={`mt-[1px] shrink-0 rounded px-1.5 py-[1px] text-meta font-medium ${tag}`}>
          {item.tag}
        </span>
        <div className={`min-w-0 flex-1 text-sub leading-relaxed ${text}`}>
          <p>{item.message}</p>
          {item.detail && <div className={`mt-0.5 text-meta ${sub}`}>{item.detail}</div>}
        </div>
        {item.actions && item.actions.length > 0 && (
          <div className="flex shrink-0 items-center gap-1.5">
            {item.actions.map((action) => (
              <button
                key={action.label}
                type="button"
                onClick={action.onClick}
                className={
                  'rounded-control px-2 py-1 text-meta transition ' +
                  (action.primary
                    ? 'bg-inverse font-medium text-white hover:bg-ink-800'
                    : 'border border-ink-200 bg-surface/70 text-ink-700 hover:bg-surface')
                }
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
