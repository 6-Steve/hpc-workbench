import { useEffect, useRef, useState } from 'react'

interface PromptDialogProps {
  title: string
  /** 输入框上方的说明，比如"当前名字"或"将建在哪个目录下" */
  subtitle?: string
  label: string
  /** 初值；重命名时是原名（不含扩展名会更好用，这里直接给全名） */
  initialValue: string
  confirmText?: string
  busy?: boolean
  error?: PlainError | null
  onCancel: () => void
  onConfirm: (value: string) => void
}

/**
 * 单行输入弹框，重命名和新建文件夹共用。
 *
 * 为什么不用 `window.prompt`：Electron 里它被禁用了，调了没反应。
 * 自己画还能顺手做「全选」「回车提交」「Esc 取消」这几件事。
 */
export function PromptDialog({
  title,
  subtitle,
  label,
  initialValue,
  confirmText = '确定',
  busy = false,
  error,
  onCancel,
  onConfirm
}: PromptDialogProps): JSX.Element {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus()

    // 重命名时习惯是把主文件名选中（不含扩展名），这样直接打字就能替换掉
    const dot = initialValue.lastIndexOf('.')
    if (dot > 0) input.setSelectionRange(0, dot)
    else input.select()
  }, [initialValue])

  const submit = (): void => {
    if (busy) return
    if (value.trim().length === 0) return
    onConfirm(value)
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-inverse/25 px-6"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel()
      }}
    >
      <div className="w-full max-w-[420px] overflow-hidden rounded-surface border border-ink-200 bg-surface shadow-pop">
        <header className="border-b border-ink-100 px-5 py-3">
          <h2 className="text-emph font-semibold text-ink-900">{title}</h2>
          {subtitle && <p className="mt-0.5 truncate text-sub text-ink-500">{subtitle}</p>}
        </header>

        <div className="space-y-3 px-5 py-4">
          <label className="block">
            <span className="mb-1 block text-sub uppercase tracking-wide text-ink-500">{label}</span>
            <input
              ref={inputRef}
              value={value}
              disabled={busy}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  submit()
                }
              }}
              className="w-full rounded-surface border border-ink-200 px-2.5 py-1.5 text-emph text-ink-900 outline-none transition focus:border-state-info focus:ring-2 focus:ring-state-info/20 disabled:bg-ink-50"
            />
          </label>

          {error && (
            <div className="rounded-surface border border-state-bad/25 bg-state-bad/[0.06] px-3 py-2">
              <p className="selectable text-body font-medium text-state-bad">{error.message}</p>
              {error.hint && <p className="selectable mt-1 text-sub text-state-bad">→ {error.hint}</p>}
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
            onClick={submit}
            disabled={busy || value.trim().length === 0}
            className="rounded-surface bg-inverse px-4 py-1.5 text-body font-medium text-white transition hover:bg-ink-800 disabled:cursor-not-allowed disabled:bg-ink-300"
          >
            {busy ? '处理中…' : confirmText}
          </button>
        </footer>
      </div>
    </div>
  )
}
