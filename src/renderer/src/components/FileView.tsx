import { useCallback, useEffect, useRef, useState } from 'react'
import { FilePane, type DragPayload } from './FilePane'
import { TransferBar } from './TransferBar'
import { TransferDialog } from './TransferDialog'
import { ConfirmCancelTransfer, type CancelTransferTarget } from './ConfirmCancelTransfer'

type ConflictPolicy = 'fail' | 'skip' | 'overwrite' | 'rename'
type TaskSnapshot = QueueSnapshot['tasks'][number]

/**
 * 命中同名时的默认策略：**跳过**。
 *
 * 不用「中止」当默认：批量传一堆结果文件时，只要有一个已存在就整批停下，
 * 是最烦人的行为——用户真正想干的是"把新的传上去，旧的别管"。
 * 也不默认「覆盖」：目录场景 service 会直接拒绝，而且误删的代价太高。
 */
const DEFAULT_CONFLICT: ConflictPolicy = 'skip'

/**
 * 文件管理器双栏视图（docs/01 §3.2：左本地、右远程）。
 *
 * 支持：浏览、多选、右键文件操作、栏间拖拽、从资源管理器拖入、
 * 拖出到资源管理器、传输前确认（策略推荐 + 冲突处理）、「下载到…」。
 * 还不支持：远程↔远程。
 *
 * **本机栏默认收起**：多数时候用户是从桌面拖文件上来，
 * 或者用右键「下载到…」直接指定落点，不需要一直占着一栏。
 * 开关状态记在 localStorage，展开过一次以后就按用户的选择来。
 */
const LOCAL_VISIBLE_KEY = 'hpc.files.localVisible'

interface FileViewProps {
  /** 本机栏默认目录；null 表示用户主目录。由 App 统一持有，设置页也改它 */
  defaultStartDir: string | null
  onStartDirChange: (dir: string | null) => void
}

export function FileView({ defaultStartDir, onStartDirChange }: FileViewProps): JSX.Element {
  const [drag, setDrag] = useState<DragPayload | null>(null)
  // 默认收起；用户手动展开过就记住，下次按他的选择来
  const [localVisible, setLocalVisible] = useState<boolean>(() => {
    try {
      return localStorage.getItem(LOCAL_VISIBLE_KEY) === '1'
    } catch {
      return false
    }
  })
  const [plan, setPlan] = useState<TransferPlan | null>(null)
  const [planning, setPlanning] = useState(false)
  const [planError, setPlanError] = useState<PlainError | null>(null)
  const [starting, setStarting] = useState(false)
  const [conflict, setConflict] = useState<ConflictPolicy>(DEFAULT_CONFLICT)
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  /**
   * 正在等用户决定"半截文件删不删"的那个任务。
   *
   * 注意里面没有 taskId：点「停止」的那一刻还没真的停，要等主进程那边
   * 确认停下来并回报 `bytesDone` 之后才知道传了多少。所以这个状态是
   * **两段式**的：先弹"正在停止…"，拿到数字再变成"要删吗"。
   */
  const [cancelTarget, setCancelTarget] = useState<
    (CancelTransferTarget & { taskId: string; stopping: boolean }) | null
  >(null)

  const settledRef = useRef(false)

  useEffect(() => {
    window.hpc.onTransferUpdate((next) => {
      setSnapshot(next)
      const settled = next.tasks.length > 0 && next.running === 0 && next.queued === 0
      // 刚跑完一轮就刷新两侧目录，让用户看到结果
      if (settled && !settledRef.current) setRefreshKey((key) => key + 1)
      settledRef.current = settled
    })
  }, [])

  /**
   * 点「取消」（排队中）/「停止」（运行中）。
   *
   * 排队中的直接取消——磁盘上什么都没有，不需要问。
   * 运行中的先本地弹框占位，同时发 IPC；主进程等传输真的停下后回报字节数，
   * 再把弹框换成"删还是留"。
   */
  const handleCancelTask = useCallback(async (task: TaskSnapshot): Promise<void> => {
    if (task.status === 'queued') {
      await window.hpc.cancelTransfer({ taskId: task.id })
      return
    }

    // 运行中：先给个"正在停止"的框，别让用户以为按钮没反应
    setCancelTarget({
      taskId: task.id,
      label: task.label,
      direction: task.direction,
      bytesDone: task.bytes,
      partialPath: undefined,
      stopping: true
    })

    const response = await window.hpc.cancelTransfer({ taskId: task.id, cleanup: false })
    if (response.result === 'aborted') {
      setCancelTarget({
        taskId: task.id,
        label: task.label,
        direction: task.direction,
        bytesDone: response.bytesDone,
        partialPath: response.partialPath,
        stopping: false
      })
    } else {
      // 在等的时候它自己传完了（或已经没了）
      setCancelTarget(null)
    }
  }, [])

  /**
   * 用户在确认框里选了「停止并删除」。
   *
   * 传输已经停了（上一轮 IPC 已经把它标成 cancelled），所以这里不是再取消一次，
   * 而是直接删掉那个半截文件。走现成的 `deletePaths`：
   * 远端它就直接 rm，本机走回收站（`permanent` 不传）——万一用户后悔还能捞回来。
   */
  const handleCancelDelete = useCallback(async (): Promise<void> => {
    if (!cancelTarget?.partialPath) {
      setCancelTarget(null)
      return
    }
    const partialPath = cancelTarget.partialPath
    const isUpload = cancelTarget.direction === 'upload'
    await window.hpc.deletePaths({
      side: isUpload ? 'remote' : 'local',
      paths: [partialPath]
    })
    setCancelTarget(null)
    setRefreshKey((key) => key + 1)
  }, [cancelTarget])

  /** 增量同步的两个开关；改任意一个都要重新比对 */
  const [syncOptions, setSyncOptions] = useState<{ overwriteNewer: boolean; force: boolean }>({
    overwriteNewer: false,
    force: false
  })
  /** 上一次同步请求的参数，供"改选项后重算"复用 */
  const lastSyncRef = useRef<{
    direction: 'upload' | 'download'
    sourcePath: string
    targetDir: string
  } | null>(null)

  /** 两栏当前目录：增量同步要往「对面那一栏」同步，所以得知道它在哪 */
  const [paneDirs, setPaneDirs] = useState<{ local: string | null; remote: string | null }>({
    local: null,
    remote: null
  })

  /** 三个入口（栏间拖拽 / 外部拖入 / 下载到…）共用的「出计划」流程 */  const planTransfer = useCallback(
    async (
      direction: 'upload' | 'download',
      paths: string[],
      targetDir: string,
      mode: 'copy' | 'sync' = 'copy',
      sync?: { overwriteNewer?: boolean; force?: boolean }
    ): Promise<void> => {
      setPlanning(true)
      setPlanError(null)

      try {
        const response = await window.hpc.planTransfer({ direction, paths, targetDir, mode, sync })
        if (response.ok && response.plan) {
          setPlan(response.plan)
          setConflict(DEFAULT_CONFLICT)
        } else {
          setPlanError(response.error ?? { kind: 'ipc', message: '没有拿到传输计划', raw: JSON.stringify(response) })
        }
      } catch (err) {
        setPlanError({ kind: 'ipc', message: '统计失败', hint: '看开发终端日志。', raw: String(err) })
      } finally {
        setPlanning(false)
      }
    },
    []
  )

  /**
   * 同步到对面。
   *
   * 对面那一栏还没打开目录时**明说**，不猜默认目录——
   * 猜错的后果是往一个用户没看的地方写文件。
   */
  const handleSyncTo = useCallback(
    async (side: 'local' | 'remote', sourcePath: string): Promise<void> => {
      const targetDir = side === 'local' ? paneDirs.remote : paneDirs.local
      if (!targetDir) {
        setPlanError({
          kind: 'config',
          message: '对面那一栏还没打开目录',
          hint: '先在对面栏进一个目录，再回来同步。',
          raw: `${side}:${sourcePath}`
        })
        return
      }
      const direction = side === 'local' ? 'upload' : 'download'
      lastSyncRef.current = { direction, sourcePath, targetDir }
      setSyncOptions({ overwriteNewer: false, force: false })
      await planTransfer(direction, [sourcePath], targetDir, 'sync', {
        overwriteNewer: false,
        force: false
      })
    },
    [paneDirs, planTransfer]
  )

  const handleDrop = useCallback(
    async (targetSide: 'local' | 'remote', targetDir: string): Promise<void> => {
      if (!drag || drag.side === targetSide) return

      const payload = drag
      setDrag(null)
      await planTransfer(payload.side === 'local' ? 'upload' : 'download', payload.paths, targetDir)
    },
    [drag, planTransfer]
  )

  /**
   * 从系统资源管理器拖进来的文件（只能是上传）。
   *
   * 走的是和栏间拖拽**完全相同**的那条路：先出计划让用户确认，再入队。
   * 外部拖拽更应该确认——用户可能从桌面随手拖了一个几 GB 的文件夹进来。
   */
  const handleExternalDrop = useCallback(
    async (paths: string[], targetDir: string): Promise<void> => {
      await planTransfer('upload', paths, targetDir)
    },
    [planTransfer]
  )

  /**
   * 「下载到…」：先弹系统目录选择框，再走正常的计划 + 确认流程。
   *
   * 这是"把远端文件拖到资源管理器"的可靠替代。真正的拖拽导出（`startDrag`）
   * 要求文件已经在磁盘上，远端文件必须先下载完——那个等待期用户没法接受。
   * 选目录反而更快，而且目标一目了然。
   */
  const handleDownloadTo = useCallback(
    async (paths: string[]): Promise<void> => {
      const picked = await window.hpc.pickDirectory()
      if (!picked.ok || !picked.path) return
      await planTransfer('download', paths, picked.path)
    },
    [planTransfer]
  )

  const confirm = useCallback(async (): Promise<void> => {
    if (!plan) return
    setStarting(true)
    setPlanError(null)
    try {
      /*
       * 同步计划的冲突策略固定 `overwrite`：
       * "要覆盖哪些"已经在预览里由用户确认过了，队列这层再 skip 一次
       * 会把每一个"更新"都悄悄跳过——那才是真正的灾难。
       */
      const response = await window.hpc.startTransfer({
        planId: plan.id,
        onConflict: plan.mode === 'sync' ? 'overwrite' : conflict
      })
      if (response.ok && response.snapshot) {
        setSnapshot(response.snapshot)
        settledRef.current = false
        setPlan(null)
      } else {
        setPlanError(response.error ?? { kind: 'ipc', message: '启动失败', raw: JSON.stringify(response) })
      }
    } catch (err) {
      setPlanError({ kind: 'ipc', message: '启动失败', raw: String(err) })
    } finally {
      setStarting(false)
    }
  }, [plan, conflict])

  /** 把当前目录设成默认，或恢复成用户主目录 */
  const handleSetStartDir = useCallback(
    async (dir: string | null): Promise<void> => {
      const result = await window.hpc.setLocalStart(dir)
      onStartDirChange(result.dir)
    },
    [onStartDirChange]
  )

  /** 展开/收起本机栏，并把选择记下来 */
  const toggleLocal = useCallback((): void => {
    const next = !localVisible
    try {
      localStorage.setItem(LOCAL_VISIBLE_KEY, next ? '1' : '0')
    } catch {
      // 隐私模式或存储被禁用，记不住就记不住，不影响功能
    }
    setLocalVisible(next)
    // 收起时把"来自本机栏"的拖拽状态清掉，否则它会在后面误导方向判断
    if (!next) setDrag(null)
  }, [localVisible])

  /**
   * 往本机栏拖了本地文件 → 复制到这里。
   *
   * 这条路径同时服务两种场景：
   * 1. 从集群拖出来的文件（已经镜像到本地）拖到本机栏 = 下载落地
   * 2. 本机文件拖到本机另一个目录 = 普通复制
   */
  const handleCopyHere = useCallback(async (paths: string[], targetDir: string): Promise<void> => {
    try {
      const response = await window.hpc.copyLocal({ paths, targetDir })
      if (!response.ok && response.failed.length > 0) {
        setPlanError({
          kind: response.failed[0]!.error.kind,
          message: response.failed[0]!.error.message,
          hint: response.failed[0]!.error.hint,
          raw: response.failed[0]!.error.raw
        })
        return
      }
      setRefreshKey((key) => key + 1)
    } catch (err) {
      setPlanError({ kind: 'ipc', message: '复制失败', raw: String(err) })
    }
  }, [])

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-ink-100 bg-surface px-2 py-1">
        <button
          type="button"
          onClick={toggleLocal}
          title={localVisible ? '收起本机栏' : '展开本机栏'}
          className={
            'flex items-center gap-1.5 rounded px-2 py-1 text-sub transition ' +
            (localVisible
              ? 'bg-ink-100 font-medium text-ink-800'
              : 'text-ink-500 hover:bg-ink-50 hover:text-ink-700')
          }
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
            <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.1" />
            <path d="M6.5 2.5v11" stroke="currentColor" strokeWidth="1.1" />
            {localVisible && <rect x="2" y="3" width="4" height="10" rx="1" fill="currentColor" fillOpacity="0.25" />}
          </svg>
          本机栏
        </button>

        <span className="min-w-0 flex-1 truncate text-sub text-ink-500">
          {localVisible
            ? `本机默认目录：${defaultStartDir ?? '用户主目录'}　·　在空白处右键可改`
            : '下载：右键远端文件 →「下载到…」，或者展开本机栏直接拖过去'}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 divide-x divide-ink-200">
        {localVisible && (
          <FilePane
            side="local"
            title="本机"
            refreshKey={refreshKey}
            onDragStart={setDrag}
            onDropHere={(dir) => void handleDrop('local', dir)}
            onExternalDrop={(paths, dir) => void handleCopyHere(paths, dir)}
            defaultStartDir={defaultStartDir}
            onSetStartDir={(dir) => void handleSetStartDir(dir)}
            onSyncTo={(path) => void handleSyncTo('local', path)}
            onPathChange={(path) =>
              setPaneDirs((prev) => (prev.local === path ? prev : { ...prev, local: path }))
            }
          />
        )}
        <FilePane
          side="remote"
          title="集群"
          subtitle="SFTP"
          refreshKey={refreshKey}
          onDragStart={setDrag}
          onDropHere={(dir) => void handleDrop('remote', dir)}
          onExternalDrop={(paths, dir) => void handleExternalDrop(paths, dir)}
          onDownloadTo={(paths) => void handleDownloadTo(paths)}
          onSyncTo={(path) => void handleSyncTo('remote', path)}
          onPathChange={(path) =>
            setPaneDirs((prev) => (prev.remote === path ? prev : { ...prev, remote: path }))
          }
        />
      </div>

      {snapshot && (
        <TransferBar
          snapshot={snapshot}
          onCancel={(task) => void handleCancelTask(task)}
          onDismiss={() => setSnapshot(null)}
        />
      )}

      {cancelTarget && (
        <ConfirmCancelTransfer
          target={cancelTarget}
          busy={cancelTarget.stopping}
          onKeep={() => setCancelTarget(null)}
          onDelete={() => void handleCancelDelete()}
          onResume={() => setCancelTarget(null)}
        />
      )}

      {planning && (
        <div className="pointer-events-none fixed inset-x-0 bottom-8 flex justify-center">
          <div className="rounded-full bg-inverse/85 px-4 py-1.5 text-body text-white shadow-pop">
            正在统计文件数与体积…
          </div>
        </div>
      )}

      {plan && (
        <TransferDialog
          plan={plan}
          busy={starting}
          error={planError}
          conflict={conflict}
          onConflictChange={setConflict}
          syncOptions={plan.mode === 'sync' ? syncOptions : undefined}
          onSyncOptionsChange={(next) => {
            const last = lastSyncRef.current
            setSyncOptions(next)
            if (!last) return
            void planTransfer(last.direction, [last.sourcePath], last.targetDir, 'sync', next)
          }}
          onCancel={() => {
            setPlan(null)
            setPlanError(null)
          }}
          onConfirm={() => void confirm()}
        />
      )}

      {!plan && planError && (
        <div className="fixed inset-x-0 bottom-8 flex justify-center px-6">
          <div className="max-w-[560px] rounded-surface border border-state-bad/25 bg-surface px-4 py-3 shadow-pop">
            <p className="text-body font-medium text-state-bad">{planError.message}</p>
            {planError.hint && <p className="mt-1 text-sub text-state-bad">→ {planError.hint}</p>}
            {planError.raw && (
              <details className="mt-2">
                <summary className="cursor-pointer text-sub text-ink-500">原始信息</summary>
                <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-meta text-ink-600">
                  {planError.raw}
                </pre>
              </details>
            )}
            <button
              type="button"
              onClick={() => setPlanError(null)}
              className="mt-2 rounded border border-ink-200 px-2 py-0.5 text-sub text-ink-600 hover:bg-ink-50"
            >
              关闭
            </button>
          </div>
        </div>
      )}
    </main>
  )
}
