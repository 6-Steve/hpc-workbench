/**
 * 页面级的几个小零件：页面骨架、卡片、字段行、等宽文本。
 *
 * 原来都写在 `App.tsx` 里当局部函数用。设置页也要用同一套，
 * 于是挪出来共享——避免两处各画一份、样式慢慢走偏。
 *
 * 2026-11 界面审查后改了一轮：这里的每个元件都改为使用 `tailwind.config.js`
 * 里的语义 token（`text-page/emph/body/sub/meta`、`rounded-surface`、
 * `shadow-card`），不再内联字号和阴影数值。理由见那份配置文件的注释。
 */
import type { ReactNode } from 'react'

/**
 * 页面骨架。
 *
 * 存在的唯一目的：**让 7 个页面的内容区落在同一条栅格上**。
 * 之前每个页面自己写 `mx-auto max-w-[720px|880px|980px|1100px] px-8 py-8`，
 * 切页时内容宽度整体跳一下，右边留白从 190px 变到 380px——
 * 单看每页都不难看，连着用就觉得"这软件左右不齐"。
 *
 * 三档断点下宽度不同（见 tailwind.config.js 的 screens 注释）：
 * - 窄窗口（< 1180）：满宽减边距，不再留大块空白
 * - 常规（≥ 1180）：1120 上限，这是设计的基准尺寸
 * - 宽屏（≥ 1480）：放宽到 `page-wide`，否则 1920 的屏上两侧各空 400px，
 *   看库存表要来回扫视。表格类内容"宽一点"比"居中留白"好用。
 *
 * `wide` 给终端页用：终端是"铺满越好"的元件，上限再放宽一档。
 */
export function PageShell({
  children,
  wide = false,
  className = ''
}: {
  children: ReactNode
  /** true = 用更宽的栅格（终端页）。仍是同一条中轴，只是上限不同 */
  wide?: boolean
  className?: string
}): JSX.Element {
  return (
    <main className="selectable flex-1 overflow-y-auto">
      <div
        /*
         * 边距随窗口走：960~1040 这段是最窄的区间，`px-8 py-7` 会把
         * 单栏内容压得太瘦（扣掉侧边栏 56 之后只剩 ~840）。
         * 所以窄窗口收一档，到 compact 再放开——这也是"响应式适配"里
         * 用户真正能感觉到的一处。
         */
        className={`mx-auto w-full px-5 py-5 compact:px-8 compact:py-7 ${
          wide ? 'max-w-[1440px] wide:max-w-[1680px]' : 'max-w-page wide:max-w-page-wide'
        } ${className}`}
      >
        {children}
      </div>
    </main>
  )
}

/**
 * 页头：标题 + 一句说明 + 右侧操作。
 *
 * 抽出来是因为 7 个页面都在重复同一段 JSX，而且字号/间距已经各写各的了
 * （22px 标题有的配 mt-1 说明，有的配 mt-1.5，有的干脆没有说明）。
 *
 * `className` 只留给"头部下边距需要改"的场合。默认 `mb-5` 适合
 * "头部 + 下面一片卡片"的滚动页面；终端页的头部是**紧贴**下方终端窗口的，
 * 只需要 `pb-3`，多出的下边距会把终端挤矮一行。
 */
export function PageHeader({
  title,
  description,
  aside,
  className = 'mb-5'
}: {
  title: string
  description?: ReactNode
  aside?: ReactNode
  /** 只在需要改下边距时传（默认 mb-5） */
  className?: string
}): JSX.Element {
  return (
    <div className={`flex flex-wrap items-end justify-between gap-3 ${className}`}>
      <div className="min-w-0">
        {/*
          `font-display` 而不是 `font-sans`：标题字体可以独立于正文切换
          （「书卷」方案就是标题衬线 + 正文无衬线）。
          变量在 main.css 里，切换靠 `<html data-font>`，不需要重新构建。
        */}
        <h1 className="font-display text-page font-semibold text-ink-900">{title}</h1>
        {description && <p className="mt-1.5 text-emph leading-relaxed text-ink-500">{description}</p>}
      </div>
      {aside && <div className="flex shrink-0 items-center gap-2">{aside}</div>}
    </div>
  )
}

/** 卡片顶部的马卡龙色条。**只做装饰，不承载语义**——语义一律走 `state-*` */
export type CardTone = 'lilac' | 'mint' | 'pink' | 'butter' | 'peach' | 'sky'

const CARD_TONE_CLASS: Record<CardTone, string> = {
  lilac: 'bg-decor-lilac',
  mint: 'bg-decor-mint',
  pink: 'bg-decor-pink',
  butter: 'bg-decor-butter',
  peach: 'bg-decor-peach',
  sky: 'bg-decor-sky'
}

export function Card({
  title,
  children,
  aside,
  tone
}: {
  title: string
  children: ReactNode
  aside?: ReactNode
  /**
   * 顶部那条 3px 色条。**可选**：绝大多数卡片不需要，
   * 只在"这一块是这页的主角"时用（比如设置页的登录凭据、点数页的余额）。
   *
   * 刻意做成装饰而不是状态色：状态已经有 `state-*` 四档，
   * 再让卡片颜色表达"好/坏"会让同一个颜色有两种含义。
   */
  tone?: CardTone
}): JSX.Element {
  return (
    <section className="overflow-hidden rounded-surface border border-ink-200/70 bg-surface shadow-card">
      {tone && <div className={`h-[3px] w-full ${CARD_TONE_CLASS[tone]}`} />}
      <div className="flex items-center justify-between border-b border-ink-100 px-5 py-3">
        <h2 className="font-display text-emph font-semibold text-ink-800">{title}</h2>
        {aside}
      </div>
      {/*
        内边距用 `px-card-x py-card-y` 而不是 px-5 py-4：
        这是**主题可调**的间距（`--pad-card-x` / `--pad-card-y`）。
        「经典」是 20/16，紧凑；「马卡龙甜梦」是 24/20，更松弛。
        松紧只作用在大容器上——表格行距不跟着变，否则密集表格会散架。
      */}
      <div className="px-card-x py-card-y">{children}</div>
    </section>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex gap-4 py-1.5 text-emph">
      <span className="w-24 shrink-0 text-ink-500">{label}</span>
      <div className="min-w-0 flex-1 text-ink-800">{children}</div>
    </div>
  )
}

export function Mono({ children }: { children: ReactNode }): JSX.Element {
  return <span className="selectable break-all font-mono text-body text-ink-700">{children}</span>
}

/** 设置项下面的补充说明 */
export function Hint({ children }: { children: ReactNode }): JSX.Element {
  return <p className="mt-1 text-sub leading-relaxed text-ink-500">{children}</p>
}

/** 小节标题：资源页/设置页里"节点（16）""存储配额"这一类，样式统一 */
export function SectionTitle({
  children,
  aside
}: {
  children: ReactNode
  aside?: ReactNode
}): JSX.Element {
  return (
    <div className="mb-2 flex items-center justify-between gap-3">
      <h2 className="font-display text-emph font-semibold text-ink-800">{children}</h2>
      {aside}
    </div>
  )
}

/**
 * 空状态：**标题说"为什么空"，说明说"下一步做什么"**。
 *
 * 不写"暂无数据"——那等于把问题原样丢回给用户。作业页那句
 * 「队列是空的 / 提交一个之后它会出现在这里」是这套写法最早的范本，
 * 这里只是把它变成组件，让别处不要再各写各的。
 */
export function EmptyState({
  title,
  hint,
  action
}: {
  title: string
  hint?: ReactNode
  action?: ReactNode
}): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-8 text-center">
      <p className="text-emph font-medium text-ink-700">{title}</p>
      {hint && (
        <p className="mt-1 max-w-[46ch] text-body leading-relaxed text-ink-500">{hint}</p>
      )}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}

/**
 * 状态点。
 *
 * 规则（`docs/11 §C`）：**单点用圆点，带文字用胶囊**，同一行里不要混用——
 * 圆点表达"这一行有个状态"，胶囊表达"这个状态叫什么"，混在一行会让眼睛反复切语义。
 *
 * 尺寸只有两档：`sm` 6px（列表行）、`md` 8px（标题栏）。以前各写各的 `h-1.5 w-1.5`，
 * 谁都记不住第二处该是几像素。
 */
export function StatusDot({
  tone,
  size = 'sm',
  pulse = false,
  title
}: {
  tone: 'ok' | 'wait' | 'bad' | 'info' | 'idle'
  size?: 'sm' | 'md'
  /** "还在转"的语义（连接中、加载中）。**别顺手删掉**——它是状态的一部分 */
  pulse?: boolean
  title?: string
}): JSX.Element {
  const color =
    tone === 'ok'
      ? 'bg-state-ok'
      : tone === 'wait'
        ? 'bg-state-wait'
        : tone === 'bad'
          ? 'bg-state-bad'
          : tone === 'info'
            ? 'bg-state-info'
            : 'bg-ink-200'
  const box = size === 'md' ? 'h-2 w-2' : 'h-1.5 w-1.5'
  return (
    <span
      className={`${box} shrink-0 rounded-full ${color}${pulse ? ' animate-pulse' : ''}`}
      title={title}
      aria-hidden="true"
    />
  )
}
