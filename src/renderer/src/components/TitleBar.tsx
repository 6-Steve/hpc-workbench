/**
 * 自绘标题栏（frameless 窗口，docs/01 §4.1 的 ①）。
 *
 * 除了窗口按钮，右侧常驻三个**电量级**数字：跑中作业、存储水位、点数余额。
 * 这三个的共同点是"不看会出事"——作业挂了不知道、存储满了传不上去、
 * 点数不够跑到一半被掐。放标题栏是因为它永远可见，不用切页签。
 *
 * 既然是"指标"，它天然会引出"那我去看看"的动作，所以三块数字**可点击跳页**：
 * 作业 → 作业页、存储 → 资源页（配额在那）、点数 → 点数页。
 * 传 `onNavigate` 才可点；不传时退回纯展示，不留死按钮。
 *
 * 顺带把原来那个写死的「Phase 1」徽章去掉了：作品集里挂个阶段标签像半成品。
 */
import type { Tab } from '../lib/dock-tabs'
import { TITLE_CHIP_TARGETS } from '../lib/title-chips'
import { StatusDot } from './ui'

export type ConnectionStatus = 'connecting' | 'online' | 'offline'

interface TitleBarProps {
  status: ConnectionStatus
  /** 悬停时显示的细节：最后一次错误、或者"最近更新时间" */
  statusDetail?: string
  running: number | null
  pending: number | null
  /** 0–100；null = 还没拿到，或者集群没设限额 */
  quotaPercent: number | null
  points: number | null
  /**
   * 点标题栏上的电量数字跳到对应页。
   *
   * 不传时三块数字退回成纯展示——**不要渲染一个能聚焦、点了却没有反应的按钮**，
   * 那比不可点更糟（用户会以为应用卡了）。
   */
  onNavigate?: (tab: Tab) => void
  /** 当前在哪一页。命中的那块数字加一层底色，说明"你已经在这一页" */
  activeTab?: Tab
  /** 通知铃铛：由 App 传进来，标题栏不关心通知的具体逻辑 */
  bell?: React.ReactNode
  /** 跳板机切换下拉，由 App 装配（标题栏不关心 profile 的加载与切换流程） */
  profileSwitcher?: React.ReactNode
  /** 打开命令面板。窄窗口下入口会隐藏，但 Ctrl+K 始终可用 */
  onSearch?: () => void
  /** 命令记录（底部抽屉）是否开着；开着时按钮高亮 */
  traceOpen?: boolean
  onToggleTrace?: () => void
}

export function TitleBar({
  status,
  statusDetail,
  running,
  pending,
  quotaPercent,
  points,
  onNavigate,
  activeTab,
  bell,
  profileSwitcher,
  onSearch,
  traceOpen = false,
  onToggleTrace
}: TitleBarProps): JSX.Element {
  const statusStyle =
    status === 'online'
      ? { tone: 'ok' as const, pulse: false, text: 'text-ink-500', label: '已连接' }
      : status === 'offline'
        ? { tone: 'bad' as const, pulse: false, text: 'text-state-bad', label: '连接异常' }
        : { tone: 'idle' as const, pulse: true, text: 'text-ink-500', label: '连接中' }

  /** 跑中优先看"有没有在跑"，其次才是"有没有在排"——合并后需要一个总的色调 */
  const runningTone: Tone =
    running === null || pending === null
      ? 'muted'
      : running > 0
        ? 'live'
        : pending > 0
          ? 'warn'
          : 'plain'

  /**
   * 造一个 chip 的点击处理器；`onNavigate` 没传时返回 `undefined`，
   * chip 就渲染成不可点的 `<span>`。
   *
   * 这样"能不能点"只有一处判断，不用在三个调用点各写一次三元。
   */
  const nav = (tab: Tab): (() => void) | undefined => (onNavigate ? () => onNavigate(tab) : undefined)

  return (
    <header className="drag-region flex h-11 shrink-0 items-center justify-between gap-4 border-b border-ink-200/70 bg-surface/80 pl-4 pr-0 backdrop-blur">
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="grid h-6 w-6 shrink-0 place-items-center rounded-control bg-inverse text-sub font-semibold text-white">
          H
        </div>
        <span className="shrink-0 text-emph font-medium text-ink-800">HPC 工作台</span>

        {/* 连接状态：灯 + 文字，只有图标的话用户不知道那是什么意思 */}
        <span className="no-drag ml-1 flex items-center gap-1.5" title={statusDetail ?? statusStyle.label}>
          <StatusDot tone={statusStyle.tone} pulse={statusStyle.pulse} />
          <span className={`text-meta ${statusStyle.text}`}>{statusStyle.label}</span>
        </span>

        {/*
          跳板机切换紧挨着连接状态灯：两者说的是同一件事（"现在连的是谁"）。
          放标题栏而不是设置页，是因为它是全局状态，切一次所有页都换机器。
        */}
        {profileSwitcher}
      </div>

      {/*
        搜索入口。断点从 xl(1280) 降到 lg(1024)：
        窗口最小宽度是 960，原来 960–1280 这段完全看不到搜索框，
        而合并了跑中/排队之后，1024 起就有位置了。
      */}
      {onSearch && (
        <button
          type="button"
          onClick={onSearch}
          className="no-drag mx-2 hidden min-w-0 max-w-[320px] flex-1 items-center gap-2 rounded-control border border-ink-200 bg-surface/70 px-2 py-1 text-sub text-ink-500 transition hover:border-ink-300 hover:text-ink-600 compact:flex"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="shrink-0">
            <circle cx="7" cy="7" r="4.4" stroke="currentColor" strokeWidth="1.3" />
            <path d="M10.4 10.4 14 14" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
          <span className="min-w-0 flex-1 truncate text-left">搜索页面、动作、作业…</span>
          <kbd className="shrink-0 rounded border border-ink-200 bg-ink-50 px-1 py-[1px] font-mono text-meta text-ink-500">
            Ctrl K
          </kbd>
        </button>
      )}

      <div className="flex min-w-0 items-center gap-1">
        {/*
          跑中和排队合成一组：它们在语义上是"同一件事的两个阶段"，
          原来占两个 Chip 位（约 100px），现在用分隔符连起来。
          窗口最小宽度是 960，这一组省下的空间正好让搜索框在 lg 断点就能放下。
        */}
        <ChipGroup
          label="作业"
          title={
            running === null
              ? '还没拿到作业数据'
              : `运行中 ${running} 个${pending !== null ? `，排队 ${pending} 个` : ''}${onNavigate ? '　·　点击查看作业页' : ''}`
          }
          onClick={nav(TITLE_CHIP_TARGETS.jobs)}
          active={activeTab === TITLE_CHIP_TARGETS.jobs}
        >
          <span className={`font-mono text-sub tabular-nums ${TONE_CLASS[runningTone]}`}>
            {running === null ? '—' : String(running)}
          </span>
          <span className="text-meta text-ink-300">/</span>
          <span
            className={`font-mono text-sub tabular-nums ${
              pending !== null && pending > 0 ? TONE_CLASS.warn : TONE_CLASS.muted
            }`}
            title={pending === null ? '还没拿到作业数据' : `排队中 ${pending} 个`}
          >
            {pending === null ? '—' : String(pending)}
          </span>
        </ChipGroup>

        <Divider />
        <Chip
          label="存储"
          value={quotaPercent === null ? '—' : `${Math.round(quotaPercent)}%`}
          tone={quotaPercent === null ? 'muted' : quotaPercent >= 90 ? 'danger' : quotaPercent >= 75 ? 'warn' : 'plain'}
          title={
            quotaPercent === null
              ? '还没拿到配额，或者集群没设软/硬限额'
              : `已用 ${Math.round(quotaPercent)}%（超过 75% 变黄，90% 变红）${onNavigate ? '　·　点击查看资源页的存储配额' : ''}`
          }
          onClick={nav(TITLE_CHIP_TARGETS.storage)}
          active={activeTab === TITLE_CHIP_TARGETS.storage}
        />
        <Divider />
        <Chip
          label="点数"
          value={points === null ? '—' : formatPointsCompact(points)}
          tone={points === null ? 'muted' : points < 50 ? 'danger' : 'plain'}
          title={
            points === null
              ? '还没拿到点数余额'
              : `可用 ${points} 点${onNavigate ? '　·　点击查看余额与消耗记录' : ''}`
          }
          onClick={nav(TITLE_CHIP_TARGETS.points)}
          active={activeTab === TITLE_CHIP_TARGETS.points}
        />

        {onToggleTrace && (
          <button
            type="button"
            onClick={onToggleTrace}
            title={`命令记录：看应用背后发了哪些命令（Ctrl+\`）`}
            className={`no-drag ml-1 flex shrink-0 items-center gap-1 rounded-control border px-1.5 py-[3px] text-meta transition ${
              traceOpen
                ? 'border-ink-400 bg-ink-100 text-ink-800'
                : 'border-ink-200 text-ink-500 hover:border-ink-300 hover:text-ink-700'
            }`}
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" className="shrink-0">
              <path d="M2 3.2 4.6 5.8 2 8.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M6.4 8.6h3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
            命令
          </button>
        )}
        {bell && <div className="ml-1 flex shrink-0 items-center">{bell}</div>}

        {/* 窗口按钮靠右贴边，和系统窗口按钮的位置习惯一致 */}
        <div className="no-drag ml-1.5 flex items-center">
          <WindowButton label="最小化" onClick={() => window.hpc.window.minimize()}>
            <path d="M2 5h6" stroke="currentColor" strokeWidth="1.2" />
          </WindowButton>
          <WindowButton label="最大化" onClick={() => window.hpc.window.toggleMaximize()}>
            <rect x="2.2" y="2.2" width="5.6" height="5.6" stroke="currentColor" strokeWidth="1.2" />
          </WindowButton>
          <WindowButton label="关闭" danger onClick={() => window.hpc.window.close()}>
            <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" stroke="currentColor" strokeWidth="1.2" />
          </WindowButton>
        </div>
      </div>
    </header>
  )
}

type Tone = 'live' | 'warn' | 'danger' | 'plain' | 'muted'

const TONE_CLASS: Record<Tone, string> = {
  live: 'text-state-ok',
  warn: 'text-state-wait',
  danger: 'text-state-bad',
  plain: 'text-ink-700',
  muted: 'text-ink-500'
}

/**
 * 可点击 chip 的类名。
 *
 * ⚠️ **必须是互斥分支，不能拼接**。写成
 * `'hover:bg-ink-100 ' + (active ? 'bg-ink-100' : '')` 会因为同权重、后写的赢，
 * 让鼠标划过"当前页"那块时底色闪一下——看起来像选中态丢了（MEMORY 第 33 条）。
 * 这里 active 时干脆不挂 `hover:` 前缀，从根上没有可打架的类。
 *
 * `cursor-pointer` 要显式写：Tailwind v3 的 preflight **不**给 `button`
 * 设 `cursor: pointer`（v2 有、v3 删了），不写就是默认箭头，看着不像能点。
 */
function chipClass(interactive: boolean, active: boolean): string {
  if (!interactive) return ''
  return active ? 'cursor-pointer bg-ink-100' : 'cursor-pointer hover:bg-ink-100'
}

/** chip 的公共外壳类名：三块数字和原来保持同样的排版，只是可能多一层底色 */
const CHIP_BASE = 'no-drag flex shrink-0 items-baseline gap-1 rounded-control px-1.5 py-0.5 transition'

/**
 * 三块电量数字共用的外壳：`标签 + 内容`，可能可点击。
 *
 * 抽出来是为了让"能不能点"只有**一份**实现——`Chip`（一个数）和
 * `ChipGroup` 那组（两个数）的差别只在右侧内容，外壳完全一样。
 * 两处各写一遍的话，早晚会出现"一个支持点击、另一个忘了"的情况（MEMORY 第 31 条）。
 */
function ChipShell({
  label,
  title,
  onClick,
  active = false,
  children
}: {
  label: string
  title: string
  /** 传了就渲染成按钮；不传是纯展示 */
  onClick?: () => void
  active?: boolean
  children: React.ReactNode
}): JSX.Element {
  const className = `${CHIP_BASE} ${chipClass(onClick !== undefined, active)}`
  const body = (
    <>
      <span className="text-meta text-ink-500">{label}</span>
      <span className="flex items-baseline gap-1">{children}</span>
    </>
  )

  if (!onClick) {
    return (
      <span className={className} title={title}>
        {body}
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={`${label}，${title}`}
      /*
       * 这里**故意不写焦点样式**：`main.css` 已经给所有
       * `button` 挂了全局 `:focus-visible`（accent-500 的 2px outline）。
       * 再叠一层 ring 会变成"蓝圈 + 灰圈"，反而更糊。
       */
      className={className}
    >
      {body}
    </button>
  )
}

function Chip({
  label,
  value,
  tone,
  title,
  onClick,
  active
}: {
  label: string
  value: string
  tone: Tone
  title: string
  onClick?: () => void
  active?: boolean
}): JSX.Element {
  return (
    <ChipShell label={label} title={title} onClick={onClick} active={active}>
      <span className={`font-mono text-sub tabular-nums ${TONE_CLASS[tone]}`}>{value}</span>
    </ChipShell>
  )
}

/**
 * 一组数字（如「作业 2 / 5」），共用一个标签。
 *
 * 为什么需要：跑中和排队本来是两枚独立 Chip，各带一个标签，
 * 加起来 100px 出头。但它们读起来是"2 个在跑、5 个在排"——一件事，
 * 用一个标签 + 分隔符表达更省地方，也更好扫。
 * 两个数字各自带色调（在跑的绿、排队的黄），信息没有丢。
 */
function ChipGroup({
  label,
  title,
  onClick,
  active,
  children
}: {
  label: string
  title: string
  onClick?: () => void
  active?: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <ChipShell label={label} title={title} onClick={onClick} active={active}>
      {children}
    </ChipShell>
  )
}

function Divider(): JSX.Element {
  return <span className="h-3 w-px shrink-0 bg-ink-200" />
}

function WindowButton({
  label,
  onClick,
  danger = false,
  children
}: {
  label: string
  onClick: () => void
  danger?: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={
        'grid h-11 w-11 place-items-center text-ink-500 transition ' +
        (danger ? 'hover:bg-state-bad hover:text-white' : 'hover:bg-ink-100')
      }
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
        {children}
      </svg>
    </button>
  )
}

/** 标题栏空间有限：超过一万点就不显示小数，避免数字把整排撑开 */
function formatPointsCompact(points: number): string {
  if (!Number.isFinite(points)) return '—'
  if (Math.abs(points) >= 10000) return `${Math.round(points / 1000)}k`
  return points.toFixed(points >= 100 ? 0 : 2)
}
