/**
 * 左侧图标启动器（docs/01 §4.1 的 ②）。
 *
 * 为什么把顶部页签换成左侧竖排图标：顶部那排文字按钮是"网站导航"的形态，
 * 竖排图标 + 当前项高亮才是桌面软件的形态。这一条直接对应 Phase 3 的验收标准——
 * "不点任务栏切出时，会觉得这是个独立软件而不是网页"。
 *
 * 图标全部手写 SVG，不引第三方图标库：只有 5 个，引一个库反而多一份依赖和体积。
 */

import { DOCK_TABS, type Tab } from '../lib/dock-tabs'

export type { Tab }

/**
 * 页签清单在 `lib/dock-tabs.ts`——那是纯数据，命令面板也用它，
 * 所以不能留在 `.tsx` 里（测试要 import，node 侧不认 JSX）。
 * 这里只负责图标和渲染。
 */

interface DockItem {
  id: Tab
  label: string
  /** 悬停时右侧浮出的说明，解释这一栏是干嘛的 */
  hint: string
  icon: JSX.Element
}

const ICONS: Record<Tab, JSX.Element> = {
  files: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path
        d="M2.5 5.2c0-.6.5-1.1 1.1-1.1h3l1.4 1.5h6.4c.6 0 1.1.5 1.1 1.1v6.6c0 .6-.5 1.1-1.1 1.1H3.6c-.6 0-1.1-.5-1.1-1.1V5.2Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </svg>
  ),
  jobs: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path
        d="M6.2 5.6h8.3M6.2 9h8.3M6.2 12.4h8.3"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
      <circle cx="3.9" cy="5.6" r="1" fill="currentColor" />
      <circle cx="3.9" cy="9" r="1" fill="currentColor" />
      <circle cx="3.9" cy="12.4" r="1" fill="currentColor" />
    </svg>
  ),
  nodes: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="4.6" y="4.6" width="8.8" height="8.8" rx="1.4" stroke="currentColor" strokeWidth="1.25" />
      <path
        d="M7.2 2.4v2.2M10.8 2.4v2.2M7.2 13.4v2.2M10.8 13.4v2.2M2.4 7.2h2.2M2.4 10.8h2.2M13.4 7.2h2.2M13.4 10.8h2.2"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
    </svg>
  ),
  points: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      {/* 一枚硬币：外圆 + 中间一道竖线，比「¥」符号更容易在 18px 下认出来 */}
      <circle cx="9" cy="9" r="6.4" stroke="currentColor" strokeWidth="1.25" />
      <path d="M9 5.6v6.8" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <path d="M6.9 7.8h4.2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  ),
  tunnels: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M6.4 2.8v2.6M11.6 2.8v2.6" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <path
        d="M4.4 5.4h9.2v3.2a4.6 4.6 0 0 1-4.6 4.6 4.6 4.6 0 0 1-4.6-4.6V5.4Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      <path d="M9 13.2v2.2" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  ),
  terminal: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="2.2" y="3.6" width="13.6" height="10.8" rx="1.8" stroke="currentColor" strokeWidth="1.25" />
      <path
        d="M5.4 7.3l2 2-2 2"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M9.6 11.3h3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  ),
  settings: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M3 6h7M13 6h2M3 12h2M8 12h7" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <circle cx="11.5" cy="6" r="1.7" stroke="currentColor" strokeWidth="1.25" />
      <circle cx="6.5" cy="12" r="1.7" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  ),
  diagnostics: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path
        d="M2.4 9.2h2.6l1.8-4.4 2.6 9 1.9-4.6h2.9"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

const ITEMS: DockItem[] = DOCK_TABS.map((tab) => ({ ...tab, icon: ICONS[tab.id] }))

interface DockProps {
  active: Tab
  onChange: (tab: Tab) => void
}

export function Dock({ active, onChange }: DockProps): JSX.Element {
  return (
    <nav className="no-drag flex w-14 shrink-0 flex-col items-center gap-1 border-r border-ink-200/70 bg-surface/60 py-2">
      {ITEMS.map((item) => {
        const isActive = item.id === active
        return (
          <div key={item.id} className="group relative">
            <button
              type="button"
              onClick={() => onChange(item.id)}
              aria-label={item.label}
              aria-current={isActive ? 'page' : undefined}
              className={
                'grid h-10 w-10 place-items-center rounded-surface transition ' +
                (isActive
                  ? 'bg-scrim text-white shadow-card'
                  : 'text-ink-500 hover:bg-ink-100 hover:text-ink-700')
              }
            >
              {item.icon}
            </button>

            {/* 悬停说明：桌面软件的习惯是在图标旁边浮出名字，而不是只给一个 title */}
            <div className="pointer-events-none absolute left-12 top-1/2 z-30 hidden -translate-y-1/2 whitespace-nowrap rounded-control bg-scrim/95 px-2 py-1 text-sub text-white shadow-pop group-hover:block">
              <span className="font-medium">{item.label}</span>
              <span className="ml-1.5 text-night-sub">{item.hint}</span>
            </div>
          </div>
        )
      })}
    </nav>
  )
}
