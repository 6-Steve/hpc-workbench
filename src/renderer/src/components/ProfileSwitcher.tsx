/**
 * 跳板机切换（标题栏里的下拉）。
 *
 * ## 为什么放标题栏而不是设置页
 * 这是**全局状态**——切了之后作业、资源、终端、隧道全都换机器。
 * 放设置页里，用户会以为"只是改了个设置"，然后困惑为什么刚才开的终端不动了。
 * 标题栏是常驻的，且它就在"已连接"状态灯旁边，语义上连着。
 *
 * ## 为什么切换前要弹确认
 * 切一次会**断开终端和所有隧道**。这些都是用户手动开的、有上下文的东西，
 * 静默关掉是最让人火大的行为。所以哪怕只有一条隧道，也要先说清断什么。
 *
 * 有传输在跑时主进程会直接拒绝——这里不预先禁用按钮，
 * 因为"为什么不能点"必须给理由，藏起来的禁用按钮等于没解释。
 *
 * ## 为什么下拉面板要用 portal 挂到 body
 * ⚠️ 实测踩过：面板原先用 `absolute z-30` 放在标题栏里，结果**被左侧 Dock 盖住**。
 * 根因不是 z-index 不够大，而是标题栏有 `backdrop-blur` ——
 * 它创建了一个**层叠上下文**，标题栏内部元素再高的 z-index 也只能在这个上下文里排序，
 * 整体永远低于后面的 Dock。
 * 所以只能跳出这个上下文：`createPortal` 到 `document.body`，用 fixed 定位。
 * 加 z-index 是治不了的，这一点值得记住。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatMs } from '../../../shared/latency'
import { StatusDot } from './ui'

/**
 * 面板宽度，必须和下面 `w-64` 一致。
 *
 * 为什么要单独写一个常量：portal 之后没有父容器可参照，位置全靠 JS 算，
 * 而算 `left` 的上界（`window.innerWidth - width - 8`）必须知道宽度。
 * 只写 `w-64` 的话 JS 读不到——`getBoundingClientRect()` 在首帧里拿到的
 * 是还没排版的盒子（0 宽），所以不能靠测量，只能靠常量。
 */
const PANEL_WIDTH = 256 // w-64

interface ProfileSummary {
  id: string
  label: string
  host: string
  port: number
  username: string
  isDefault: boolean
}

interface SetActiveResponse {
  ok: boolean
  activeId?: string
  closed?: { terminals: number; tunnels: number; connections: number }
  error?: { message: string; hint?: string }
}

interface ProfileSwitcherProps {
  /** 切换成功（或被拒绝）后通知 App 刷新标题栏三个电量数字 */
  onSwitched: (result: { activeId: string; closed?: SetActiveResponse['closed'] }) => void
  /** 切换失败要能显示原因（传输中、配置错） */
  onError: (message: string, hint?: string) => void
}

export function ProfileSwitcher({ onSwitched, onError }: ProfileSwitcherProps): JSX.Element | null {
  const [profiles, setProfiles] = useState<ProfileSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  /** 待确认的目标；null = 没有确认框 */
  const [pending, setPending] = useState<ProfileSummary | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)
  /** 面板要用 fixed 定位，所以得自己算它该在哪儿（portal 之后没有父容器可参照） */
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null)
  /** 每台最近一次的测速结果；键是 profileId */
  const [latencies, setLatencies] = useState<Record<string, ProfileLatency>>({})
  const [measuring, setMeasuring] = useState<string | null>(null)
  const [latencyError, setLatencyError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const result = (await window.hpc.listProfiles()) as {
      ok: boolean
      profiles?: ProfileSummary[]
      activeId?: string
      error?: { message: string }
    }
    if (!result.ok) {
      // 配置读不出来时不弹错：启动页会统一报，这里静默隐藏下拉比顶个红条好
      setProfiles([])
      return
    }
    setProfiles(result.profiles ?? [])
    setActiveId(result.activeId ?? null)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * 算面板位置：**左边缘贴住按钮左边缘**，向下展开。
   *
   * 为什么不是原来的 `right` 对齐：按钮在标题栏**最左边**（紧挨着 Dock 上方的
   * 那一小块），右对齐会让 256px 宽的卡片一路伸到窗口最左沿、并且悬在
   * 左侧 Dock 的头顶上——用户明确说这不行。
   *
   * 左对齐之后，卡片的左边和「跳板机」按钮的左边齐平，宽度向右展开，
   * 整个落在内容区上方，完全避开 Dock（Dock 宽 56px，而按钮左边大约在 130px）。
   *
   * `Math.min` 是给窄窗口留的兜底：窗口最小 960，正常放得下，
   * 但万一将来把按钮挪到右边，这个算式仍然不会让卡片跑出窗口。
   *
   * `useLayoutEffect` 而不是 `useEffect`：要在浏览器绘制之前算好，
   * 否则面板会先在 (0,0) 闪一帧再跳到位。
   */
  const measure = useCallback((): { top: number; left: number } | null => {
    const rect = boxRef.current?.getBoundingClientRect()
    if (!rect) return null
    const width = PANEL_WIDTH
    return {
      top: rect.bottom + 4,
      // 留 8px 安全边距，不让它贴着窗口沿
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
    }
  }, [])

  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null)
      return
    }
    setAnchor(measure())
  }, [open, measure])

  // 窗口尺寸变了要重算——标题栏是固定的，但用户会拉窗口
  useEffect(() => {
    if (!open) return
    const onResize = (): void => setAnchor(measure())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open, measure])

  // 点外面就收起。用 pointerdown 而不是 click：拖拽标题栏时不该触发
  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent): void => {
      const target = event.target as Node
      // 面板在 portal 里，**不在** boxRef 子树内，所以要单独判断
      if (boxRef.current?.contains(target) || panelRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  /**
   * 测一台跳板机的耗时。
   *
   * 结果由主进程缓存 5 分钟——面板开开关关不该每次都重新登录一遍集群。
   * 同一时刻只测一台：并发建连会互相拖慢，测出来的数字都不准。
   */
  const runLatency = useCallback(async (id: string, force = false): Promise<void> => {
    if (typeof window.hpc?.profileLatency !== 'function') return
    setMeasuring(id)
    setLatencyError(null)
    try {
      const result = await window.hpc.profileLatency({ profileId: id, force })
      if (!result.ok || !result.latency) {
        setLatencyError(result.error?.message ?? '测速失败')
        return
      }
      const latency = result.latency
      setLatencies((prev) => ({ ...prev, [id]: latency }))
    } catch (err) {
      setLatencyError(err instanceof Error ? err.message : String(err))
    } finally {
      setMeasuring(null)
    }
  }, [])

  const apply = useCallback(
    async (target: ProfileSummary): Promise<void> => {
      setPending(null)
      setBusy(true)
      try {
        const result = (await window.hpc.setActiveProfile({ id: target.id })) as SetActiveResponse
        if (!result.ok) {
          onError(result.error?.message ?? '切换失败', result.error?.hint)
          return
        }
        setActiveId(result.activeId ?? target.id)
        onSwitched({ activeId: result.activeId ?? target.id, closed: result.closed })
      } catch (err) {
        onError('调用主进程失败，可能是 preload 没重启', String(err))
      } finally {
        setBusy(false)
      }
    },
    [onError, onSwitched]
  )

  // 只有一条 profile 时整个控件不出现：单选项的下拉是噪音
  if (profiles.length < 2) return null

  const active = profiles.find((profile) => profile.id === activeId) ?? profiles[0]!
  // 名字里的"跳板机 01"太长，取最后一段数字做角标，悬停看全称
  const shortLabel = active.label.replace(/^SCIR\s*跳板机\s*/, '') || active.id

  /*
   * 面板走 portal 挂到 body。锚点由 `anchor` 给出（见上面的 useLayoutEffect），
   * 不在这里用 absolute —— 那样会被标题栏的 backdrop-blur 层叠上下文困住。
   * z-40 比通知面板高，和确认框（z-50）错开一层。
   *
   * 视觉与 `NotificationPanel` 保持一套：`rounded-surface`(12px) + `shadow-pop`。
   * 早先这两处用的是两个没注册的 token 名，Tailwind 会静默跳过、不报错，
   * 结果面板既没有圆角也没有阴影——用户眼里的"和通知面板不一样"
   * 其实是样式压根没生成，不是风格取舍。
   * 现在由 `tests/design-tokens.test.ts` 比对注册表守着，不许再写没注册的 token。
   */
  const panel =
    open && anchor
      ? createPortal(
          <div
            ref={panelRef}
            style={{ top: anchor.top, left: anchor.left }}
            className="fixed z-40 w-64 overflow-hidden rounded-surface border border-ink-200 bg-surface shadow-pop"
          >
            <div className="border-b border-ink-100 px-2.5 py-1.5 text-meta text-ink-500">
              切换跳板机会断开终端和隧道
            </div>
            {profiles.map((profile) => {
              const isActive = profile.id === activeId
              const latency = latencies[profile.id]
              return (
                <button
                  key={profile.id}
                  type="button"
                  onClick={() => {
                    setOpen(false)
                    if (isActive) return
                    setPending(profile)
                  }}
                  className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition ${
                    isActive ? 'bg-ink-50' : 'hover:bg-ink-50'
                  }`}
                >
                  <StatusDot tone={isActive ? 'ok' : 'idle'} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sub text-ink-800">{profile.label}</span>
                    <span className="block truncate font-mono text-meta text-ink-500">
                      {profile.host}:{profile.port}
                    </span>
                  </span>
                  {/*
                    网络 · 登录。
                    两个数放在一起是因为它们回答不同的问题：网络慢该换网络，
                    登录慢该换节点——只显示一个总耗时永远分不清。
                  */}
                  {latency ? (
                    <span
                      className={`shrink-0 font-mono text-meta ${
                        latency.verdict === 'ok'
                          ? 'text-ink-600'
                          : latency.verdict === 'timeout' ||
                              latency.verdict === 'unreachable' ||
                              latency.verdict === 'auth-failed' ||
                              latency.verdict === 'hostkey-mismatch' ||
                              latency.verdict === 'unknown-host'
                            ? 'text-state-bad'
                            : 'text-state-wait'
                      }`}
                      title={`${latency.headline}：${latency.detail}`}
                    >
                      {formatMs(latency.tcpMs)} · {formatMs(latency.totalMs)}
                    </span>
                  ) : (
                    <span className="shrink-0 text-meta text-ink-300">未测</span>
                  )}
                  {profile.isDefault && (
                    <span className="shrink-0 rounded border border-ink-200 px-1 text-meta text-ink-500">
                      默认
                    </span>
                  )}
                </button>
              )
            })}

            {/*
              测速必须手动触发：每次探测都是一次真实的 SSH 登录，
              轮询会在集群上刷出一串 auth 记录，也可能撞上 MaxStartups。
            */}
            <div className="flex items-center gap-1.5 border-t border-ink-100 px-2.5 py-1.5">
              <span className="text-meta text-ink-500">测速</span>
              {profiles.map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  disabled={measuring !== null}
                  onClick={() => void runLatency(profile.id, true)}
                  className="rounded border border-ink-200 bg-surface px-1.5 py-[1px] font-mono text-meta text-ink-700 transition hover:bg-ink-50 disabled:opacity-40"
                >
                  {measuring === profile.id ? '…' : profile.label}
                </button>
              ))}
            </div>
            {latencyError && (
              <p className="border-t border-ink-100 px-2.5 py-1 text-meta leading-relaxed text-state-bad">
                {latencyError}
              </p>
            )}
          </div>,
          document.body
        )
      : null

  return (
    <div ref={boxRef} className="no-drag relative ml-1 shrink-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={busy}
        title={`当前跳板机：${active.label}（${active.host}:${active.port}）· 点击切换`}
        className="flex items-center gap-1 rounded-control border border-ink-200 px-1.5 py-[3px] text-meta text-ink-600 transition hover:border-ink-300 hover:text-ink-800 disabled:opacity-50"
      >
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" className="shrink-0">
          <rect x="1.6" y="2" width="8.8" height="3.2" rx="0.8" stroke="currentColor" strokeWidth="1.2" />
          <rect x="1.6" y="6.8" width="8.8" height="3.2" rx="0.8" stroke="currentColor" strokeWidth="1.2" />
          <path d="M4 3.6h.01M4 8.4h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <span className="max-w-[6rem] truncate">{shortLabel}</span>
        <span className="font-mono text-ink-500">{active.port}</span>
      </button>

      {panel}

      {pending && (
        <ConfirmSwitch
          target={pending}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => void apply(pending)}
        />
      )}
    </div>
  )
}

/**
 * 切换确认。
 *
 * 只说"会断开终端和隧道"，**不编造具体条数**——这个组件拿不到那些数据，
 * 而真实条数由主进程在切换后返回（`closed`），那时再如实告诉用户。
 * 编一个数字比不给更糟：用户会以为自己没有隧道，结果丢了正在跑的转发。
 *
 * 同样走 portal：`fixed inset-0` 也逃不出标题栏的层叠上下文，
 * 不挂到 body 的话遮罩只会盖住标题栏那一条，Dock 和内容区露在外面。
 */
function ConfirmSwitch({
  target,
  busy,
  onCancel,
  onConfirm
}: {
  target: ProfileSummary
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-inverse/20 p-6" role="dialog" aria-modal="true">
      <div className="w-full max-w-sm rounded-surface border border-ink-200 bg-surface p-4 shadow-pop">
        <h2 className="text-emph font-medium text-ink-900">切换到「{target.label}」？</h2>
        <p className="mt-2 text-sub leading-relaxed text-ink-600">
          会换掉整条连接：当前打开的<strong className="font-medium text-ink-800">终端会话和端口转发都会被断开</strong>，
          需要在新机器上重开。
        </p>
        <p className="mt-1.5 font-mono text-meta text-ink-500">
          {target.host}:{target.port} · {target.username}
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-control border border-ink-200 px-3 py-1.5 text-sub text-ink-700 transition hover:bg-ink-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="rounded-control bg-inverse px-3 py-1.5 text-sub font-medium text-white transition hover:bg-ink-800 disabled:opacity-50"
          >
            {busy ? '切换中…' : '切换'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
