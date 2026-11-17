import { formatRate, formatSize } from '../lib/format'

interface TransferBarProps {
  snapshot: QueueSnapshot
  /** 排队中的任务直接取消；运行中的会先弹确认框（由调用方决定） */
  onCancel: (task: QueueTaskSnapshot) => void
  onDismiss: () => void
}

type QueueTaskSnapshot = QueueSnapshot['tasks'][number]

const STATUS_TEXT: Record<string, string> = {
  queued: '排队中',
  running: '传输中',
  succeeded: '已完成',
  failed: '失败',
  skipped: '已跳过',
  cancelled: '已取消'
}

export function TransferBar({ snapshot, onCancel, onDismiss }: TransferBarProps): JSX.Element {
  const percent =
    snapshot.totalBytes > 0 ? Math.min(100, Math.round((snapshot.doneBytes / snapshot.totalBytes) * 100)) : 0
  const active = snapshot.tasks.filter((task) => task.status === 'running' || task.status === 'queued')
  const failed = snapshot.tasks.filter((task) => task.status === 'failed')
  const settled = snapshot.running === 0 && snapshot.queued === 0

  return (
    <section className="shrink-0 border-t border-ink-200 bg-surface">
      <div className="flex items-center gap-3 px-3 py-2">
        <span className="text-sub font-medium text-ink-700">
          {settled ? '传输结束' : `传输中 ${snapshot.running} · 排队 ${snapshot.queued}`}
        </span>
        <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-ink-100">
          <div
            className="h-full rounded-full bg-state-info transition-[width] duration-200"
            style={{ width: `${percent}%` }}
          />
        </div>
        <span className="shrink-0 font-mono text-sub text-ink-500">
          <span className="font-mono tabular-nums">
            {formatSize(snapshot.doneBytes)} / {formatSize(snapshot.totalBytes)} · {percent}%
          </span>
        </span>
        {failed.length > 0 && (
          <span className="shrink-0 rounded bg-state-bad/[0.05] px-1.5 py-0.5 text-meta text-state-bad">
            {failed.length} 失败
          </span>
        )}
        {settled && (
          <button
            type="button"
            onClick={onDismiss}
            className="shrink-0 rounded border border-ink-200 px-2 py-0.5 text-sub text-ink-500 hover:bg-ink-50"
          >
            收起
          </button>
        )}
      </div>

      <ul className="max-h-28 overflow-y-auto border-t border-ink-100">
        {snapshot.tasks.map((task) => (
          <li key={task.id} className="flex items-center gap-2 px-3 py-1 text-sub">
            <span
              className={
                'w-12 shrink-0 ' +
                (task.status === 'failed'
                  ? 'text-state-bad'
                  : task.status === 'succeeded'
                    ? 'text-state-ok'
                    : 'text-ink-500')
              }
            >
              {STATUS_TEXT[task.status] ?? task.status}
            </span>
            <span className="min-w-0 flex-1 truncate text-ink-700" title={task.label}>
              {task.direction === 'upload' ? '↑' : '↓'} {task.label}
            </span>
            {task.status === 'running' && (
              <span className="shrink-0 font-mono text-meta text-ink-500">{formatRate(task.bytesPerSecond)}</span>
            )}
            {/*
              运行中显示「已传 / 总共」，其余只显示大小。
              只写总大小时，一行里只有速度在动，用户无法判断还剩多少——
              而且总览条汇总的是"所有任务"，单个任务到底传到哪了看不出来。
            */}
            <span className="w-24 shrink-0 text-right font-mono text-meta text-ink-500">
              {task.status === 'running' && task.totalBytes !== null
                ? `${formatSize(task.bytes)} / ${formatSize(task.totalBytes)}`
                : formatSize(task.totalBytes ?? task.bytes)}
            </span>
            {task.status === 'queued' && (
              <button
                type="button"
                onClick={() => onCancel(task)}
                className="shrink-0 rounded px-1 text-meta text-ink-500 hover:bg-ink-100 hover:text-ink-700"
              >
                取消
              </button>
            )}
            {/*
              运行中的任务也要能取消——以前这里不给按钮，只能干等一个
              187 MB 的文件传完。现在点它会先弹确认框问"半截文件删不删"，
              所以文案用「停止」而不是「取消」：这是个会影响磁盘的动作。
            */}
            {task.status === 'running' && (
              <button
                type="button"
                onClick={() => onCancel(task)}
                className="shrink-0 rounded px-1 text-meta text-ink-500 hover:bg-state-bad/[0.06] hover:text-state-bad"
              >
                停止
              </button>
            )}
            {task.error && (
              <span className="shrink-0 max-w-[240px] truncate text-meta text-state-bad" title={task.error.message}>
                {task.error.message}
              </span>
            )}
          </li>
        ))}
      </ul>

      {settled && active.length === 0 && failed.length > 0 && (
        <p className="px-3 pb-1.5 text-meta text-state-bad">
          有任务失败。目标已存在时不会自动覆盖（这是刻意的安全默认）。
        </p>
      )}
    </section>
  )
}
