interface DeleteTarget {
  name: string
  kind: 'file' | 'dir'
}

interface ConfirmDeleteProps {
  side: 'local' | 'remote'
  targets: DeleteTarget[]
  busy?: boolean
  error?: PlainError | null
  /**
   * 本地删除失败后（通常是回收站不可用）才传 true，
   * 界面上会多出一个「永久删除」按钮。远端本来就没有回收站，不需要这个。
   */
  permanentAvailable?: boolean
  onPermanent?: () => void
  onCancel: () => void
  onConfirm: () => void
}

const MAX_SHOWN = 8

/**
 * 删除确认框。
 *
 * 本地和远端必须用**完全不同**的措辞，因为后果完全不同：
 * - 本地进回收站，可以捞回来 → 语气可以平和
 * - 远端删了就没了 → 必须把"不可恢复"说出来
 *
 * 只说"确定要删除吗"是不够的：用户点得太快就会习惯性确认。
 * 把"删几个、有没有目录、删完能不能找回"一次性摆出来，他才真的会看一眼。
 */
export function ConfirmDelete({
  side,
  targets,
  busy = false,
  error,
  permanentAvailable = false,
  onPermanent,
  onCancel,
  onConfirm
}: ConfirmDeleteProps): JSX.Element {
  const files = targets.filter((item) => item.kind === 'file').length
  const dirs = targets.filter((item) => item.kind === 'dir').length
  const isRemote = side === 'remote'
  const hasDir = dirs > 0

  const shown = targets.slice(0, MAX_SHOWN)
  const rest = targets.length - shown.length

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-inverse/25 px-6"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel()
      }}
    >
      <div className="w-full max-w-[460px] overflow-hidden rounded-surface border border-ink-200 bg-surface shadow-pop">
        <header className="border-b border-ink-100 px-5 py-3">
          <h2 className="text-emph font-semibold text-ink-900">
            删除 {targets.length} 项{isRemote ? '（集群）' : '（本机）'}
          </h2>
          <p className="mt-0.5 text-sub text-ink-500">
            {files > 0 && `${files} 个文件`}
            {files > 0 && dirs > 0 && '，'}
            {dirs > 0 && `${dirs} 个目录`}
          </p>
        </header>

        <div className="space-y-3 px-5 py-4">
          <ul className="max-h-40 space-y-0.5 overflow-y-auto rounded border border-ink-100 px-2 py-1.5">
            {shown.map((item) => (
              <li key={item.name} className="flex items-center gap-2 text-body text-ink-700">
                <span className="text-ink-300">{item.kind === 'dir' ? '▸' : '·'}</span>
                <span className="min-w-0 flex-1 truncate" title={item.name}>
                  {item.name}
                </span>
              </li>
            ))}
            {rest > 0 && <li className="px-1 pt-0.5 text-sub text-ink-500">还有 {rest} 项…</li>}
          </ul>

          {hasDir && (
            <div className="rounded-surface border border-state-wait/25 bg-state-wait/[0.06] px-3 py-2">
              <p className="text-body font-medium text-ink-900">
                目录会被整个删除，里面的所有文件都跟着没
              </p>
              <p className="mt-0.5 text-sub text-state-wait">
                不是只删空壳。确认前面没放别的要紧东西。
              </p>
            </div>
          )}

          {isRemote ? (
            <div className="rounded-surface border border-state-bad/25 bg-state-bad/[0.06] px-3 py-2">
              <p className="text-body font-medium text-state-bad">集群上没有回收站，删掉就找不回来了</p>
              <p className="mt-0.5 text-sub text-state-bad">
                重要的东西建议先下载到本机留一份。
              </p>
            </div>
          ) : (
            <div className="rounded-surface border border-ink-200 bg-ink-50/60 px-3 py-2">
              <p className="text-body text-ink-700">会移到系统回收站，需要时可以还原</p>
            </div>
          )}

          {error && (
            <div className="rounded-surface border border-state-bad/25 bg-state-bad/[0.06] px-3 py-2">
              <p className="selectable text-body font-medium text-state-bad">{error.message}</p>
              {error.hint && <p className="selectable mt-1 text-sub text-state-bad">→ {error.hint}</p>}
            </div>
          )}

          {permanentAvailable && (
            <div className="rounded-surface border border-t-2 border-state-wait/35 bg-state-wait/[0.06] px-3 py-2">
              <p className="text-body font-medium text-ink-900">改用永久删除？</p>
              <p className="mt-0.5 text-sub leading-relaxed text-state-wait">
                这一步<span className="font-semibold">不经过回收站</span>，删完无法恢复。
                如果只是回收站不可用（U 盘、网络盘、系统策略），文件本身没别的问题，可以走这里。
              </p>
              <button
                type="button"
                onClick={onPermanent}
                disabled={busy}
                className="mt-2 w-full rounded-surface border border-state-bad/35 bg-surface px-3 py-1.5 text-body font-medium text-state-bad transition hover:bg-state-bad/[0.05] disabled:opacity-50"
              >
                {busy ? '删除中…' : '我确认，永久删除'}
              </button>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-ink-100 bg-ink-50/40 px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-surface border border-ink-200 bg-surface px-3 py-1.5 text-body text-ink-700 transition hover:bg-ink-50 disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="rounded-surface bg-state-bad px-4 py-1.5 text-body font-medium text-white transition hover:bg-state-bad disabled:cursor-not-allowed disabled:bg-state-bad/40"
          >
            {busy ? '删除中…' : isRemote ? '确认删除（不可恢复）' : '移到回收站'}
          </button>
        </footer>
      </div>
    </div>
  )
}
