import { useCallback, useEffect, useRef, useState } from 'react'
import { parseUriList } from '../lib/drop-path'
import { formatSize, formatTime } from '../lib/format'
import {
  EMPTY_SELECTION,
  applyClick,
  moveFocus,
  pruneSelection,
  selectAll,
  type SelectionState
} from '../lib/selection'
import { ConfirmDelete } from './ConfirmDelete'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { PromptDialog } from './PromptDialog'
import { VirtualList } from './VirtualList'
import { EmptyState, StatusDot } from './ui'

/**
 * 行高必须固定，虚拟滚动才能靠下标直接算位置。
 * 28px 是按原来的观感定的（12.5px 字 × 1.5 行高 + 上下各 5px 呼吸），
 * **改行内样式时必须同步改这个数**，否则行会互相挤压或出现缝隙。
 */
const ROW_HEIGHT = 28

export interface DragPayload {
  side: 'local' | 'remote'
  dir: string
  /** 完整路径列表（本地用 `\`，远端用 `/`） */
  paths: string[]
  names: string[]
}

interface FilePaneProps {
  side: 'local' | 'remote'
  title: string
  subtitle?: string
  refreshKey?: number
  onDragStart?: (payload: DragPayload) => void
  onDropHere?: (targetDir: string) => void
  /**
   * 从**系统资源管理器**拖文件进来。只有远程栏会接到这个回调——
   * 外部文件本来就来自本机，拖到本机栏没有意义。
   */
  onExternalDrop?: (paths: string[], targetDir: string) => void
  /**
   * 「下载到…」：选一个本机目录直接下载，不用在应用里一层层导航过去。
   * 只有集群栏会接到。
   */
  onDownloadTo?: (paths: string[]) => void
  /** 「同步到对面…」：只在选中**单个目录**时出现 */
  onSyncTo?: (directoryPath: string) => void
  /** 当前目录变化时通知外面（增量同步要知道对面栏在哪个目录） */
  onPathChange?: (path: string) => void
  /** 本机栏打开时默认进入的目录；null 表示用户主目录 */
  defaultStartDir?: string | null
  /** 设置/清除默认目录（传 null 表示恢复成用户主目录） */
  onSetStartDir?: (dir: string | null) => Promise<void> | void
}

/** 比较两个本地路径是否指同一个目录：Windows 不区分大小写，尾部斜杠也忽略 */
function samePath(a: string, b: string): boolean {
  const normalize = (path: string): string => path.replace(/[\\/]+$/, '').toLowerCase()
  return normalize(a) === normalize(b)
}

/** 路径切面包屑；远端用 `/`，本地用 `\` */
function buildCrumbs(
  path: string,
  separator: string,
  virtualRoot: boolean
): Array<{ label: string; path: string }> {
  // 「此电脑」不是一个真路径，硬拆会得到 `::drives::\` 这种鬼东西
  if (virtualRoot) return [{ label: '此电脑', path }]

  if (separator === '/') {
    const segments = path.split('/').filter(Boolean)
    const crumbs = [{ label: '/', path: '/' }]
    let accumulated = ''
    for (const segment of segments) {
      accumulated = `${accumulated}/${segment}`
      crumbs.push({ label: segment, path: accumulated })
    }
    return crumbs
  }

  const segments = path.split(/[\\/]/).filter(Boolean)
  const crumbs: Array<{ label: string; path: string }> = []
  let accumulated = ''
  segments.forEach((segment, index) => {
    accumulated = index === 0 ? `${segment}\\` : `${accumulated}${accumulated.endsWith('\\') ? '' : '\\'}${segment}`
    crumbs.push({ label: segment, path: accumulated })
  })
  return crumbs
}

function DirIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0 text-state-wait">
      <path
        d="M1.5 3.5A1 1 0 0 1 2.5 2.5h3.2l1.1 1.4h6.7a1 1 0 0 1 1 1v7.6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"
        fill="currentColor"
        fillOpacity="0.18"
        stroke="currentColor"
        strokeWidth="1"
      />
    </svg>
  )
}

function FileIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0 text-ink-500">
      <path d="M3.5 1.5h6L12.5 4.5v10h-9z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
      <path d="M9.3 1.6v3h3" stroke="currentColor" strokeWidth="1" />
    </svg>
  )
}

export function FilePane({
  side,
  title,
  subtitle,
  refreshKey = 0,
  onDragStart,
  onDropHere,
  onExternalDrop,
  onDownloadTo,
  onSyncTo,
  onPathChange,
  defaultStartDir = null,
  onSetStartDir
}: FilePaneProps): JSX.Element {
  const [listing, setListing] = useState<DirListing | null>(null)
  const [error, setError] = useState<PlainError | null>(null)
  const [loading, setLoading] = useState(false)
  /**
   * 多选状态。**不是一个 string[]**：Shift 区间需要一个锚点，
   * 键盘移动需要一个焦点，两者都不能从"当前选中了哪些"反推出来。
   * 具体语义见 `lib/selection.ts`（那里有完整的按键行为表）。
   */
  const [selection, setSelection] = useState<SelectionState>(EMPTY_SELECTION)
  const [dragOver, setDragOver] = useState(false)

  // —— 文件操作相关的界面状态 ——
  const [menu, setMenu] = useState<{ x: number; y: number; onEntry: boolean } | null>(null)
  const [prompt, setPrompt] = useState<
    | { mode: 'rename'; path: string; initial: string }
    | { mode: 'mkdir'; parent: string }
    | null
  >(null)
  const [pendingDelete, setPendingDelete] = useState<{ paths: string[]; targets: Array<{ name: string; kind: 'file' | 'dir' }> } | null>(null)
  const [opBusy, setOpBusy] = useState(false)
  const [opError, setOpError] = useState<PlainError | null>(null)
  /** 本地删除失败后置 true，确认框里才出现「永久删除」这条路 */
  const [trashBlocked, setTrashBlocked] = useState(false)
  /** 拖出到资源管理器时，第一次要先把远端文件落地 */
  const [dragOut, setDragOut] = useState<{ name: string; bytes: number; total: number } | null>(null)
  /**
   * 剪切/复制剪贴板。
   *
   * 为什么自己维护一份而不用系统剪贴板：文件名走系统剪贴板没法表达
   * "这是同一台机器上的路径"，粘贴到别的应用里会变成一段莫名其妙的文本。
   * 这里只支持应用内移动，够用且不会出错。
   */
  const [clipboard, setClipboard] = useState<{ side: 'local' | 'remote'; paths: string[]; names: string[]; mode: 'cut' | 'copy' } | null>(null)
  /** 正在移动（批量时可能慢），用来禁用重复触发 */
  const [moving, setMoving] = useState(false)

  const sectionRef = useRef<HTMLElement | null>(null)

  const load = useCallback(
    async (path?: string, options: { noCache?: boolean } = {}) => {
      setLoading(true)
      setError(null)
      try {
        const response = await window.hpc.listDir({ side, path, noCache: options.noCache })
        if (response.ok && response.listing) {
          setListing(response.listing)
          // 刷新后可能有条目没了（被别处删掉、或者刚移走），把不存在的选择剔掉。
          // 不能无脑清空——刷新不该让用户重新选一遍。
          const names = response.listing.entries.map((entry) => entry.name)
          setSelection((current) => pruneSelection(names, current))
        } else {
          setError(
            response.error ?? { kind: 'ipc', message: '主进程没有返回目录内容', raw: JSON.stringify(response) }
          )
        }
      } catch (err) {
        setError({
          kind: 'ipc',
          message: '调用主进程失败',
          hint: '看开发终端日志；必要时重启 npm run dev。',
          raw: String(err)
        })
      } finally {
        setLoading(false)
      }
    },
    [side]
  )

  /** 刷新当前目录，强制绕过缓存 */
  const refresh = useCallback((): void => {
    if (listing) void load(listing.path, { noCache: true })
  }, [listing, load])

  useEffect(() => {
    void load()
  }, [load])

  // 把当前目录告诉外面：增量同步要知道"对面那一栏"在哪个目录
  useEffect(() => {
    if (listing) onPathChange?.(listing.path)
  }, [listing, onPathChange])

  // 拖出的下载进度。只有集群栏需要，本机栏不订阅，
  // 否则两个实例会互相 removeAllListeners 覆盖掉对方的监听。
  useEffect(() => {
    if (side !== 'remote') return
    window.hpc.onDragProgress((progress) => {
      setDragOut((current) => (current ? { ...current, ...progress } : current))
    })
  }, [side])

  // 传输完成后刷新当前目录（不跳回初始位置）；传完文件肯定变了，绕过缓存
  useEffect(() => {
    if (refreshKey === 0) return
    void load(listing?.path, { noCache: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  const joinPath = (dir: string, name: string, separator: string): string =>
    dir.endsWith(separator) ? `${dir}${name}` : `${dir}${separator}${name}`

  const enter = (entry: DirEntry): void => {
    // 正在读的时候再双击只会重复发请求 —— 用户以为"没反应"就会连点
    if (loading || entry.kind !== 'dir' || !listing) return

    // 在「此电脑」里双击盘符：`C:` → `C:\`，不能直接拼分隔符
    if (listing.virtualRoot) {
      void load(entry.name.endsWith(listing.separator) ? entry.name : `${entry.name}${listing.separator}`)
      return
    }

    void load(joinPath(listing.path, entry.name, listing.separator))
  }

  /**
   * 点一行 / 按方向键之后更新选择。
   *
   * 真正的规则在 `lib/selection.ts`：单击替换、Ctrl 增删、Shift 拉区间、
   * 锚点钉在最后一次不带 Shift 的点击上。这里只负责把**当前列表的名字**
   * 喂进去（Shift 区间要靠它换算下标）。
   */
  const names = listing ? listing.entries.map((entry) => entry.name) : []

  const selected = selection.selected

  // —— 文件操作 ——

  // 写操作之后的刷新统一走上面那个 `refresh()`（绕过缓存），不留旧数据

  /** 当前选中的条目（按目录里的原始顺序，而不是点击顺序） */
  const selectedEntries = (): DirEntry[] => {
    if (!listing) return []
    return listing.entries.filter((entry) => selected.includes(entry.name))
  }

  const fullPath = (name: string): string => (listing ? joinPath(listing.path, name, listing.separator) : name)

  const openDelete = useCallback(
    (entries: DirEntry[]): void => {
      if (entries.length === 0) return
      setOpError(null)
      setTrashBlocked(false)
      setPendingDelete({
        paths: entries.map((entry) => (listing ? joinPath(listing.path, entry.name, listing.separator) : entry.name)),
        targets: entries.map((entry) => ({ name: entry.name, kind: entry.kind === 'dir' ? 'dir' : 'file' }))
      })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [listing]
  )

  const runDelete = useCallback(
    async (permanent = false): Promise<void> => {
      if (!pendingDelete) return
      setOpBusy(true)
      setOpError(null)
      try {
        const response = await window.hpc.deletePaths({ side, paths: pendingDelete.paths, permanent })
        if (response.ok) {
          setPendingDelete(null)
          setTrashBlocked(false)
          setSelection(EMPTY_SELECTION)
          refresh()
          return
        }
        // 部分或全部失败：把明细拼出来，别只说"失败"
        const detail =
          response.failed.length > 0
            ? `${response.failed[0]!.error.message}${
                response.failed.length > 1 ? `（还有 ${response.failed.length - 1} 项也失败了）` : ''
              }`
            : (response.error?.message ?? '删除失败')
        setOpError({
          kind: response.error?.kind ?? 'unknown',
          message: response.deleted.length > 0 ? `删掉了 ${response.deleted.length} 项，但${detail}` : detail,
          hint: response.failed[0]?.error.hint ?? response.error?.hint,
          raw: response.error?.raw ?? JSON.stringify(response.failed, null, 2)
        })
        // 本地删除失败 → 大概率是回收站不可用，给用户一条出路
        if (side === 'local' && !permanent && response.deleted.length === 0) setTrashBlocked(true)
        if (response.deleted.length > 0) {
          setSelection(EMPTY_SELECTION)
          refresh()
        }
      } catch (err) {
        setOpError({ kind: 'ipc', message: '删除请求失败', raw: String(err) })
      } finally {
        setOpBusy(false)
      }
    },
    [pendingDelete, side, refresh]
  )

  const runRename = useCallback(
    async (newName: string): Promise<void> => {
      if (!prompt || prompt.mode !== 'rename') return
      setOpBusy(true)
      setOpError(null)
      try {
        const response = await window.hpc.renamePath({ side, path: prompt.path, newName })
        if (response.ok) {
          setPrompt(null)
          setSelection(EMPTY_SELECTION)
          refresh()
          return
        }
        setOpError(response.error ?? { kind: 'ipc', message: '重命名失败', raw: JSON.stringify(response) })
      } catch (err) {
        setOpError({ kind: 'ipc', message: '重命名请求失败', raw: String(err) })
      } finally {
        setOpBusy(false)
      }
    },
    [prompt, side, refresh]
  )

  const runMkdir = useCallback(
    async (name: string): Promise<void> => {
      if (!prompt || prompt.mode !== 'mkdir') return
      setOpBusy(true)
      setOpError(null)
      try {
        const response = await window.hpc.makeDir({ side, parent: prompt.parent, name })
        if (response.ok) {
          setPrompt(null)
          refresh()
          return
        }
        setOpError(response.error ?? { kind: 'ipc', message: '新建失败', raw: JSON.stringify(response) })
      } catch (err) {
        setOpError({ kind: 'ipc', message: '新建请求失败', raw: String(err) })
      } finally {
        setOpBusy(false)
      }
    },
    [prompt, side, refresh]
  )

  /**
   * 把一批条目移动到一个目录。
   *
   * 主进程是逐条做的，所以这里必须**如实汇报成功几项、失败几项**，
   * 而不是一个笼统的"移动失败"。批量操作里最难受的就是不知道哪几个没动。
   */
  const runMove = useCallback(
    async (paths: string[], names: string[], targetDir: string): Promise<void> => {
      if (paths.length === 0 || moving) return
      setMoving(true)
      setOpError(null)
      try {
        const response = (await window.hpc.movePaths({ side, paths, targetDir })) as {
          ok: boolean
          moved: string[]
          failed: Array<{ path: string; error: PlainError }>
          error?: PlainError
        }

        if (response.moved.length > 0) {
          // 移走的那些不该继续留在选中状态里（留在原地没成功的要保持选中，
          // 否则用户看不出是哪几个没搬走）。按**失败路径集合**反推，
          // 不按下标配对——那样一旦 paths / names 顺序错位就会静默选错。
          const failedPaths = new Set(response.failed.map((item) => item.path))
          const movedNames = new Set(names.filter((_, index) => !failedPaths.has(paths[index]!)))
          setSelection((current) => ({
            ...current,
            selected: current.selected.filter((name) => !movedNames.has(name))
          }))
          refresh()
        }

        if (response.failed.length > 0) {
          const first = response.failed[0]!
          setOpError({
            kind: first.error.kind,
            message:
              response.moved.length > 0
                ? `移走了 ${response.moved.length} 项，但「${first.error.message}」`
                : first.error.message,
            hint:
              response.failed.length > 1
                ? `${response.failed.length} 项没能移动，第一项就是上面这个原因。`
                : first.error.hint,
            raw: response.error?.raw ?? JSON.stringify(response.failed, null, 2)
          })
        }
      } catch (err) {
        setOpError({ kind: 'ipc', message: '移动请求失败', raw: String(err) })
      } finally {
        setMoving(false)
      }
    },
    [side, refresh, moving]
  )

  /** 「移动到…」：弹系统目录选择框，选中后把那批文件搬过去 */
  const handleMoveTo = useCallback(async (): Promise<void> => {
    const entries = selectedEntries()
    if (entries.length === 0) return
    const picked = await window.hpc.pickDirectory()
    if (!picked.ok || !picked.path) return
    await runMove(
      entries.map((entry) => fullPath(entry.name)),
      entries.map((entry) => entry.name),
      picked.path
    )
  }, [selectedEntries, runMove])

  /** 把剪贴板里的东西粘到这个目录（仅同一侧；跨侧请用拖拽或「下载到…」） */
  const pasteHere = useCallback(async (): Promise<void> => {
    if (!listing || !clipboard) return
    if (clipboard.side !== side) return

    if (clipboard.mode === 'cut') {
      await runMove(clipboard.paths, clipboard.names, listing.path)
      setClipboard(null)
      return
    }

    // copy 模式：目前只在本地实现（远端复制要递归 sfcp，没有做）
    if (side !== 'local') {
      setOpError({
        kind: 'config',
        message: '集群上还不支持复制粘贴',
        hint: '拖到对面栏，或者用右键「下载到…」。',
        raw: JSON.stringify(clipboard)
      })
      return
    }
    setMoving(true)
    try {
      const response = await window.hpc.copyLocal({ paths: clipboard.paths, targetDir: listing.path })
      if (response.failed.length > 0) {
        setOpError({
          kind: response.failed[0]!.error.kind,
          message: response.failed[0]!.error.message,
          hint: response.failed[0]!.error.hint,
          raw: response.failed[0]!.error.raw
        })
      }
      if (response.copied.length > 0) refresh()
    } finally {
      setMoving(false)
    }
  }, [listing, clipboard, side, runMove, refresh])

  /** 右键：点在条目上是"针对这个文件"，点在空白处是"针对这个目录" */
  const handleContextMenu = (event: React.MouseEvent, entry?: DirEntry): void => {
    // 「此电脑」这一层只是入口，没有可操作的文件
    if (listing?.virtualRoot) return
    event.preventDefault()
    // 行上的右键不能再冒到外层，否则会同时打开"针对目录"的菜单
    event.stopPropagation()
    // 右键点在**没选中**的行上：先把它变成唯一选中项（资源管理器也是这样），
    // 右侧菜单的"删除 3 项"才不会误伤之前多选的那几个。
    // 点在已选中的行上则保留整个多选——那样才能批量操作。
    if (entry && !selected.includes(entry.name)) {
      setSelection({ selected: [entry.name], anchor: entry.name, focus: entry.name })
      sectionRef.current?.focus()
    }
    setOpError(null)
    setMenu({ x: event.clientX, y: event.clientY, onEntry: Boolean(entry) })
  }

  const menuItems: MenuItem[] = menu?.onEntry
    ? [
        // 集群栏才有「下载到…」：选一个本机目录直接下，不用先导航过去
        ...(onDownloadTo
          ? [{ id: 'download-to', label: selected.length > 1 ? `下载 ${selected.length} 项到…` : '下载到…' }]
          : []),
        // 只对**单个目录**开放：增量同步的语义是"让对面那个目录追上这个目录"，
        // 多选或单文件都没有对应的语义。
        ...(onSyncTo && selected.length === 1 && selectedEntries()[0]?.kind === 'dir'
          ? [{ id: 'sync-to', label: '同步到对面…' }]
          : []),
        {
          id: 'move-to',
          label: selected.length > 1 ? `移动 ${selected.length} 项到…` : '移动到…',
          // 「此电脑」这一层里条目是盘符，不是可移动的东西
          disabled: Boolean(listing?.virtualRoot),
          disabledReason: '盘符不能移动'
        },
        {
          id: 'cut',
          label: '剪切',
          shortcut: 'Ctrl+X',
          disabled: Boolean(listing?.virtualRoot),
          disabledReason: '盘符不能剪切'
        },
        {
          id: 'copy',
          label: '复制',
          shortcut: 'Ctrl+C',
          disabled: Boolean(listing?.virtualRoot),
          disabledReason: '盘符不能复制'
        },
        {
          id: 'delete',
          label: selected.length > 1 ? `删除 ${selected.length} 项` : '删除',
          shortcut: 'Del',
          danger: true
        },
        {
          id: 'rename',
          label: '重命名',
          shortcut: 'F2',
          disabled: selected.length !== 1,
          disabledReason: '一次只能改一个名字'
        }
      ]
    : [
        { id: 'mkdir', label: '新建文件夹' },
        // 剪贴板里有东西时才出现「粘贴」，否则是个永远灰着的噪音
        ...(clipboard && clipboard.side === side && !listing?.virtualRoot
          ? [
              {
                id: 'paste',
                label: clipboard.mode === 'cut' ? `移动到此处（${clipboard.paths.length} 项）` : `复制到此处（${clipboard.paths.length} 项）`,
                shortcut: 'Ctrl+V'
              }
            ]
          : []),
        // 本机栏才有"默认目录"这一组设置
        ...(onSetStartDir
          ? [
              {
                id: 'start-current',
                label: `当前默认：${defaultStartDir ?? '用户主目录'}`,
                disabled: true
              },
              {
                id: 'set-start',
                label: '把当前目录设为默认',
                disabled: Boolean(listing && defaultStartDir && samePath(listing.path, defaultStartDir)),
                disabledReason: '当前就是默认目录'
              },
              ...(defaultStartDir ? [{ id: 'reset-start', label: '恢复为用户主目录' }] : [])
            ]
          : [])
      ]

  const onMenuSelect = (id: string): void => {
    if (id === 'set-start' && listing) {
      onSetStartDir?.(listing.path)
      return
    }
    if (id === 'reset-start') {
      // 等设置真的清掉再跳，否则可能顺着旧设置又读回原目录
      void Promise.resolve(onSetStartDir?.(null)).then(() => load(undefined))
      return
    }
    if (id === 'sync-to') {
      const entry = selectedEntries()[0]
      if (entry) onSyncTo?.(fullPath(entry.name))
      return
    }
    if (id === 'download-to') {
      const paths = selectedEntries().map((entry) => fullPath(entry.name))
      if (paths.length > 0) onDownloadTo?.(paths)
      return
    }
    if (id === 'delete') openDelete(selectedEntries())
    else if (id === 'rename') {
      const entry = selectedEntries()[0]
      if (entry) setPrompt({ mode: 'rename', path: fullPath(entry.name), initial: entry.name })
    } else if (id === 'mkdir' && listing) {
      setPrompt({ mode: 'mkdir', parent: listing.path })
    } else if (id === 'move-to') {
      void handleMoveTo()
    } else if (id === 'cut') {
      setClip('cut')
    } else if (id === 'copy') {
      setClip('copy')
    } else if (id === 'paste') {
      void pasteHere()
    }
  }

  /** 把当前选择放进剪贴板。copy/cut 的差别只在粘贴时走哪条路 */
  const setClip = (mode: 'cut' | 'copy'): void => {
    const entries = selectedEntries()
    if (entries.length === 0) return
    setClipboard({
      side,
      paths: entries.map((entry) => fullPath(entry.name)),
      names: entries.map((entry) => entry.name),
      mode
    })
  }


  const handleDragStart = (event: React.DragEvent, entry: DirEntry): void => {
    if (!listing || !onDragStart) return
    // 「此电脑」里的盘符不是可传输的东西
    if (listing.virtualRoot) return

    // 拖的是"已选中那批里的一个"就整批拖走——和资源管理器一致。
    // 注意局部变量不能叫 names，会遮蔽上面那个（所有条目名）的闭包变量。
    const dragging = selected.includes(entry.name) ? selected : [entry.name]
    onDragStart({
      side,
      dir: listing.path,
      names: dragging,
      paths: dragging.map((name) => joinPath(listing.path, name, listing.separator))
    })

    // Electron 需要 setData 才会真正开始拖拽
    event.dataTransfer.setData('text/plain', dragging.join('\n'))
    event.dataTransfer.effectAllowed = 'copy'
  }

  /**
   * 拖到应用外面（资源管理器 / 桌面）。
   *
   * `webContents.startDrag()` 只认磁盘上已有的文件，所以远端文件必须先落地。
   * 这里的做法是：拦住默认拖拽 → 镜像到本地临时目录 → 再发起一次系统拖拽。
   *
   * 第一次拖要等下载（有进度条），**同一个文件再拖就命中缓存、瞬间开始**，
   * 手感和本地文件一样。这是 WinSCP 那类工具的老办法，也是唯一可行的办法。
   */
  const startDragOut = async (event: React.DragEvent, entry: DirEntry): Promise<void> => {
    event.preventDefault()

    if (selected.length > 1) {
      setOpError({
        kind: 'config',
        message: '一次只能拖出一个',
        hint: `已选中 ${selected.length} 项。要批量导出，用右键「下载到…」。`,
        raw: JSON.stringify(selected)
      })
      return
    }

    const remotePath = fullPath(entry.name)
    setOpError(null)
    setDragOut({ name: entry.name, bytes: 0, total: entry.size ?? 0 })

    try {
      const prepared = await window.hpc.prepareDrag({ path: remotePath })
      if (!prepared.ok || !prepared.localPath) {
        setDragOut(null)
        setOpError(prepared.error ?? { kind: 'ipc', message: '准备拖出失败', raw: JSON.stringify(prepared) })
        return
      }

      const started = await window.hpc.startDrag(prepared.localPath)
      if (!started.ok) {
        setOpError(started.error ?? { kind: 'ipc', message: '系统拖拽没启动', raw: JSON.stringify(started) })
      }
    } catch (err) {
      setOpError({ kind: 'ipc', message: '拖出失败', raw: String(err) })
    } finally {
      setDragOut(null)
    }
  }

  const crumbs = listing ? buildCrumbs(listing.path, listing.separator, Boolean(listing.virtualRoot)) : []

  // 两栏都接受真正的本地文件拖入，但语义不同：
  // - 集群栏：外部文件 = 上传
  // - 本机栏：本地文件 = 复制到这里（从集群拖出来的镜像文件也走这条路，等于下载）
  const acceptsExternal = Boolean(onExternalDrop)

  return (
    <section
      ref={sectionRef}
      tabIndex={0}
      // 标记成投放区：App 里的全局拖放兜底靠它判断哪些地方该交给这里处理
      data-drop-zone={side}
      className={
        'flex h-full min-w-0 flex-1 flex-col bg-surface outline-none transition ' + (dragOver ? 'bg-state-info/[0.05]' : '')
      }
      onKeyDown={(event) => {
        // 焦点在这个栏里时，Delete / F2 才生效，不会两个栏一起响应。
        // 弹层开着时不响应——错误信息已经显示在弹层里了，再触发一次只会让人困惑。
        if (prompt || pendingDelete) return

        const mod = event.ctrlKey || event.metaKey

        // —— 多选快捷键 ——
        // 方向键：上下移动焦点并改变选择。Shift+方向键 = 拉区间。
        // 只处理上下（列表是单列的），左右留给别的地方。
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          if (names.length === 0) return
          event.preventDefault()
          setSelection((current) => moveFocus(names, current, event.key === 'ArrowDown' ? 1 : -1, event.shiftKey))
          return
        }

        if (mod && event.key.toLowerCase() === 'a') {
          event.preventDefault()
          setSelection(selectAll(names))
          return
        }

        // Ctrl+C / Ctrl+X：放进本栏的剪贴板。跨栏不支持——两边是不同机器，
        // 那应该走拖拽或「下载到…」，不是"复制粘贴"。
        if (mod && event.key.toLowerCase() === 'c') {
          event.preventDefault()
          setClip('copy')
          return
        }
        if (mod && event.key.toLowerCase() === 'x') {
          event.preventDefault()
          setClip('cut')
          return
        }
        if (mod && event.key.toLowerCase() === 'v') {
          if (!clipboard || clipboard.side !== side) return
          event.preventDefault()
          void pasteHere()
          return
        }

        if (event.key === 'Delete' && selected.length > 0) {
          event.preventDefault()
          openDelete(selectedEntries())
        } else if (event.key === 'F2' && selected.length === 1) {
          event.preventDefault()
          const entry = selectedEntries()[0]
          if (entry) setPrompt({ mode: 'rename', path: fullPath(entry.name), initial: entry.name })
        } else if (event.key === 'F5') {
          // 文件管理器里 F5 是刷新，用户的肌肉记忆都在这儿
          event.preventDefault()
          refresh()
        }
      }}
      onDragOver={(event) => {
        // 外部文件（资源管理器拖进来的）带 `Files` 类型；应用内拖拽是我们自己 setData 的 text/plain。
        // 必须分开处理：外部文件拖到本机栏没意义，直接不 preventDefault，
        // 光标就会显示"禁止"，用户一眼就知道这里不能放。
        if (listing?.virtualRoot) return

        const isExternal = event.dataTransfer.types.includes('Files')

        if (isExternal) {
          if (!acceptsExternal) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
          setDragOver(true)
          return
        }

        if (!onDropHere) return
        event.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDragOver(false)

        // 「此电脑」只是入口，不能往里放文件
        if (listing?.virtualRoot) return

        const isExternal = event.dataTransfer.types.includes('Files')

        if (isExternal) {
          if (!acceptsExternal || !listing || !onExternalDrop) return

          // 主路：Electron 32+ 没有 File.path 了，只能走 webUtils（在 preload 里调）。
          // 取不到时返回空串，所以要过滤，不能假设每个都能拿到。
          const paths = Array.from(event.dataTransfer.files)
            .map((file) => window.hpc.getPathForFile(file))
            .filter((path) => path.length > 0)

          // 兜底：万一 File 对象穿不过 contextBridge，uri-list 里还留着一份纯文本路径。
          // （见 lib/drop-path.ts 里的说明）
          const resolved =
            paths.length > 0 ? paths : parseUriList(event.dataTransfer.getData('text/uri-list'))

          if (resolved.length === 0) {
            setOpError({
              kind: 'config',
              message: '拿不到拖进来文件的路径',
              hint: '从浏览器、压缩包、或邮件客户端里拖出来的"虚拟文件"没有真实路径。请从资源管理器直接拖磁盘上的文件。',
              raw: `File 数量=${event.dataTransfer.files.length}；uri-list=${JSON.stringify(
                event.dataTransfer.getData('text/uri-list')
              )}`
            })
            return
          }
          onExternalDrop(resolved, listing.path)
          return
        }

        if (listing && onDropHere) onDropHere(listing.path)
      }}
    >
      <header className="shrink-0 border-b border-ink-100 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="rounded bg-ink-100 px-1.5 py-0.5 text-meta font-medium uppercase tracking-wide text-ink-500">
            {side === 'local' ? '本机' : '集群'}
          </span>
          <h2 className="text-body font-semibold text-ink-800">{title}</h2>
          {subtitle && <span className="truncate text-sub text-ink-500">{subtitle}</span>}
        </div>

        <div className="mt-2 flex items-center gap-1.5">
          <button
            type="button"
            aria-label="上一级"
            disabled={!listing?.parent || loading}
            onClick={() => listing?.parent && void load(listing.parent)}
            className="grid h-6 w-6 shrink-0 place-items-center rounded border border-ink-200 text-ink-500 transition hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M5 8V2M2 5l3-3 3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </button>

          <button
            type="button"
            aria-label="刷新"
            title="刷新（F5）· 绕过缓存重新读取"
            disabled={!listing || loading}
            onClick={refresh}
            className="grid h-6 w-6 shrink-0 place-items-center rounded border border-ink-200 text-ink-500 transition hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {/* 转起来，让"点了有反应"这件事看得见 */}
            <svg
              width="11"
              height="11"
              viewBox="0 0 16 16"
              fill="none"
              className={loading ? 'animate-spin' : ''}
            >
              <path
                d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3.2h-3.2"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          <button
            type="button"
            aria-label="新建文件夹"
            title="新建文件夹"
            disabled={!listing || loading || Boolean(listing.virtualRoot)}
            onClick={() => listing && setPrompt({ mode: 'mkdir', parent: listing.path })}
            className="grid h-6 w-6 shrink-0 place-items-center rounded border border-ink-200 text-ink-500 transition hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
              <path
                d="M1.5 4a1 1 0 0 1 1-1h3l1.3 1.5h6.2a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1V4Z"
                stroke="currentColor"
                strokeWidth="1.1"
              />
              <path d="M8 7v3M6.5 8.5h3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
            </svg>
          </button>

          <div className="flex min-w-0 flex-1 items-center overflow-hidden rounded border border-ink-200 bg-ink-50/60 px-1.5 py-0.5">
            {crumbs.map((crumb, index) => (
              <span key={crumb.path} className="flex min-w-0 items-center">
                {index > 0 && <span className="px-0.5 text-ink-300">/</span>}
                <button
                  type="button"
                  onClick={() => void load(crumb.path)}
                  className="max-w-[160px] truncate rounded px-1 py-0.5 text-sub text-ink-600 transition hover:bg-surface hover:text-ink-900"
                >
                  {crumb.label}
                </button>
              </span>
            ))}
            {!listing && <span className="px-1 text-sub text-ink-500">加载中…</span>}
          </div>
        </div>
      </header>

      <div className="flex shrink-0 items-center gap-2 border-b border-ink-100 px-3 py-1 text-meta uppercase tracking-wide text-ink-500">
        <span className="flex-1">名称</span>
        <span className="w-16 text-right">大小</span>
        <span className="w-28 text-right">修改时间</span>
      </div>

      {/* 加载指示：2px 的脉冲条。读一个 400 项的目录要 200 ms，
          没有这个条的话用户会觉得"点了没反应"。旧列表先留着，别闪白。 */}
      <div className="h-0.5 shrink-0 bg-transparent">
        {loading && <div className="h-full w-full animate-pulse bg-state-info/70" />}
      </div>

      <div className="min-h-0 flex-1" onContextMenu={(event) => handleContextMenu(event)}>
        {loading && !listing && <p className="px-3 py-4 text-body text-ink-500">读取中…</p>}

        {error && (
          <div className="m-3 rounded-surface border border-state-bad/25 bg-state-bad/[0.06] p-3">
            <p className="selectable text-body font-medium text-state-bad">{error.message}</p>
            {error.hint && <p className="selectable mt-1 text-sub text-state-bad">→ {error.hint}</p>}
            {listing && (
              <button
                type="button"
                onClick={() => void load(listing.path)}
                className="mt-2 rounded border border-state-bad/25 bg-surface px-2 py-1 text-sub text-state-bad hover:bg-state-bad/[0.05]"
              >
                重试
              </button>
            )}
          </div>
        )}

        {listing && (
          <VirtualList
            className="h-full"
            items={listing.entries}
            rowHeight={ROW_HEIGHT}
            resetKey={listing.path}
            emptyPlaceholder={
              <EmptyState
                title="这个目录是空的"
                hint="从本机拖文件进来，或者点右键「新建文件夹」。"
              />
            }
            renderRow={(entry: DirEntry) => {
              const active = selected.includes(entry.name)
              // 焦点框：只有"选中且是键盘焦点"的那一行才描出来，告诉用户
              // 方向键现在会从哪一行走。没有它的话按方向键像凭空跳。
              const focused = selection.focus === entry.name && selected.length > 0
              return (
                <div
                  draggable
                  onDragStart={(event) => {
                    // 集群栏拖出去的落点是资源管理器；本机栏走原来的栏间拖拽
                    if (side === 'remote') void startDragOut(event, entry)
                    else handleDragStart(event, entry)
                  }}
                  onClick={(event) => {
                    setSelection((current) =>
                      applyClick(names, current, entry.name, {
                        toggle: event.ctrlKey || event.metaKey,
                        shift: event.shiftKey
                      })
                    )
                    // 点一行就把焦点收进这个栏，之后的 Delete / F2 才有归属
                    sectionRef.current?.focus()
                  }}
                  onContextMenu={(event) => handleContextMenu(event, entry)}
                  onDoubleClick={() => enter(entry)}
                  title={entry.name}
                  /*
                   * 选中态要**一眼能看出来**（用户原话："删除的时候都不知道选中的是哪个"）：
                   * - 实色底 `bg-state-info/15` + `text-ink-900`
                   * - 左边 2px 的强调条（absolute 定位，不占宽度，否则名称列会左右跳）
                   * - 焦点行再叠一圈内描边
                   * 之前只有一层 12% 的淡蓝底，和 hover 的 `ink-50` 几乎分辨不出。
                   */
                  className={
                    'relative flex h-full cursor-default items-center gap-2 px-3 text-body transition ' +
                    (active
                      ? 'bg-state-info/15 text-ink-900 ' +
                        (focused ? 'ring-1 ring-inset ring-state-info/60' : '')
                      : 'text-ink-700 hover:bg-ink-50')
                  }
                >
                  {active && <span className="absolute inset-y-0 left-0 w-0.5 bg-state-info" aria-hidden="true" />}
                  {entry.kind === 'dir' ? <DirIcon /> : <FileIcon />}
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  <span className="w-16 shrink-0 text-right font-mono text-sub text-ink-500">
                    {formatSize(entry.size)}
                  </span>
                  <span className="w-28 shrink-0 text-right font-mono text-sub text-ink-500">
                    {formatTime(entry.mtime)}
                  </span>
                </div>
              )
            }}
          />
        )}

        {listing?.truncated && (
          <p className="border-t border-state-wait/25 bg-state-wait/[0.06] px-3 py-2 text-sub text-state-wait">
            条目超过 5000，只显示了前 5000 个
          </p>
        )}
      </div>

      {/* 拖出到资源管理器时，第一次要先把文件镜像到本地，这里显示进度 */}
      {dragOut && (
        <div className="shrink-0 border-t border-state-info/25 bg-state-info/[0.07] px-3 py-2">
          <div className="flex items-center gap-2">
            <StatusDot tone="info" pulse />
            <span className="min-w-0 flex-1 truncate text-sub text-state-info">
              正在准备拖出「{dragOut.name}」
              {dragOut.total > 0 ? `　${formatSize(dragOut.bytes)} / ${formatSize(dragOut.total)}` : ''}
            </span>
            <span className="shrink-0 text-sub text-state-info">
              {dragOut.total > 0 ? `${Math.round((dragOut.bytes / dragOut.total) * 100)}%` : ''}
            </span>
          </div>
          <p className="mt-1 text-sub leading-relaxed text-state-info">
            第一次拖要先把文件下到本地；下完再拖一次就是瞬间的。
          </p>
        </div>
      )}

      {/* 弹层开着的时候错误已经显示在里面了，这里就不再重复一遍 */}
      {opError && !prompt && !pendingDelete && (
        <div className="shrink-0 border-t border-state-bad/25 bg-state-bad/[0.06] px-3 py-2">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="selectable text-body font-medium text-state-bad">{opError.message}</p>
              {opError.hint && <p className="selectable mt-0.5 text-sub text-state-bad">→ {opError.hint}</p>}
            </div>
            <button
              type="button"
              onClick={() => setOpError(null)}
              className="shrink-0 rounded border border-state-bad/25 bg-surface px-1.5 py-0.5 text-sub text-state-bad hover:bg-state-bad/15"
            >
              知道了
            </button>
          </div>
        </div>
      )}

      <footer className="shrink-0 border-t border-ink-100 px-3 py-1.5 text-sub text-ink-500">
        {listing ? (
          <span className="flex items-center gap-2">
            <span>{listing.entries.length} 项</span>
            {/* 选中时把条数写在最前面：用户的原话是"删除的时候都不知道选中的是哪个"，
                条数是最直接的反馈。 */}
            {selected.length > 0 && (
              <span className="rounded bg-state-info/15 px-1.5 text-state-info">已选 {selected.length} 项</span>
            )}
            <span className="truncate">
              {clipboard && clipboard.side === side
                ? `剪贴板有 ${clipboard.paths.length} 项 · Ctrl+V 粘到此处`
                : 'Ctrl+点击多选 · Shift+点击选一段 · Ctrl+A 全选 · 右键更多'}
            </span>
          </span>
        ) : (
          ' '
        )}
      </footer>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onSelect={onMenuSelect}
          onClose={() => setMenu(null)}
        />
      )}

      {prompt && (
        <PromptDialog
          title={prompt.mode === 'rename' ? '重命名' : '新建文件夹'}
          subtitle={prompt.mode === 'rename' ? prompt.path : `${prompt.parent}　·　${side === 'local' ? '本机' : '集群'}`}
          label={prompt.mode === 'rename' ? '新名字' : '文件夹名字'}
          initialValue={prompt.mode === 'rename' ? prompt.initial : ''}
          confirmText={prompt.mode === 'rename' ? '改名' : '创建'}
          busy={opBusy}
          error={opError}
          onCancel={() => {
            setPrompt(null)
            setOpError(null)
          }}
          onConfirm={(value) => {
            if (prompt.mode === 'rename') void runRename(value)
            else void runMkdir(value)
          }}
        />
      )}

      {pendingDelete && (
        <ConfirmDelete
          side={side}
          targets={pendingDelete.targets}
          busy={opBusy}
          error={opError}
          permanentAvailable={trashBlocked}
          onPermanent={() => void runDelete(true)}
          onCancel={() => {
            setPendingDelete(null)
            setOpError(null)
            setTrashBlocked(false)
          }}
          onConfirm={() => void runDelete(false)}
        />
      )}
    </section>
  )
}
