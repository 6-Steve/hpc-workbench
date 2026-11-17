/**
 * 取消传输的确认框。
 *
 * 存在的理由：中断一次正在跑的传输**两个方向都可能有残留**，
 * 而删不删这件事用户比程序清楚——
 *
 * - 上传中断 → 远端留下 `<目标>.part`，里面是传了一半的内容
 * - 下载中断 → 本机留下 `<目标>.part`
 *
 * 所以这里不是简单的"确定/取消"，而是把"已经传了多少"摆出来，
 * 再给三个选择：**保留**（默认，最安全）、**删掉再取消**、**继续传**。
 *
 * 默认选"保留"是刻意的：宁可留一个看得见的 `.part` 让人自己处理，
 * 也不要程序替人判断"这半截没用了"然后删掉。
 */

export interface CancelTransferTarget {
  label: string
  direction: 'upload' | 'download'
  /** 停下时已经传了多少字节 */
  bytesDone: number
  /** 半截文件在哪（远端绝对路径 / 本机绝对路径），没有残留时为空 */
  partialPath?: string
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export function ConfirmCancelTransfer({
  target,
  busy = false,
  onKeep,
  onDelete,
  onResume
}: {
  target: CancelTransferTarget
  busy?: boolean
  /** 保留半截文件，只中止传输 */
  onKeep: () => void
  /** 连半截文件一起删掉 */
  onDelete: () => void
  /** 改主意了，继续传 */
  onResume: () => void
}): JSX.Element {
  const isUpload = target.direction === 'upload'
  const side = isUpload ? '集群' : '本机'
  const hasPartial = Boolean(target.partialPath)

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-inverse/25 px-6"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onResume()
      }}
    >
      <div className="w-full max-w-[480px] overflow-hidden rounded-surface border border-ink-200 bg-surface shadow-pop">
        <header className="border-b border-ink-100 px-5 py-3">
          <h2 className="text-emph font-semibold text-ink-900">停止这次传输？</h2>
          <p className="mt-0.5 min-w-0 truncate text-sub text-ink-500" title={target.label}>
            {isUpload ? '↑' : '↓'} {target.label}
          </p>
        </header>

        <div className="space-y-3 px-5 py-4">
          {hasPartial ? (
            <>
              <div className="rounded-surface border border-ink-200 bg-ink-50/60 px-3 py-2">
                <p className="text-body text-ink-700">
                  已经传了 <span className="font-mono font-medium text-ink-900">{humanSize(target.bytesDone)}</span>
                  ，这部分留在{side}上：
                </p>
                <p
                  className="selectable mt-1 break-all font-mono text-meta text-ink-500"
                  title={target.partialPath}
                >
                  {target.partialPath}
                </p>
              </div>

              <div className="rounded-surface border border-state-wait/25 bg-state-wait/[0.06] px-3 py-2">
                <p className="text-body font-medium text-ink-900">它是个残缺文件</p>
                <p className="mt-0.5 text-sub leading-relaxed text-state-wait">
                  名字带 <span className="font-mono">.part</span>，不会被当成正常结果。
                  重新传一次是覆盖它，所以留着也不占新地方——除非磁盘快满了。
                </p>
              </div>
            </>
          ) : (
            <div className="rounded-surface border border-ink-200 bg-ink-50/60 px-3 py-2">
              <p className="text-body text-ink-700">
                还没有数据落到{side}上，停掉不会有残留。
              </p>
            </div>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-ink-100 bg-ink-50/40 px-5 py-3">
          <button
            type="button"
            onClick={onResume}
            disabled={busy}
            className="mr-auto rounded-surface border border-ink-200 bg-surface px-3 py-1.5 text-body text-ink-700 transition hover:bg-ink-50 disabled:opacity-50"
          >
            继续传
          </button>
          {hasPartial && (
            <button
              type="button"
              onClick={onDelete}
              disabled={busy}
              className="rounded-surface border border-state-bad/35 bg-surface px-3 py-1.5 text-body font-medium text-state-bad transition hover:bg-state-bad/[0.05] disabled:opacity-50"
            >
              {busy ? '处理中…' : '停止并删除'}
            </button>
          )}
          <button
            type="button"
            onClick={onKeep}
            disabled={busy}
            className="rounded-surface border border-ink-200 bg-surface px-3 py-1.5 text-body font-medium text-ink-700 transition hover:bg-ink-50 disabled:opacity-50"
          >
            {busy ? '处理中…' : hasPartial ? '停止并保留' : '停止'}
          </button>
        </footer>
      </div>
    </div>
  )
}
