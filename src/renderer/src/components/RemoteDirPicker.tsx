import { useCallback, useEffect, useState } from 'react'

interface RemoteDirPickerProps {
  title?: string
  /** 起始目录；null = 远端 home */
  startPath?: string | null
  /**
   * `dir` = 选目录（默认）；`file` = 选文件。
   * 选文件时目录仍然可以点进去，只有匹配 filter 的文件才是"可选中的"。
   */
  mode?: 'dir' | 'file'
  /** file 模式下哪些文件可选，默认所有文件 */
  filter?: (name: string) => boolean
  onCancel: () => void
  onPick: (path: string) => void
}

/**
 * 远端目录选择器。
 *
 * 为什么不用 `dialog.showOpenDialog`：那个只能选**本机**目录。
 * 这里要选集群上的路径，只能自己走 SFTP 列目录。
 *
 * 只显示目录，不显示文件——选的是"存到哪个目录"，不是选文件。
 */
export function RemoteDirPicker({
  title = '选择脚本保存位置',
  startPath = null,
  mode = 'dir',
  filter,
  onCancel,
  onPick
}: RemoteDirPickerProps): JSX.Element {
  const [path, setPath] = useState<string | null>(startPath)
  const [listing, setListing] = useState<DirListing | null>(null)
  const [error, setError] = useState<PlainError | null>(null)
  const [loading, setLoading] = useState(false)
  /** file 模式下选中的文件（完整路径） */
  const [selected, setSelected] = useState<string | null>(null)
  /** 非 null 表示正在输入新文件夹名 */
  const [newName, setNewName] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const load = useCallback(async (target?: string): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const response = await window.hpc.listDir({ side: 'remote', path: target })
      if (response.ok && response.listing) {
        setListing(response.listing)
        setPath(response.listing.path)
      } else {
        setError(response.error ?? { kind: 'ipc', message: '打不开这个目录', raw: JSON.stringify(response) })
      }
    } catch (err) {
      setError({ kind: 'ipc', message: '读取目录失败', raw: String(err) })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(startPath ?? undefined)
    // 只在挂载时读一次，之后靠用户导航
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const join = (name: string): string =>
    listing ? (listing.path.endsWith('/') ? `${listing.path}${name}` : `${listing.path}/${name}`) : name

  const createFolder = useCallback(async (): Promise<void> => {
    const name = (newName ?? '').trim()
    if (!name || !path) return

    setCreating(true)
    setCreateError(null)
    try {
      const response = await window.hpc.makeDir({ side: 'remote', parent: path, name })
      if (response.ok) {
        setNewName(null)
        await load(path)
      } else {
        setCreateError(response.error?.message ?? '新建失败')
      }
    } catch (err) {
      setCreateError(String(err))
    } finally {
      setCreating(false)
    }
  }, [newName, path, load])

  const enter = (name: string): void => {
    setSelected(null)
    void load(join(name))
  }

  const dirs = listing ? listing.entries.filter((entry) => entry.kind === 'dir') : []
  const files =
    listing && mode === 'file'
      ? listing.entries.filter((entry) => entry.kind === 'file' && (!filter || filter(entry.name)))
      : []

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-inverse/25 px-6"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel()
      }}
    >
      <div className="flex max-h-[80vh] w-full max-w-[520px] flex-col overflow-hidden rounded-surface border border-ink-200 bg-surface shadow-pop">
        <header className="relative shrink-0 border-b border-ink-100 px-5 py-3 pr-12">
          <h2 className="text-emph font-semibold text-ink-900">{title}</h2>
          <button
            type="button"
            aria-label="关闭"
            onClick={onCancel}
            className="absolute right-3 top-3 grid h-6 w-6 place-items-center rounded text-ink-500 transition hover:bg-ink-100 hover:text-ink-700"
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
          <p className="mt-0.5 truncate font-mono text-sub text-ink-500" title={selected ?? path ?? ''}>
            {selected ?? path ?? '读取中…'}
          </p>
        </header>

        <div className="flex shrink-0 items-center gap-1.5 border-b border-ink-100 px-3 py-1.5">
          <button
            type="button"
            disabled={!listing?.parent || loading}
            onClick={() => listing?.parent && void load(listing.parent)}
            className="rounded border border-ink-200 px-2 py-0.5 text-sub text-ink-600 transition hover:bg-ink-50 disabled:opacity-40"
          >
            ← 上一级
          </button>
          <button
            type="button"
            onClick={() => void load(path ?? undefined)}
            disabled={loading}
            className="rounded border border-ink-200 px-2 py-0.5 text-sub text-ink-600 transition hover:bg-ink-50 disabled:opacity-40"
          >
            刷新
          </button>
          <button
            type="button"
            onClick={() => {
              setNewName('')
              setCreateError(null)
            }}
            disabled={!path || loading}
            className="rounded border border-ink-200 px-2 py-0.5 text-sub text-ink-600 transition hover:bg-ink-50 disabled:opacity-40"
          >
            + 新建文件夹
          </button>
        </div>

        {newName !== null && (
          <div className="shrink-0 border-b border-ink-100 bg-state-info/[0.04] px-3 py-1.5">
            <div className="flex items-center gap-1.5">
              <input
                autoFocus
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void createFolder()
                  if (event.key === 'Escape') setNewName(null)
                }}
                placeholder="新文件夹名字"
                className="min-w-0 flex-1 rounded border border-ink-200 px-2 py-1 text-body outline-none focus:border-state-info"
              />
              <button
                type="button"
                onClick={() => void createFolder()}
                disabled={creating || (newName ?? '').trim().length === 0}
                className="shrink-0 rounded bg-inverse px-2 py-1 text-sub text-white transition hover:bg-ink-800 disabled:bg-ink-300"
              >
                {creating ? '创建中…' : '创建'}
              </button>
              <button
                type="button"
                onClick={() => setNewName(null)}
                className="shrink-0 rounded px-1.5 py-1 text-sub text-ink-500 transition hover:bg-ink-100"
              >
                取消
              </button>
            </div>
            {createError && <p className="mt-1 text-sub text-state-bad">{createError}</p>}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
          {error && (
            <div className="m-2 rounded border border-state-bad/25 bg-state-bad/[0.06] px-3 py-2">
              <p className="selectable text-body text-state-bad">{error.message}</p>
              {error.raw && (
                <pre className="selectable mt-1 max-h-24 overflow-auto whitespace-pre-wrap font-mono text-meta text-state-bad">
                  {error.raw}
                </pre>
              )}
            </div>
          )}

          {!error && dirs.length === 0 && !loading && (
            <p className="px-3 py-6 text-center text-body text-ink-500">这个目录下没有子目录</p>
          )}

          {files.map((entry) => {
            const full = join(entry.name)
            const active = selected === full
            return (
              <button
                key={entry.name}
                type="button"
                onClick={() => setSelected(full)}
                onDoubleClick={() => onPick(full)}
                className={
                  'flex w-full items-center gap-2 rounded px-2 py-1 text-left text-body transition ' +
                  (active ? 'bg-state-info/12 text-ink-900' : 'text-ink-600 hover:bg-ink-50')
                }
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="shrink-0 text-ink-300">
                  <path d="M4 1.5h5l3 3v10h-8v-13Z" stroke="currentColor" strokeWidth="1.1" />
                </svg>
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              </button>
            )
          })}

          {dirs.map((entry) => (
            <button
              key={entry.name}
              type="button"
              onDoubleClick={() => enter(entry.name)}
              onClick={() => enter(entry.name)}
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-body text-ink-700 transition hover:bg-ink-50"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="shrink-0 text-ink-500">
                <path
                  d="M1.5 4.5a1 1 0 0 1 1-1h3.2l1.3 1.5h6.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1v-7.5Z"
                  stroke="currentColor"
                  strokeWidth="1.1"
                />
              </svg>
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            </button>
          ))}
        </div>

        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-ink-100 bg-ink-50/40 px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-surface border border-ink-200 bg-surface px-3 py-1.5 text-body text-ink-700 transition hover:bg-ink-50"
          >
            取消
          </button>
          <button
            type="button"
            disabled={mode === 'file' ? !selected : !path || loading}
            onClick={() => {
              if (mode === 'file') {
                if (selected) onPick(selected)
                return
              }
              if (path) onPick(path)
            }}
            className="rounded-surface bg-inverse px-4 py-1.5 text-body font-medium text-white transition hover:bg-ink-800 disabled:bg-ink-300"
          >
            {mode === 'file' ? (selected ? '用这个脚本' : '先选一个脚本') : '用这个目录'}
          </button>
        </footer>
      </div>
    </div>
  )
}
