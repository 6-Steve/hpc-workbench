import { formatSize } from '../lib/format'

type ConflictPolicy = 'fail' | 'skip' | 'overwrite' | 'rename'

interface TransferDialogProps {
  plan: TransferPlan
  busy: boolean
  error: PlainError | null
  conflict: ConflictPolicy
  onConflictChange: (policy: ConflictPolicy) => void
  /** 仅增量同步用：勾选后要重新比对（选项影响"哪些文件进列表"） */
  syncOptions?: { overwriteNewer: boolean; force: boolean }
  onSyncOptionsChange?: (options: { overwriteNewer: boolean; force: boolean }) => void
  onCancel: () => void
  onConfirm: () => void
}

const STRATEGY_LABEL: Record<string, string> = {
  tar: '分段 tar',
  sftp: '单流 SFTP',
  multistream: '多流分块'
}

const CONFLICT_OPTIONS: Array<{ id: ConflictPolicy; label: string; hint: string }> = [
  { id: 'skip', label: '跳过', hint: '已存在的目标不动，任务标记为"已跳过"' },
  { id: 'overwrite', label: '覆盖', hint: '用新文件替换旧文件（目录不支持）' },
  { id: 'rename', label: '改名', hint: '自动存成 "名字 (1).ext"，保留旧文件' },
  { id: 'fail', label: '中止', hint: '遇到同名就报错停下' }
]

/**
 * 传输确认框（docs/02 §2.5 最后一段：把选择过程透明化）。
 *
 * 拖完直接开传是最容易误操作的实现——手滑拖错一个 200 GB 的目录，
 * 等发现时已经传了半小时。所以这里必须让用户先看清"多少个文件、多大、走哪条路、为什么"。
 */
export function TransferDialog({
  plan,
  busy,
  error,
  conflict,
  onConflictChange,
  syncOptions,
  onSyncOptionsChange,
  onCancel,
  onConfirm
}: TransferDialogProps): JSX.Element {
  const uploading = plan.direction === 'upload'
  const syncing = plan.mode === 'sync'
  const sync = plan.sync
  const effectiveLabel = STRATEGY_LABEL[plan.decision.effective] ?? plan.decision.effective
  const downgraded = plan.decision.strategy !== plan.decision.effective
  const hasDirectory = plan.items.some((item) => item.kind === 'dir')

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-inverse/25 px-6">
      <div className="w-full max-w-[520px] overflow-hidden rounded-surface border border-ink-200 bg-surface shadow-pop">
        <header className="border-b border-ink-100 px-5 py-3">
          <h2 className="text-emph font-semibold text-ink-900">
            {syncing ? (uploading ? '同步到集群' : '同步到本机') : uploading ? '上传到集群' : '下载到本机'}
          </h2>
          <p className="mt-0.5 text-sub text-ink-500">
            目标：<span className="selectable font-mono">{plan.targetDir}</span>
          </p>
        </header>

        <div className="space-y-3 px-5 py-4">
          {/*
            增量同步的摘要放在最上面：用户点「同步」之后第一个要回答的问题
            不是"传多大"，而是"到底会动哪些文件"。
          */}
          {syncing && sync && (
            <div className="rounded-surface border border-ink-200 bg-ink-50/60 px-3 py-2.5">
              <div className="grid grid-cols-5 gap-2 text-center">
                <div>
                  <div className="text-meta text-ink-500">新增</div>
                  <div className="font-mono text-emph font-semibold text-state-ok">{sync.counts.new}</div>
                </div>
                <div>
                  <div className="text-meta text-ink-500">更新</div>
                  <div className="font-mono text-emph font-semibold text-ink-900">{sync.counts.update}</div>
                </div>
                <div>
                  <div className="text-meta text-ink-500">未变</div>
                  <div className="font-mono text-emph font-semibold text-ink-500">{sync.counts.same}</div>
                </div>
                <div>
                  <div className="text-meta text-ink-500">冲突</div>
                  <div
                    className={
                      'font-mono text-emph font-semibold ' +
                      (sync.counts.conflict > 0 ? 'text-state-wait' : 'text-ink-500')
                    }
                  >
                    {sync.counts.conflict}
                  </div>
                </div>
                <div>
                  <div className="text-meta text-ink-500">对面独有</div>
                  <div className="font-mono text-emph font-semibold text-ink-500">
                    {sync.counts.orphan}
                  </div>
                </div>
              </div>

              <p className="mt-1.5 text-meta leading-relaxed text-ink-500">
                只增不删：对面独有的文件不会被删除、也不会被改动。
              </p>

              {sync.conflicts.length > 0 && (
                <details className="mt-1.5">
                  <summary className="cursor-pointer text-sub text-state-wait">
                    看这 {sync.conflicts.length} 个冲突
                  </summary>
                  <ul className="mt-1 max-h-24 space-y-0.5 overflow-y-auto">
                    {sync.conflicts.slice(0, 50).map((item) => (
                      <li key={item.rel} className="text-meta leading-relaxed text-ink-700">
                        <span className="selectable font-mono">{item.rel}</span>
                        {item.reason ? ` —— ${item.reason}` : ''}
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {onSyncOptionsChange && syncOptions && (
                <div className="mt-2 space-y-1">
                  <label className="flex items-start gap-2 text-sub leading-relaxed text-ink-700">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={syncOptions.overwriteNewer}
                      onChange={(event) =>
                        onSyncOptionsChange({ ...syncOptions, overwriteNewer: event.target.checked })
                      }
                    />
                    <span>覆盖对面更新的文件（会重算比对）</span>
                  </label>
                  <label className="flex items-start gap-2 text-sub leading-relaxed text-ink-700">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={syncOptions.force}
                      onChange={(event) =>
                        onSyncOptionsChange({ ...syncOptions, force: event.target.checked })
                      }
                    />
                    <span>强制全部重传（忽略大小与修改时间——用来兜住"同秒改过"的漏判）</span>
                  </label>
                </div>
              )}

              {sync.suggestFull && (
                <p className="mt-1.5 text-sub leading-relaxed text-state-wait">
                  变动太多，整包传输可能更快（每次传一个文件都要一次往返）。
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-surface border border-ink-200 bg-ink-50/60 px-3 py-2">
              <div className="text-meta uppercase tracking-wide text-ink-500">
                {syncing ? '要传的文件' : '文件'}
              </div>
              <div className="mt-0.5 text-emph font-semibold text-ink-900">{plan.stats.fileCount}</div>
            </div>
            <div className="rounded-surface border border-ink-200 bg-ink-50/60 px-3 py-2">
              <div className="text-meta uppercase tracking-wide text-ink-500">总大小</div>
              <div className="mt-0.5 text-emph font-semibold text-ink-900">{formatSize(plan.stats.totalBytes)}</div>
            </div>
            <div className="rounded-surface border border-ink-200 bg-ink-50/60 px-3 py-2">
              <div className="text-meta uppercase tracking-wide text-ink-500">最大文件</div>
              <div className="mt-0.5 text-emph font-semibold text-ink-900">{formatSize(plan.stats.largestFileBytes)}</div>
            </div>
          </div>

          <div className="rounded-surface border border-state-info/25 bg-state-info/[0.06] px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className="rounded bg-state-info px-1.5 py-0.5 text-meta font-medium text-white">
                {effectiveLabel}
                {downgraded ? '（降级）' : ''}
              </span>
              <span className="text-sub text-state-info">程序推荐</span>
            </div>
            <p className="mt-1.5 text-body leading-relaxed text-state-info">{plan.decision.reason}</p>
          </div>

          {plan.items.length > 0 && (
            <div>
              <div className="mb-1 text-sub uppercase tracking-wide text-ink-500">
                条目（{plan.items.length}）
              </div>
              <ul className="max-h-32 space-y-0.5 overflow-y-auto rounded border border-ink-100 px-2 py-1.5">
                {plan.items.map((item) => (
                  <li key={item.source} className="flex items-center gap-2 text-body text-ink-700">
                    <span className="text-ink-300">{item.kind === 'dir' ? '▸' : '·'}</span>
                    <span className="min-w-0 flex-1 truncate">{item.name}</span>
                    <span className="shrink-0 font-mono text-sub text-ink-500">{formatSize(item.stats.totalBytes)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 全都传不了的时候，按钮是灰的却没有解释——补一句，别让人以为是卡住了 */}
          {plan.items.length === 0 && (
            <p className="rounded-surface border border-ink-200 bg-ink-50/70 px-3 py-2 text-sub leading-relaxed text-ink-600">
              这次要传的东西一个都没法传（原因见下面）。换文件或目录再拖一次。
            </p>
          )}

          {plan.unsupported.length > 0 && (
            <div className="rounded-surface border border-state-wait/25 bg-state-wait/[0.06] px-3 py-2">
              <div className="text-sub font-medium uppercase tracking-wide text-state-wait">这次不会传</div>
              <ul className="mt-1 space-y-0.5">
                {plan.unsupported.map((item) => (
                  <li key={item.name} className="text-sub text-ink-900">
                    · {item.name} —— {item.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {plan.warnings.length > 0 && (
            <ul className="space-y-1">
              {plan.warnings.map((warning) => (
                <li key={warning} className="text-sub leading-relaxed text-state-wait">
                  · {warning}
                </li>
              ))}
            </ul>
          )}

          <div>
            <div className="mb-1 flex items-center gap-2">
              <span className="text-sub uppercase tracking-wide text-ink-500">目标已存在时</span>
              {hasDirectory && conflict === 'overwrite' && (
                <span className="text-meta text-state-wait">目录不支持覆盖，请改选</span>
              )}
            </div>
            <div className="flex gap-1">
              {CONFLICT_OPTIONS.map((option) => {
                const disabled = option.id === 'overwrite' && hasDirectory
                const active = conflict === option.id
                return (
                  <button
                    key={option.id}
                    type="button"
                    disabled={disabled}
                    title={disabled ? '目录不支持覆盖（会先删掉远端整个目录）' : option.hint}
                    onClick={() => onConflictChange(option.id)}
                    className={
                      'rounded-control border px-2.5 py-1 text-sub transition ' +
                      (active
                        ? 'border-ink-900 bg-inverse text-white'
                        : 'border-ink-200 bg-surface text-ink-600 hover:bg-ink-50') +
                      (disabled ? ' cursor-not-allowed opacity-40' : '')
                    }
                  >
                    {option.label}
                  </button>
                )
              })}
            </div>
            <p className="mt-1 text-sub leading-relaxed text-ink-500">
              {CONFLICT_OPTIONS.find((option) => option.id === conflict)?.hint}
            </p>
          </div>

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
            onClick={onConfirm}
            disabled={busy || plan.items.length === 0}
            className="rounded-surface bg-inverse px-4 py-1.5 text-body font-medium text-white transition hover:bg-ink-800 disabled:cursor-not-allowed disabled:bg-ink-300"
          >
            {busy ? '开始中…' : `开始传输${plan.items.length > 1 ? `（${plan.items.length} 项）` : ''}`}
          </button>
        </footer>
      </div>
    </div>
  )
}
