/**
 * 端口转发页（SSH 隧道）。
 *
 * 两个方向，用途完全相反：
 *
 * - **本机 → 集群**（`-L`）：作业在计算节点上起了 Jupyter / TensorBoard，
 *   本机开个口转发过去。用途是"我去访问集群的服务"。
 * - **集群 → 本机**（`-R`）：在集群登录节点上开个口，转发回本机的服务。
 *   用途是"**集群借我的网络出去**"——最典型的就是让集群上的程序用上本机的代理。
 *
 * ## 关于"严格遵循原指令"
 *
 * 反向转发这一半是照着下面这条命令做的：
 *
 * ```
 * ssh -o ExitOnForwardFailure=yes -o ServerAliveInterval=60 \
 *     -R 127.0.0.1:21056:127.0.0.1:7897 hpc
 * ```
 *
 * - `-R 127.0.0.1:21056:127.0.0.1:7897` → 集群侧监听端口、本机目标 7897，
 *   **绑定地址写死 127.0.0.1**（主进程 `Session.forwardIn` 里没有这个参数）
 * - `ExitOnForwardFailure=yes` → 绑定失败立刻报错，不假装成功
 * - `ServerAliveInterval=60` → 已由 `Session` 的 keepalive 覆盖
 *   （profile 里配的 10s，比 60s 更密）
 *
 * 默认端口换了两次才定下来：原命令的 **55555** 被别人长期占着 →
 * 改成 **55556**，结果它落在内核临时端口段（32768–60999）里，会被别人的出站连接
 * 临时抓走，表现为"时好时坏、查又查不到" → 最终 **21056**。
 * 结论：**固定端口要选 32768 以下**。用户集群上的 `~/.profile` 也是这个值，两边对齐。
 *
 * ## 一条隐性约定：监听端口必须等于集群上的 http_proxy
 *
 * 隧道开成功 ≠ 有人用。集群上的程序（codex / 实验脚本）只会照 `http_proxy` 里的端口连，
 * 所以两边不一致时隧道等于白开。界面在这里做两件事：
 * 1. 显示集群上实际读到的 `http_proxy` 端口，不一致就当场提醒；
 * 2. 默认端口被占、只能退到别的端口时，明确说这是"一次性"的，并把
 *    `export http_proxy=...` 三行**直接给出来**，用户复制粘贴就能用。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { proxyExportSnippet } from '../../../shared/proxy'
import { formatReverseFlow, TUNNEL_DEFAULTS } from '../../../shared/tunnel-defaults'
import { describeVerify, type VerifyVerdict } from '../../../shared/tunnel-verify'
import { formatAgo, formatSize } from '../lib/format'
import { explainIpcError, stalePreloadError } from '../lib/preload'
import { usePoll } from '../lib/use-poll'
import { Card, EmptyState, PageHeader, PageShell } from './ui'

interface Preset {
  id: string
  label: string
  port: number
  /**
   * `http` 的才能点「打开浏览器」；`tcp` 的（VNC）拿浏览器打开只会得到一堆乱码，
   * 必须交给专门的客户端。这个字段就是用来避免那个误导的。
   */
  protocol: 'http' | 'tcp'
  hint: string
}

const PRESETS: Preset[] = [
  { id: 'jupyter', label: 'Jupyter', port: 8888, protocol: 'http', hint: '浏览器直接开' },
  { id: 'tensorboard', label: 'TensorBoard', port: 6006, protocol: 'http', hint: '浏览器直接开' },
  { id: 'vnc', label: 'VNC', port: 5900, protocol: 'tcp', hint: '要用 VNC 客户端连' }
]

/**
 * 反向转发的**占位**默认值，只用于"读设置还没回来"的那一帧。
 *
 * 真正生效的是向导里存的用户偏好（`window.hpc.tunnelDefaults()`），
 * 所以任何**展示**都得用 state，不能用这两个常量——否则用户改过端口之后，
 * 界面上会出现"输入框是新值、说明文字还是旧值"的自相矛盾。
 *
 * 21056 是第三次才选对的：
 * - 55555（原命令的值）被别的账号长期占着，绑不上；
 * - 55556 落在内核的临时端口段（`ip_local_port_range` = 32768–60999）里，
 *   别人的出站连接会临时征用它，表现为"时好时坏、`ss` 又查不到"；
 * - 21056 在 32768 以下，不会被临时端口抢走。
 */
const REVERSE_DEFAULT_REMOTE = String(TUNNEL_DEFAULTS.remotePort)
const REVERSE_DEFAULT_LOCAL = String(TUNNEL_DEFAULTS.localPort)

/** 隧道列表刷新：本地 IPC，不发 SSH，2 秒一次很便宜 */
const LIST_POLL_MS = 2000

type Direction = 'local' | 'reverse'

export function TunnelsView(): JSX.Element {
  const [direction, setDirection] = useState<Direction>('local')

  // —— 本机 → 集群 ——
  const [remoteHost, setRemoteHost] = useState('127.0.0.1')
  const [remotePort, setRemotePort] = useState('8888')
  const [localPort, setLocalPort] = useState('')
  const [presetId, setPresetId] = useState<string>('jupyter')

  // —— 集群 → 本机 ——
  const [reverseRemotePort, setReverseRemotePort] = useState(REVERSE_DEFAULT_REMOTE)
  const [reverseLocalHost, setReverseLocalHost] = useState('127.0.0.1')
  const [reverseLocalPort, setReverseLocalPort] = useState(REVERSE_DEFAULT_LOCAL)

  /*
   * 用向导里存下的值覆盖默认。
   *
   * 这段必须是"读一次就覆盖"：21056 要和集群 `http_proxy` 对齐、7897 是本机
   * 代理端口，不同机器不同。写死常量的话，用户每次开隧道都得手改。
   */
  useEffect(() => {
    let cancelled = false
    void window.hpc
      .tunnelDefaults()
      .then((value) => {
        if (cancelled) return
        setReverseRemotePort(String(value.remotePort))
        setReverseLocalPort(String(value.localPort))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  /** 集群上 `~/.profile` 里 http_proxy 指向的端口；null = 没读到 */
  const [proxyPort, setProxyPort] = useState<number | null>(null)
  /** 默认端口被占、退到别的端口时的说明；null = 开在了用户要的端口上 */
  const [fallback, setFallback] = useState<TunnelFallback | null>(null)
  /** 正在跑「测一下」的隧道 id */
  const [verifying, setVerifying] = useState<string | null>(null)
  /** 每条隧道的自检结论 */
  const [verdicts, setVerdicts] = useState<Record<string, VerifyVerdict>>({})
  /** 正在跑的作业 → 提供节点名下拉 */
  const [nodes, setNodes] = useState<Array<{ node: string; jobs: string[] }>>([])

  const loadTunnels = useCallback(async (): Promise<TunnelListResponse> => {
    const response = await window.hpc.listTunnels()
    if (!response.ok) throw new Error(response.error?.message ?? '读取隧道列表失败')
    return response
  }, [])

  const hasTunnelApi = typeof window.hpc?.listTunnels === 'function'
  const poll = usePoll(loadTunnels, LIST_POLL_MS, hasTunnelApi)
  const tunnels = poll.data?.tunnels ?? []

  /**
   * 读集群上 http_proxy 的端口。
   *
   * 只在切到"集群 → 本机"时读一次：它极少变，而每次都是一次 SSH 往返（~100ms）。
   * 读不到不是错误——界面会显示"没读到"，隧道照样能开。
   */
  const refreshProxyPort = useCallback(async (): Promise<void> => {
    if (typeof window.hpc?.proxyPort !== 'function') return
    try {
      const response = await window.hpc.proxyPort()
      if (response.ok) setProxyPort(response.port ?? null)
    } catch {
      // 保持"未知"，不打断用户
    }
  }, [])

  useEffect(() => {
    if (direction !== 'reverse') return
    void refreshProxyPort()
  }, [direction, refreshProxyPort])

  // 节点下拉：从"正在运行"的作业里取，同一个节点上多个作业只出现一次
  useEffect(() => {
    if (typeof window.hpc?.listJobs !== 'function') return
    void (async () => {
      try {
        const response = await window.hpc.listJobs()
        if (!response.ok || !response.jobs) return
        const byNode = new Map<string, string[]>()
        for (const job of response.jobs) {
          if (job.state !== 'running' || !job.nodes) continue
          // 多节点作业的 nodes 可能是 "gpu[10-11]"，这种不猜，原样给出让用户自己判断
          const list = byNode.get(job.nodes) ?? []
          list.push(job.id)
          byNode.set(job.nodes, list)
        }
        setNodes([...byNode.entries()].map(([node, jobs]) => ({ node, jobs })))
      } catch {
        // 拿不到作业列表不影响手动填主机名
      }
    })()
  }, [])

  const activePreset = useMemo(() => PRESETS.find((item) => item.id === presetId), [presetId])

  const applyPreset = (preset: Preset): void => {
    setPresetId(preset.id)
    setRemotePort(String(preset.port))
  }

  const resetMessages = (): void => {
    setError(null)
    setNotice(null)
    // 上一次的"退端口"说明不能留到下一次，否则用户会以为这次也换了端口
    setFallback(null)
  }

  const openLocalTunnel = useCallback(async (): Promise<void> => {
    resetMessages()

    if (typeof window.hpc?.startTunnel !== 'function') {
      setError(stalePreloadError('端口转发').message)
      return
    }

    const port = Number.parseInt(remotePort, 10)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError('目标端口要填 1–65535 的整数')
      return
    }

    setBusy(true)
    try {
      const askedLocal = localPort.trim().length > 0 ? Number.parseInt(localPort, 10) : 0
      const response = await window.hpc.startTunnel({
        remoteHost: remoteHost.trim(),
        remotePort: port,
        localPort: Number.isInteger(askedLocal) ? askedLocal : 0,
        label: `${activePreset?.label ?? '服务'} · ${remoteHost.trim()}`
      })

      if (!response.ok || !response.tunnel) {
        setError([response.error?.message, response.error?.hint].filter(Boolean).join(' · ') || '开隧道失败')
        return
      }

      setNotice(
        `已开：${response.tunnel.url ?? ''} → ${response.tunnel.targetHost}:${response.tunnel.targetPort}`
      )
      // 列表每 2 秒轮询一次，这里不用手动刷新
    } catch (err) {
      setError(explainIpcError(err, '开隧道').message)
    } finally {
      setBusy(false)
    }
  }, [remoteHost, remotePort, localPort, activePreset])

  const openReverseTunnel = useCallback(async (): Promise<void> => {
    resetMessages()

    if (typeof window.hpc?.startReverseTunnel !== 'function') {
      setError(stalePreloadError('反向隧道').message)
      return
    }

    const listenPort = Number.parseInt(reverseRemotePort, 10)
    const targetPort = Number.parseInt(reverseLocalPort, 10)

    if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
      setError('集群侧监听端口要填 1–65535 的整数')
      return
    }
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      setError('本机目标端口要填 1–65535 的整数')
      return
    }

    setBusy(true)
    try {
      const response = await window.hpc.startReverseTunnel({
        remotePort: listenPort,
        localPort: targetPort,
        localHost: reverseLocalHost.trim() || '127.0.0.1',
        label: `反向 · 集群 ${listenPort} ← 本机 ${targetPort}`
      })

      if (!response.ok || !response.tunnel) {
        setError(
          [response.error?.message, response.error?.hint].filter(Boolean).join(' · ') || '开反向隧道失败'
        )
        return
      }

      setProxyPort(response.proxyPort ?? null)
      setFallback(response.fallback ?? null)
      setNotice(
        `已开：集群 127.0.0.1:${response.tunnel.listenPort} → 本机 ${response.tunnel.targetHost}:${response.tunnel.targetPort}`
      )
    } catch (err) {
      setError(explainIpcError(err, '开反向隧道').message)
    } finally {
      setBusy(false)
    }
  }, [reverseRemotePort, reverseLocalHost, reverseLocalPort])

  const stop = useCallback(async (id: string): Promise<void> => {
    try {
      await window.hpc.stopTunnel(id)
      setNotice('隧道已关闭，端口已释放')
      // 关掉的隧道不能留着上次的自检结论，否则看起来像"刚测过还是好的"
      setVerdicts((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    } catch (err) {
      setError(explainIpcError(err, '关隧道').message)
    }
  }, [])

  /**
   * 实测一条隧道是否真的把流量送到了本机。
   *
   * 这件事靠"端口在监听"判断不出来：端口上可能蹲着别人的服务。
   * 唯一可靠的办法是两边各取一次出口 IP 再比对（详见 `lib/tunnel-verify.ts`）。
   */
  const verify = useCallback(async (tunnel: TunnelInfo): Promise<void> => {
    if (typeof window.hpc?.verifyTunnel !== 'function') {
      setError(stalePreloadError('隧道自检').message)
      return
    }
    setVerifying(tunnel.id)
    try {
      const response = await window.hpc.verifyTunnel({
        port: tunnel.listenPort,
        localPort: tunnel.targetPort,
        tunnelId: tunnel.id
      })
      if (!response.ok || !response.cluster || !response.local) {
        setError([response.error?.message, response.error?.hint].filter(Boolean).join(' · ') || '自检失败')
        return
      }
      setVerdicts((prev) => ({
        ...prev,
        [tunnel.id]: describeVerify(response.cluster!, response.local!, response.moved, tunnel.targetPort)
      }))
    } catch (err) {
      setError(explainIpcError(err, '隧道自检').message)
    } finally {
      setVerifying(null)
    }
  }, [])

  const copy = useCallback(async (text: string, key: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      // 剪贴板被拒绝就算了，地址本身是可见可选的
    }
  }, [])

  const listenPortNum = Number.parseInt(reverseRemotePort, 10)
  /**
   * 监听端口和集群上的 http_proxy 不一致。
   *
   * 这是这条功能里唯一"看着成功、实际没用"的失败模式，所以要在**开之前**就提醒，
   * 而不是等用户去问"为什么 codex 还是连不上"。
   */
  const proxyMismatch =
    proxyPort !== null && Number.isInteger(listenPortNum) && proxyPort !== listenPortNum

  return (
    <PageShell>
      <PageHeader
        title="隧道"
        description={
          <>
            两个方向：把集群里的服务和本机的服务互相接通，不用再手敲{' '}
            <code className="font-mono text-body">ssh -L</code> /{' '}
            <code className="font-mono text-body">ssh -R</code>。
          </>
        }
      />

      <Card title="新建隧道">
        {/* 方向切换。两个方向的用途完全相反，必须一眼看出选的是哪个 */}
        <div className="mb-3 flex gap-1 rounded-surface bg-ink-100/70 p-0.5">
          {[
            { id: 'local' as const, label: '本机 → 集群', hint: '我访问集群里的服务' },
            { id: 'reverse' as const, label: '集群 → 本机', hint: '集群借我的网络出去' }
          ].map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                setDirection(item.id)
                resetMessages()
              }}
              title={item.hint}
              className={
                'flex-1 rounded-control px-3 py-1.5 text-body transition ' +
                (direction === item.id
                  ? 'bg-surface font-medium text-ink-900 shadow-card'
                  : 'text-ink-500 hover:text-ink-700')
              }
            >
              {item.label}
            </button>
          ))}
        </div>

        {direction === 'local' ? (
          <div className="space-y-3">
            <div>
              <p className="mb-1 text-meta uppercase tracking-wide text-ink-500">目标机器</p>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setRemoteHost('127.0.0.1')}
                  className={
                    'rounded-surface border px-2.5 py-1 text-sub transition ' +
                    (remoteHost === '127.0.0.1'
                      ? 'border-state-info/70 bg-state-info/[0.05] text-ink-900'
                      : 'border-ink-200 bg-surface text-ink-600 hover:bg-ink-50')
                  }
                >
                  登录节点
                </button>
                {nodes.map((item) => (
                  <button
                    key={item.node}
                    type="button"
                    onClick={() => setRemoteHost(item.node)}
                    title={`作业 ${item.jobs.join(', ')} 跑在这台机器上`}
                    className={
                      'rounded-surface border px-2.5 py-1 font-mono text-sub transition ' +
                      (remoteHost === item.node
                        ? 'border-state-info/70 bg-state-info/[0.05] text-ink-900'
                        : 'border-ink-200 bg-surface text-ink-600 hover:bg-ink-50')
                    }
                  >
                    {item.node}
                  </button>
                ))}
                <input
                  value={remoteHost}
                  onChange={(event) => setRemoteHost(event.target.value)}
                  placeholder="或手填主机名"
                  className="w-40 rounded-surface border border-ink-200 px-2 py-1 font-mono text-sub outline-none focus:border-state-info"
                />
              </div>
              {nodes.length === 0 && (
                <p className="mt-1 text-meta text-ink-500">
                  现在没有正在运行的作业。等作业跑起来后，这里会列出它们所在的机器。
                </p>
              )}
            </div>

            <div>
              <p className="mb-1 text-meta uppercase tracking-wide text-ink-500">服务</p>
              <div className="flex flex-wrap items-center gap-1.5">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => applyPreset(preset)}
                    title={preset.hint}
                    className={
                      'rounded-surface border px-2.5 py-1 text-sub transition ' +
                      (presetId === preset.id
                        ? 'border-state-info/70 bg-state-info/[0.05] text-ink-900'
                        : 'border-ink-200 bg-surface text-ink-600 hover:bg-ink-50')
                    }
                  >
                    {preset.label}
                    <span className="ml-1 font-mono text-meta text-ink-500">{preset.port}</span>
                  </button>
                ))}
                <input
                  value={remotePort}
                  onChange={(event) => {
                    setRemotePort(event.target.value)
                    setPresetId('')
                  }}
                  className="w-24 rounded-surface border border-ink-200 px-2 py-1 font-mono text-sub outline-none focus:border-state-info"
                />
                <span className="text-sub text-ink-500">远端端口</span>
              </div>
            </div>

            <div className="flex flex-wrap items-end gap-2">
              <label className="text-sub text-ink-500">
                本地端口
                <input
                  value={localPort}
                  onChange={(event) => setLocalPort(event.target.value)}
                  placeholder="留空自动分配"
                  className="ml-1.5 w-32 rounded-surface border border-ink-200 px-2 py-1 font-mono text-sub outline-none focus:border-state-info"
                />
              </label>
              <button
                type="button"
                onClick={() => void openLocalTunnel()}
                disabled={busy}
                className="rounded-surface bg-inverse px-3.5 py-1.5 text-body font-medium text-white transition hover:bg-ink-800 disabled:bg-ink-300"
              >
                {busy ? '开启中…' : '开隧道'}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="rounded-surface border border-state-info/25 bg-state-info/[0.05] px-3 py-2 text-sub leading-relaxed text-state-info">
              在<strong className="font-medium">集群登录节点</strong>上开一个端口，连它就等于连
              <strong className="font-medium">你本机</strong>的服务。最常见的用法是让集群上的程序
              通过你本机的代理上网：
              <span className="mt-0.5 block font-mono text-sub text-state-info">
                {formatReverseFlow(reverseRemotePort, reverseLocalPort)}
              </span>
            </p>

            <div className="flex flex-wrap items-end gap-3">
              <label className="text-sub text-ink-500">
                集群侧监听端口
                <input
                  value={reverseRemotePort}
                  onChange={(event) => setReverseRemotePort(event.target.value)}
                  className="ml-1.5 w-28 rounded-surface border border-ink-200 px-2 py-1 font-mono text-sub outline-none focus:border-state-info"
                />
              </label>
              <span className="pb-1.5 text-ink-300">←</span>
              <label className="text-sub text-ink-500">
                本机目标
                <span className="ml-1.5 inline-flex items-center gap-1">
                  <input
                    value={reverseLocalHost}
                    onChange={(event) => setReverseLocalHost(event.target.value)}
                    className="w-28 rounded-surface border border-ink-200 px-2 py-1 font-mono text-sub outline-none focus:border-state-info"
                  />
                  <span className="text-ink-300">:</span>
                  <input
                    value={reverseLocalPort}
                    onChange={(event) => setReverseLocalPort(event.target.value)}
                    className="w-20 rounded-surface border border-ink-200 px-2 py-1 font-mono text-sub outline-none focus:border-state-info"
                  />
                </span>
              </label>
              <button
                type="button"
                onClick={() => void openReverseTunnel()}
                disabled={busy}
                className="rounded-surface bg-inverse px-3.5 py-1.5 text-body font-medium text-white transition hover:bg-ink-800 disabled:bg-ink-300"
              >
                {busy ? '开启中…' : '开反向隧道'}
              </button>
            </div>

            <p className="text-meta leading-relaxed text-ink-500">
              集群侧只绑 <code className="font-mono">127.0.0.1</code>，只有登录节点上的进程能用它——
              不会把本机服务暴露给集群里的其它机器。端口绑不上会直接报错，不会"看着开了实际没通"。
            </p>

            {/* 集群上 http_proxy 指向哪儿：这条隧道必须开在同一个端口上才有人用 */}
            <div className="rounded-surface border border-ink-200 bg-ink-50/50 px-3 py-2 text-sub leading-relaxed text-ink-600">
              集群上 <code className="font-mono text-meta">~/.profile</code> 里的{' '}
              <code className="font-mono text-meta">http_proxy</code>：
              {proxyPort === null ? (
                <span className="text-ink-500"> 没读到（还没配置，或文件里没有这一行）</span>
              ) : (
                <>
                  <span className="ml-1 font-mono text-ink-800">127.0.0.1:{proxyPort}</span>
                  {proxyPort === listenPortNum ? (
                    <span className="ml-1.5 rounded bg-state-ok/[0.06] px-1 py-[1px] text-state-ok">
                      与监听端口一致
                    </span>
                  ) : (
                    <span className="ml-1.5 rounded bg-state-wait/15 px-1 py-[1px] text-state-wait">不一致</span>
                  )}
                </>
              )}
            </div>

            {/* 一段能自己看懂的说明。默认收着：多数时候用不上，出问题时才有用 */}
            <details className="rounded-surface border border-ink-200 bg-surface px-3 py-1.5">
              <summary className="cursor-pointer select-none text-sub text-ink-500 hover:text-ink-700">
                隧道开了，集群上的程序还是连不上？看这里
              </summary>
              <ul className="mt-1.5 space-y-1 text-sub leading-relaxed text-ink-500">
                <li>
                  · 集群上的程序只认 <code className="font-mono">http_proxy</code>{' '}
                  里的端口。隧道开在别的号上，它就不会走这条。
                </li>
                <li>
                  · 想一直用：把集群上 <code className="font-mono">~/.profile</code>{' '}
                  里那一行的端口改成<b className="font-medium">和上面一样</b>，然后{' '}
                  <code className="font-mono">source ~/.profile</code>（或者重新登录）。
                </li>
                <li>
                  · 已经在跑的程序要<b className="font-medium">重启</b>——它只在启动那一刻读一次环境变量。
                </li>
                <li>
                  · 只想这次用：在集群终端里执行{' '}
                  <code className="font-mono">export http_proxy=http://127.0.0.1:端口</code>。
                </li>
              </ul>
            </details>

            {proxyMismatch && (
              <div className="rounded-surface border border-state-wait/25 bg-state-wait/[0.06] px-3 py-2 text-sub leading-relaxed text-ink-900">
                <p>
                  集群上的程序只会连 <code className="font-mono">127.0.0.1:{proxyPort}</code>，
                  而你这条开在 <code className="font-mono">127.0.0.1:{listenPortNum}</code>——
                  端口对不上的话，隧道开着也<b className="font-medium">没人用</b>。
                </p>
                <p className="mt-1">
                  要么把监听端口改成 {proxyPort}；要么在集群终端里执行下面三行（只对当前终端生效）：
                </p>
                <pre className="selectable mt-1 overflow-x-auto rounded bg-surface/80 p-2 font-mono text-meta leading-relaxed text-ink-700">
                  {proxyExportSnippet(listenPortNum)}
                </pre>
                <button
                  type="button"
                  onClick={() => void copy(proxyExportSnippet(listenPortNum), 'proxy-mismatch')}
                  className="mt-1 text-sub text-state-wait underline-offset-2 hover:underline"
                >
                  {copied === 'proxy-mismatch' ? '已复制' : '复制这三行'}
                </button>
              </div>
            )}
          </div>
        )}

        {fallback && (
          <div className="mt-2 rounded-surface border border-state-wait/35 bg-state-wait/[0.06] px-3 py-2 text-sub leading-relaxed text-ink-900">
            <p>
              <b className="font-medium">{fallback.requested} 被占了</b>
              {fallback.ownerIsSelf ? (
                <>
                  {' '}
                  —— <b className="font-medium">就是你自己</b>（集群上那个监听是 sshd 用你的账号建的，
                  多半是已经开着一条同端口的隧道，看下面「进行中」）
                </>
              ) : (
                <>{fallback.owner?.username ? `（账号 ${fallback.owner.username} 的进程）` : ''}</>
              )}
              ，这次开在 <code className="font-mono text-sub">{fallback.actual}</code>。按下面三步走：
            </p>

            <pre className="selectable mt-1.5 overflow-x-auto rounded bg-surface/80 p-2 font-mono text-meta leading-relaxed text-ink-700">
              {proxyExportSnippet(fallback.actual)}
            </pre>
            <button
              type="button"
              onClick={() => void copy(proxyExportSnippet(fallback.actual), 'fallback')}
              className="mt-1 rounded border border-state-wait/35 bg-surface/70 px-2 py-[2px] text-sub text-state-wait transition hover:bg-surface"
            >
              {copied === 'fallback' ? '已复制' : '复制这三行'}
            </button>

            <ol className="mt-2 list-inside list-decimal space-y-0.5 text-ink-900">
              <li>
                粘到要跑实验的<b className="font-medium">那个</b>窗口，回车（只影响这一个窗口）
              </li>
              <li>重启那个实验进程 —— 老进程读的还是旧值</li>
              <li>回来点列表里的「测一下能不能用」，出口 IP 对得上就成</li>
            </ol>

            <p className="mt-1.5 text-meta text-state-wait">
              这是一次性端口：新开的窗口、重启后的 tmux 都还会回到 {fallback.requested}。
              想长期换掉，改集群上 <code className="font-mono">~/.profile</code> 里那一行。
            </p>
          </div>
        )}

        {error && (
          <p className="mt-2 rounded-surface border border-state-bad/25 bg-state-bad/[0.06] px-3 py-1.5 text-sub text-state-bad">
            {error}
          </p>
        )}
        {notice && (
          <p className="mt-2 rounded-surface border border-state-ok/25 bg-state-ok/[0.06] px-3 py-1.5 text-sub text-state-ok">
            {notice}
          </p>
        )}
      </Card>

      <div className="mt-4">
        <Card title="进行中" aside={<span className="text-sub text-ink-500">{tunnels.length} 条</span>}>
          {tunnels.length === 0 && (
            <EmptyState
              title="还没有隧道"
              hint="开一条之后，关掉应用或点「关闭」都会释放端口。"
            />
          )}

          {tunnels.map((tunnel) => {
            const isReverse = tunnel.direction === 'reverse'
            const preset = isReverse ? undefined : PRESETS.find((item) => item.port === tunnel.targetPort)
            const openable = !isReverse && (preset?.protocol ?? 'http') === 'http' && tunnel.url !== null

            // 反向隧道要复制的不是 URL，而是集群上那个可访问的地址
            const copyText = isReverse ? `127.0.0.1:${tunnel.listenPort}` : (tunnel.url ?? '')

            return (
              <div key={tunnel.id} className="border-b border-ink-50 py-2.5 last:border-b-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={
                      'rounded border px-1 py-[1px] text-meta ' +
                      (isReverse
                        ? 'border-accent-500/25 bg-accent-500/[0.06] text-accent-600'
                        : 'border-state-info/25 bg-state-info/[0.05] text-state-info')
                    }
                  >
                    {isReverse ? '集群→本机' : '本机→集群'}
                  </span>
                  <span className="text-body text-ink-900">{tunnel.label}</span>
                  {/*
                    这台隧道建在哪台跳板机上。
                    两台登录节点会各有一条 `集群 127.0.0.1:21056`，不加这个标签就看不出区别，
                    而"隧道建在哪台，就要在哪台上用它"是这类集群最要紧的一条约束。
                  */}
                  {tunnel.profileLabel && (
                    <span
                      className="rounded-full border border-ink-200 bg-ink-50 px-2 py-0.5 text-meta text-ink-700"
                      title={`建在跳板机 ${tunnel.profileLabel} 上`}
                    >
                      在 {tunnel.profileLabel}
                    </span>
                  )}
                  <span className="font-mono text-sub text-ink-500">
                    {isReverse
                      ? `集群 127.0.0.1:${tunnel.listenPort} → 本机 ${tunnel.targetHost}:${tunnel.targetPort}`
                      : `本机 127.0.0.1:${tunnel.listenPort} → ${tunnel.targetHost}:${tunnel.targetPort}`}
                  </span>
                  <span className="text-meta text-ink-300">开了 {formatAgo(tunnel.openedAt / 1000)}</span>
                </div>

                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <code className="selectable rounded bg-ink-50 px-1.5 py-0.5 font-mono text-sub text-ink-700">
                    {copyText}
                  </code>

                  <button
                    type="button"
                    onClick={() => void copy(copyText, tunnel.id)}
                    className="rounded border border-ink-200 bg-surface px-2 py-0.5 text-sub text-ink-700 transition hover:bg-ink-50"
                  >
                    {copied === tunnel.id ? '已复制' : '复制'}
                  </button>

                  {openable && (
                    <button
                      type="button"
                      onClick={() => void window.hpc.openLocalUrl(tunnel.url ?? '')}
                      className="rounded border border-state-info/25 bg-surface px-2 py-0.5 text-sub text-state-info transition hover:bg-state-info/[0.05]"
                    >
                      打开浏览器
                    </button>
                  )}

                  {!isReverse && !openable && (
                    <span
                      className="text-meta text-state-wait"
                      title="VNC 不是 HTTP 协议，用浏览器打开只会看到乱码"
                    >
                      这不是网页服务，用 VNC 客户端连这个地址
                    </span>
                  )}

                  {isReverse && (
                    <span className="text-meta text-ink-500">
                      在集群上让程序连 <code className="font-mono">127.0.0.1:{tunnel.listenPort}</code>
                    </span>
                  )}

                  {/*
                    自检入口。放在"进行中"而不是开成功的瞬间，
                    因为用户真正想问的问题永远是"现在通吗"，而不是"刚才开成功了吗"。
                  */}
                  {isReverse && (
                    <button
                      type="button"
                      onClick={() => void verify(tunnel)}
                      disabled={verifying === tunnel.id}
                      className="rounded border border-ink-200 bg-surface px-2 py-0.5 text-sub text-ink-700 transition hover:bg-ink-50 disabled:text-ink-300"
                    >
                      {verifying === tunnel.id ? '测试中…' : '测一下能不能用'}
                    </button>
                  )}

                  {/* 数字段用等宽数字：不然 111→112 时整行会左右抖一下 */}
                  <span className="text-meta text-ink-500">
                    连接 <span className="font-mono tabular-nums">{tunnel.connections}</span> · 下行{' '}
                    <span className="font-mono tabular-nums">{formatSize(tunnel.bytesIn)}</span> · 上行{' '}
                    <span className="font-mono tabular-nums">{formatSize(tunnel.bytesOut)}</span>
                  </span>

                  <button
                    type="button"
                    onClick={() => void stop(tunnel.id)}
                    className="ml-auto rounded border border-ink-200 bg-surface px-2 py-0.5 text-sub text-state-bad transition hover:border-state-bad/25 hover:bg-state-bad/[0.05]"
                  >
                    关闭
                  </button>
                </div>

                {isReverse && verdicts[tunnel.id] && (
                  <p
                    className={`mt-1 text-meta leading-relaxed ${
                      verdicts[tunnel.id]!.tone === 'ok'
                        ? 'text-state-ok'
                        : verdicts[tunnel.id]!.tone === 'warn'
                          ? 'text-state-wait'
                          : 'text-state-bad'
                    }`}
                  >
                    {verdicts[tunnel.id]!.text}
                  </p>
                )}

                {tunnel.lastError && (
                  <p className="mt-1 text-meta text-state-bad">最近一次连接失败：{tunnel.lastError}</p>
                )}
                {tunnel.connections === 0 && !tunnel.lastError && (
                  <p className="mt-1 text-meta leading-relaxed text-ink-500">
                    {isReverse
                      ? `还没有连接进来。集群上的程序连 127.0.0.1:${tunnel.listenPort} 时才会用到它。`
                      : `还没有连接进来。如果远端服务没起在这台机器的 ${tunnel.targetPort} 端口上，打开时会看到错误（这里会显示原因）。`}
                  </p>
                )}
              </div>
            )
          })}
        </Card>
      </div>
    </PageShell>
  )
}
