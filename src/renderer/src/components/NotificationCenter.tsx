/**
 * 通知中心（docs/01 §4.1 的 ③ 任务栏右侧铃铛）。
 *
 * 只做一件事：**作业状态变了得让人知道**。
 * 提交完就去干别的，回来发现作业两小时前就失败在 "No such file"，
 * 是这类工具最常见的浪费。
 *
 * 分两层：
 * - 铃铛 + 面板：应用内留痕，翻得回去
 * - 系统通知：窗口不在前台时才弹（判断在主进程，只有它知道焦点）
 */
import { createPortal } from 'react-dom'
import { formatAgo } from '../lib/format'
import { EmptyState, StatusDot } from './ui'

export type NotificationLevel = 'info' | 'success' | 'warning' | 'error'

export interface AppNotification {
  id: string
  level: NotificationLevel
  title: string
  /** 第二行：哪台机器、什么原因、怎么继续查 */
  detail?: string
  /** 关联作业号，点条目可以直接去作业页 */
  jobId?: string
  /** 时间戳（ms） */
  at: number
  read: boolean
}

const LEVEL_STYLE: Record<
  NotificationLevel,
  { tone: 'ok' | 'bad' | 'wait' | 'info'; text: string; bg: string }
> = {
  success: { tone: 'ok', text: 'text-state-ok', bg: 'bg-state-ok/[0.06]' },
  error: { tone: 'bad', text: 'text-state-bad', bg: 'bg-state-bad/[0.05]' },
  warning: { tone: 'wait', text: 'text-state-wait', bg: 'bg-state-wait/[0.06]' },
  info: { tone: 'info', text: 'text-state-info', bg: 'bg-state-info/[0.05]' }
}

export function NotificationBell({
  unread,
  open,
  onClick
}: {
  unread: number
  open: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={unread > 0 ? `${unread} 条未读通知` : '通知'}
      aria-label="通知"
      className={
        'no-drag relative grid h-8 w-8 place-items-center rounded-control transition ' +
        (open ? 'bg-ink-100 text-ink-800' : 'text-ink-500 hover:bg-ink-100 hover:text-ink-700')
      }
    >
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
        <path
          d="M4.2 6.6a3.8 3.8 0 0 1 7.6 0c0 2.1.5 3.1 1 3.7.2.3 0 .7-.4.7H3.6c-.4 0-.6-.4-.4-.7.5-.6 1-1.6 1-3.7Z"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        <path d="M6.6 13.2a1.5 1.5 0 0 0 2.8 0" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
      {unread > 0 && (
        <span className="absolute -right-0.5 -top-0.5 grid h-[15px] min-w-[15px] place-items-center rounded-full bg-state-bad px-[3px] text-meta font-medium leading-none text-white">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </button>
  )
}

export function NotificationPanel({
  items,
  onMarkAllRead,
  onClear,
  onClose,
  onOpenJobs
}: {
  items: AppNotification[]
  onMarkAllRead: () => void
  onClear: () => void
  onClose: () => void
  onOpenJobs: () => void
}): JSX.Element {
  /*
   * ⚠️ 必须 portal 到 body，不能就地 `absolute`。
   *
   * 标题栏有 `backdrop-blur`，它创建**层叠上下文**——栏内元素 z-index 再高
   * 也只在标题栏内部排序，整体低于后面的 Dock 和内容区。
   * 之前这里是 `absolute right-2 top-11 z-40`，表现是面板被 Dock 压住。
   * （和 `ProfileSwitcher` 同一个坑，那边是用户先发现的。）
   *
   * 定位改由 JS 算：标题栏高度 44px（h-11），面板贴它下沿、右边留 8px。
   */
  return createPortal(
    <>
      {/* 点面板外面关掉；z 低于面板一档，不挡面板里的点击 */}
      <div className="fixed inset-0 z-30" onClick={onClose} aria-hidden="true" />

      <div
        style={{ top: 44 + 4, right: 8 }}
        className="fixed z-40 flex max-h-[70vh] w-[352px] flex-col overflow-hidden rounded-surface border border-ink-200 bg-surface shadow-pop"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-ink-100 px-3 py-2">
          <span className="text-body font-medium text-ink-800">通知</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onMarkAllRead}
              disabled={items.every((item) => item.read)}
              className="text-sub text-state-info transition hover:underline disabled:cursor-default disabled:text-ink-300 disabled:no-underline"
            >
              全部已读
            </button>
            <button
              type="button"
              onClick={onClear}
              disabled={items.length === 0}
              className="text-sub text-ink-500 transition hover:underline disabled:cursor-default disabled:text-ink-300 disabled:no-underline"
            >
              清空
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {items.length === 0 && (
            <EmptyState
              title="还没有通知"
              hint="作业开始运行、跑完、或者还没开始就被取消时，这里会出现一条。"
            />
          )}

          {items.map((item) => {
            const style = LEVEL_STYLE[item.level]
            return (
              <div
                key={item.id}
                className={
                  'flex gap-2 border-b border-ink-50 px-3 py-2 last:border-b-0 ' +
                  (item.read ? 'bg-surface' : style.bg + '/40')
                }
              >
                <span className="mt-[5px] flex">
                  <StatusDot tone={style.tone} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className={'text-body leading-snug ' + (item.read ? 'text-ink-600' : 'text-ink-900')}>
                    {item.title}
                  </p>
                  {item.detail && (
                    <p className="mt-0.5 break-words text-sub leading-relaxed text-ink-500">{item.detail}</p>
                  )}
                  <p className="mt-0.5 flex items-center gap-2 text-meta text-ink-300">
                    <span>{formatAgo(item.at / 1000)}</span>
                    {item.jobId && (
                      <button
                        type="button"
                        onClick={onOpenJobs}
                        className="font-mono text-state-info hover:underline"
                        title="去作业页看这个作业"
                      >
                        #{item.jobId}
                      </button>
                    )}
                  </p>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </>,
    document.body
  )
}
