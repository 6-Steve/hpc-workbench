import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileView } from './components/FileView'
import { JobsView } from './components/JobsView'
import { ResourcesView } from './components/ResourcesView'
import { PointsView } from './components/PointsView'
import { SettingsView } from './components/SettingsView'
import { TerminalView } from './components/TerminalView'
import { TunnelsView } from './components/TunnelsView'
import { Card, Field, Mono, PageHeader, PageShell } from './components/ui'
import { CommandPalette } from './components/CommandPalette'
import { Dock } from './components/Dock'
import { DOCK_TABS, type Tab } from './lib/dock-tabs'
import { formatSize } from './lib/format'
import { setTrayResident } from './lib/use-poll'
import { JobLogDialog } from './components/JobLogDialog'
import {
  NotificationBell,
  NotificationPanel,
  type AppNotification,
  type NotificationLevel
} from './components/NotificationCenter'
import { TitleBar, type ConnectionStatus } from './components/TitleBar'
import { ProfileSwitcher } from './components/ProfileSwitcher'
import { TracePanel } from './components/TracePanel'
import { BootSplash } from './components/BootSplash'
import { SetupWizard } from './components/SetupWizard'
import { BannerStack, type BannerItem } from './components/Banner'
import { formatAgo, quotaUsagePercent } from './lib/format'
import { parseRecentIds, pushRecent, type PaletteItem } from './lib/command-palette'
import { diffJobSnapshots, type JobWatchEntry, type JobWatchEvent } from './lib/job-watch'
import { preloadStale } from './lib/preload'
import { usePoll } from './lib/use-poll'

/** 可折叠的原始输出块。失败时"能看到原文"是这个项目唯一的自救手段（docs/04 §2.2） */
function RawBlock({
  label,
  text,
  tone = 'ink'
}: {
  label: string
  text: string
  tone?: 'ink' | 'red'
}): JSX.Element {
  const color = tone === 'red' ? 'text-state-bad' : 'text-ink-500'
  return (
    <details className="group mt-1">
      <summary className={`cursor-pointer select-none text-sub ${color} hover:underline`}>{label}</summary>
      <pre
        className={`selectable mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-control bg-surface/70 p-2 font-mono text-meta leading-relaxed ${
          tone === 'red' ? 'text-state-bad' : 'text-ink-600'
        }`}
      >
        {text || '（没有内容）'}
      </pre>
    </details>
  )
}

/** 探测成功：四个命令的 JSON 支持情况 + 关键环境信息 + 每条命令的原文 */
function SuccessPanel({ response }: { response: ProbeResponse }): JSX.Element {
  const caps = response.capabilities
  if (!caps) {
    return <p className="text-body text-ink-500">探测成功，但没有返回能力详情。</p>
  }

  const probes: Array<{ label: string; ok: boolean; note: string }> = [
    { label: 'sinfo --json', ok: caps.sinfoJson, note: '分区概览（降级项，本集群不需要）' },
    { label: 'squeue --json', ok: caps.squeueJson, note: '我的作业队列' },
    { label: 'sacct --json', ok: caps.sacctJson, note: '历史作业' },
    { label: 'scontrol show node --json', ok: caps.scontrolJson, note: '逐节点库存真值' }
  ]

  return (
    <div className="space-y-3">
      <p className="text-body leading-relaxed text-state-ok">
        ✓ 已连上 {caps.username}@{caps.host}（{caps.profileId}）· 耗时 {(response.totalMs / 1000).toFixed(1)}s
      </p>

      <div>
        <p className="mb-1 text-meta uppercase tracking-wide text-ink-500">JSON 支持（决定走哪条解析路径）</p>
        <ul className="space-y-1">
          {probes.map((probe) => (
            <li key={probe.label} className="flex flex-wrap items-baseline gap-1.5 text-body">
              <span className={probe.ok ? 'text-state-ok' : 'text-ink-500'}>{probe.ok ? '✓' : '·'}</span>
              <code className="font-mono text-sub text-ink-700">{probe.label}</code>
              <span className={probe.ok ? 'text-state-ok' : 'text-ink-500'}>
                {probe.ok ? '可用' : '不可用，走固定格式解析'}
              </span>
              <span className="text-sub text-ink-500">{probe.note}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="grid grid-cols-2 gap-x-6">
        <Field label="SLURM">{caps.slurmVersionNumber ?? '—'}</Field>
        <Field label="系统">{caps.os ?? '—'}</Field>
        <Field label="HOME">
          <Mono>{caps.home ?? '—'}</Mono>
        </Field>
        <Field label="sbatch">{caps.sbatchAvailable ? '可用' : '未找到'}</Field>
        <Field label="配额工具">{caps.quotaToolFound ? '可用' : '未找到'}</Field>
        <Field label="探测耗时">{(caps.durationMs / 1000).toFixed(1)}s</Field>
      </div>

      <RawBlock
        label="查看每条探测命令的原始输出"
        text={Object.entries(caps.evidence)
          .map(([key, item]) => `# ${key}  $ ${item.command}\nexit=${item.code}  ${item.durationMs}ms\n${item.stderr || '(无 stderr)'}`)
          .join('\n\n')}
      />
    </div>
  )
}

/** 探测失败：message + hint + 原始输出，一个都不能少 */
function ErrorPanel({ error }: { error: PlainError }): JSX.Element {
  return (
    <div className="rounded-surface border border-state-bad/25 bg-state-bad/[0.05] px-3 py-2.5">
      <p className="text-body font-medium text-state-bad">{error.message}</p>
      {error.hint && <p className="mt-1 text-sub text-state-bad">→ {error.hint}</p>}
      {error.issues && error.issues.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {error.issues.map((issue) => (
            <li key={issue} className="text-sub text-state-bad">
              · {issue}
            </li>
          ))}
        </ul>
      )}
      {error.raw && <RawBlock label="查看原始输出" text={error.raw} tone="red" />}
    </div>
  )
}

/**
 * 连接诊断。
 *
 * `onOpenSettings` 是给"未配置"那条用的：**这一页才是用户找配置文件时来的地方**，
 * 而改配置目录的开关在设置页。没有这条跳转，用户只能自己猜设置里有没有。
 */
function DiagnosticsView({ onOpenSettings }: { onOpenSettings?: () => void }): JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [response, setResponse] = useState<ProbeResponse | null>(null)
  const [busy, setBusy] = useState(false)
  /** 诊断包：生成结果 / 进行中 / 错误 */
  const [bundle, setBundle] = useState<{ path: string; bytes: number; failed: number } | null>(null)
  const [bundleBusy, setBundleBusy] = useState(false)
  const [bundleError, setBundleError] = useState<string | null>(null)
  const [includeProbe, setIncludeProbe] = useState(false)

  useEffect(() => {
    void window.hpc.appInfo().then(setInfo)
  }, [])

  const runProbe = useCallback(async () => {
    setBusy(true)
    setResponse(null)
    try {
      setResponse(await window.hpc.probe())
    } catch (err) {
      setResponse({
        ok: false,
        totalMs: 0,
        error: {
          kind: 'ipc',
          message: '调用主进程失败，可能是 preload 没加载成功。',
          hint: '看开发终端的日志；必要时重启 npm run dev。',
          raw: String(err)
        }
      })
    } finally {
      setBusy(false)
    }
  }, [])

  /**
   * 导出诊断包。
   *
   * 采集和脱敏都在主进程，这里只管"按钮状态 + 结果显示"。
   * **采集失败不抛**：包照样生成，失败项写在包里的 manifest —— 所以这里
   * 只有"整个动作失败"（比如用户取消、磁盘写不了）才走错误分支。
   */
  const exportBundle = useCallback(async (): Promise<void> => {
    if (typeof window.hpc?.exportDiagnostics !== 'function') {
      setBundleError('当前 preload 还没有这个方法，重启应用再试。')
      return
    }
    setBundleBusy(true)
    setBundleError(null)
    setBundle(null)
    try {
      const result = await window.hpc.exportDiagnostics({ includeProbe })
      if (!result.ok || !result.path) {
        // 用户取消保存框也会走到这里，不当成错误
        if (result.error) {
          setBundleError([result.error.message, result.error.hint].filter(Boolean).join(' · '))
        }
        return
      }
      setBundle({
        path: result.path,
        bytes: result.bytes ?? 0,
        failed: result.failed?.length ?? 0
      })
    } catch (err) {
      setBundleError(err instanceof Error ? err.message : String(err))
    } finally {
      setBundleBusy(false)
    }
  }, [includeProbe])

  return (
    <PageShell>
      <PageHeader
        title="连接诊断"
        description={
          <>
            验证能否连上集群、跑通一条命令，并探测各命令是否支持{' '}
            <code className="font-mono text-body">--json</code>。所有连接参数都来自配置文件，源码里不带主机地址。
          </>
        }
      />

      <div className="space-y-4">
        <Card
          title="配置文件"
          aside={<span className="text-sub text-ink-500">{info?.configExists ? '已找到' : '未找到'}</span>}
        >
          <Field label="路径">
            <Mono>{info?.configPath ?? '…'}</Mono>
          </Field>
          {info && !info.configExists && (
            <div className="mt-2 rounded-surface border border-state-wait/25 bg-state-wait/[0.06] px-3 py-2.5 text-body leading-relaxed text-ink-800">
              还没有配置文件。把随应用附带的{' '}
              <code className="font-mono text-body">profiles.example.json</code> 复制成{' '}
              <code className="font-mono text-body">profiles.json</code> 放进上面那个目录，
              填上主机、用户名和认证方式即可。
              <span className="mt-1 block text-ink-600">
                想让它跟着安装目录走（便携），去「设置 → 配置目录」把模式改成「用程序目录」。
              </span>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void window.hpc.openConfigDir()}
                  className="rounded-control border border-ink-200 bg-surface px-2.5 py-1 text-sub text-ink-700 transition hover:bg-ink-50"
                >
                  打开配置目录
                </button>
                {/*
                  这一页是"找不到配置文件"时用户真正会来的地方，而改位置的开关在设置页。
                  不加这条跳转，用户只能自己猜"设置里是不是有"——实测就踩过。
                */}
                <button
                  type="button"
                  onClick={() => onOpenSettings?.()}
                  className="rounded-control border border-ink-300 bg-surface px-2.5 py-1 text-sub text-ink-700 transition hover:bg-ink-50"
                >
                  配置目录…
                </button>
              </div>
            </div>
          )}
          <Field label="环境">
            <span className="text-body text-ink-600">
              Electron {info?.versions.electron} · Node {info?.versions.node} · {info?.platform}/{info?.arch}
            </span>
          </Field>
        </Card>

        <Card
          title="连接探针"
          aside={
            <button
              type="button"
              onClick={runProbe}
              disabled={busy}
              className="rounded-control bg-inverse px-3.5 py-1.5 text-body font-medium text-white transition hover:bg-ink-800 disabled:cursor-not-allowed disabled:bg-ink-300"
            >
              {busy ? '探测中…' : '运行'}
            </button>
          }
        >
          {!response && !busy && (
            <p className="text-body leading-relaxed text-ink-500">
              在真实连接上跑 9 条命令：版本、系统、HOME、sbatch、配额工具，以及 sinfo / squeue / sacct / scontrol
              的 JSON 支持情况。结果会缓存到 <code className="font-mono text-body">config/.cache/</code>。
            </p>
          )}
          {busy && <p className="text-body text-ink-500">正在连接并执行探测命令…</p>}
          {response?.ok && <SuccessPanel response={response} />}
          {response && !response.ok && response.error && <ErrorPanel error={response.error} />}
          {response?.warnings && response.warnings.length > 0 && (
            <ul className="mt-3 space-y-1">
              {response.warnings.map((warning) => (
                <li key={warning} className="text-body text-state-wait">
                  · {warning}
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/*
          诊断包放在探针下面：探针回答"现在通不通"，诊断包回答"出问题时把现场带给我"。
          两个动作都不该自动发生——都得用户点。
        */}
        <Card
          title="诊断包"
          aside={<span className="text-sub text-ink-500">不含密码与私钥</span>}
        >
          <p className="text-body leading-relaxed text-ink-600">
            把现场打成一个 <code className="font-mono text-body">.tar.gz</code>：版本信息、脱敏后的配置、
            最近 200 条命令记录、探测结果。主机地址、用户名、私钥路径都会遮蔽，命令里的密码一律替换成 ***。
          </p>

          <label className="mt-2 flex items-center gap-2 text-body text-ink-700">
            <input
              type="checkbox"
              checked={includeProbe}
              onChange={(event) => setIncludeProbe(event.target.checked)}
              className="h-3.5 w-3.5"
            />
            顺便测一次连接（会真的连一次集群，2–4 秒）
          </label>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void exportBundle()}
              disabled={bundleBusy}
              className="rounded-control bg-inverse px-3.5 py-1.5 text-body font-medium text-white transition hover:bg-ink-800 disabled:cursor-not-allowed disabled:bg-ink-300"
            >
              {bundleBusy ? '正在收集…' : '导出诊断包…'}
            </button>
            {bundle && (
              <button
                type="button"
                onClick={() => void window.hpc.revealPath(bundle.path)}
                className="rounded-control border border-ink-200 bg-surface px-3 py-1.5 text-body text-ink-700 transition hover:bg-ink-50"
              >
                打开所在文件夹
              </button>
            )}
          </div>

          {bundle && (
            <div className="mt-2 rounded-surface border border-state-ok/30 bg-state-ok/[0.06] px-3 py-2 text-body leading-relaxed text-ink-800">
              已保存：<Mono>{bundle.path}</Mono>
              <span className="ml-1 text-ink-600">（{formatSize(bundle.bytes)}）</span>
              {bundle.failed > 0 && (
                <span className="mt-1 block text-state-wait">
                  有 {bundle.failed} 项没能采集到（比如配置读不到），已记在包里的 manifest.json，其余内容照常可用。
                </span>
              )}
            </div>
          )}

          {bundleError && (
            <div className="mt-2 rounded-surface border border-state-bad/25 bg-state-bad/[0.06] px-3 py-2 text-body leading-relaxed text-ink-800">
              {bundleError}
            </div>
          )}
        </Card>
      </div>

      <p className="mt-6 text-sub leading-relaxed text-ink-500">
        命令行也能跑同一套逻辑：<code className="font-mono">npm run probe</code>，加{' '}
        <code className="font-mono">-- --json</code> 输出纯 JSON。
      </p>
    </PageShell>
  )
}

/**
 * 轮询分级（docs/04 §5.1 P6 要求跳板机上的轮询必须分级）：
 * 作业状态会变，20 秒一次；配额和点数几乎不动，而且配额实测要 550 ms，5 分钟一次足够。
 */
const JOBS_POLL_MS = 20_000
const SLOW_POLL_MS = 5 * 60_000

/** 命令台开合状态的持久化键：展开状态是"我的习惯"，不该每次重启都回到默认 */
const TRACE_PREF_KEY = 'hpc.trace.open'

/** 命令面板"最近选过"的持久化键。跨会话才有意义，见 `recentIds` 的注释 */
const RECENT_KEY = 'hpc.palette.recent'

/** 只留最近 5 条：排序权重里第 6 条以后的值已经是 0，存了也没用 */
const RECENT_LIMIT = 5

/**
 * 读"最近选过"。
 *
 * 解析逻辑在 `lib/command-palette.ts` 的 `parseRecentIds` 里（纯函数，有单测）。
 * 这里只负责碰存储——存储不可用（隐私模式/被禁）时静默返回空，
 * 宁可丢掉排序权重，也不要让一个锦上添花的功能把应用搞崩。
 */
function loadRecentIds(): string[] {
  try {
    return parseRecentIds(window.localStorage.getItem(RECENT_KEY), RECENT_LIMIT)
  } catch {
    return []
  }
}

function saveRecentIds(ids: string[]): void {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(ids))
  } catch {
    // 同上：记不住偏好不影响功能，下一轮排序退化而已
  }
}

/** 通知只留最近这么多条：这是"最近发生了什么"的流水，不是日志归档 */
const MAX_NOTIFICATIONS = 50

/** 作业结束时，状态映射成人话 + 通知的紧急程度 */
const END_STATE: Record<string, { text: string; level: NotificationLevel }> = {
  completed: { text: '已完成', level: 'success' },
  failed: { text: '失败', level: 'error' },
  timeout: { text: '超时', level: 'error' },
  'out-of-memory': { text: '内存超限', level: 'error' },
  'node-fail': { text: '节点故障', level: 'error' },
  cancelled: { text: '已取消', level: 'warning' },
  preempted: { text: '被抢占', level: 'warning' }
}

export default function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('files')

  /*
   * 托盘驻留模式下，窗口隐藏也要继续轮询——否则"作业跑完通知我"会失效。
   * 模式由主进程持有（它才知道关窗时留下了没有），这里启动时同步一次。
   */
  useEffect(() => {
    void window.hpc
      ?.residency()
      .then((result) => setTrayResident(result.mode !== 'quit'))
      .catch(() => undefined)
  }, [])

  /**
   * 启动页。
   *
   * 冷启动时窗口已经 show:false 等着，从渲染完成到第一轮数据回来之间
   * 还有 1–3 秒的空白。启动页把这段时间变成三段有结论的检查。
   *
   * `booted` 一旦为 true 就再也不显示——它只在一次进程生命周期里出现一次，
   * 页面之间的切换绝不该重播。
   */
  const [booting, setBooting] = useState(true)

  /**
   * 本机栏默认目录提升到这里：
   * 文件页的工具栏和设置页都要显示/修改它，放各自组件里会两边不同步。
   */
  const [defaultStartDir, setDefaultStartDir] = useState<string | null>(null)

  /**
   * 窗口里的 preload 是不是旧的。
   *
   * 一旦为真，所有新加的 `window.hpc.*` 都调不通，各处会报
   * `xxx is not a function`。这个横幅就是为了别让用户
   * 对着那种报错猜半天——它不是 bug，是没重启。
   */
  const [preloadOutdated, setPreloadOutdated] = useState(false)

  useEffect(() => {
    setPreloadOutdated(preloadStale())
  }, [])

  useEffect(() => {
    void window.hpc.getLocalStart().then((result) => setDefaultStartDir(result.dir))
  }, [])

  /**
   * 堵住 Electron 的默认拖放行为。
   *
   * 把文件拖到窗口空白处时，Chromium 会**导航到那个 file:// 地址**，
   * 整个应用瞬间变成显示这个文件——看起来就像程序崩了。
   *
   * 但这里不能无条件 preventDefault：`dragover` 一旦被阻止，
   * 浏览器就会认为整块区域都能放，文件栏里"禁止光标"的反馈也就没了。
   * 所以只拦**投放区以外**的地方，栏内交给 FilePane 自己判断。
   *
   * 补充原理：`dragover` 不 preventDefault 时 `drop` 根本不会触发，
   * 所以非投放区既不会导航、也不会有反应，正是想要的效果。
   */
  useEffect(() => {
    const blockOutsideDropZones = (event: DragEvent): void => {
      const target = event.target as HTMLElement | null
      if (target?.closest('[data-drop-zone]')) return
      event.preventDefault()
    }

    window.addEventListener('dragover', blockOutsideDropZones)
    window.addEventListener('drop', blockOutsideDropZones)
    return () => {
      window.removeEventListener('dragover', blockOutsideDropZones)
      window.removeEventListener('drop', blockOutsideDropZones)
    }
  }, [])

  // —— 首次运行引导 ——
  //
  // 没有 config/profiles.json 时，所有 IPC 都会失败，界面上满屏红字。
  // 新克隆下来的人根本不知道要建这个文件（而且它是 gitignore 的，克隆下来必然没有）。
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)

  const checkConfig = useCallback(async (): Promise<void> => {
    try {
      setAppInfo(await window.hpc.appInfo())
    } catch {
      // 连 appInfo 都调不通，说明 preload 坏了，顶部那条横幅会说明
    }
  }, [])

  useEffect(() => {
    void checkConfig()
  }, [checkConfig])

  // —— 标题栏那三个"电量"数字 ——
  //
  // preload 是旧版本时这些方法根本不存在，直接调用会抛，所以先探一下。
  const hasJobs = typeof window.hpc?.listJobs === 'function'
  const hasQuota = typeof window.hpc?.getQuota === 'function'
  const hasPoints = typeof window.hpc?.getPoints === 'function'

  /**
   * 切换跳板机的"纪元"。每切一次 +1，用来：
   * - 让三个轮询立刻重来一轮（否则要等 5 分钟才看到新机器的配额）
   * - 把页面上的旧数据重置掉（各页面自己的加载 hook 也吃这个值）
   *
   * 用它而不是直接传 profileId：轮询函数本身不该关心"当前连哪台"，
   * 那是主进程的状态。渲染层只需要知道"该重新拉一次了"。
   */
  const [profileEpoch, setProfileEpoch] = useState(0)

  const loadJobs = useCallback(async (): Promise<JobsListResponse> => {
    const response = await window.hpc.listJobs()
    // 失败要抛出去，让轮询进入退避；返回"空作业列表"会把断线伪装成"没作业"
    if (!response.ok) throw new Error(response.error?.message ?? '查询作业失败')
    return response
  }, [])

  const loadQuota = useCallback(async (): Promise<QuotaResponse> => {
    const response = await window.hpc.getQuota()
    if (!response.ok) throw new Error(response.error?.message ?? '查询配额失败')
    return response
  }, [])

  const loadPoints = useCallback(async (): Promise<PointsResponse> => {
    const response = await window.hpc.getPoints()
    if (!response.ok) throw new Error(response.error?.message ?? '查询点数失败')
    return response
  }, [])

  const jobsPoll = usePoll(loadJobs, JOBS_POLL_MS, hasJobs, profileEpoch)
  const quotaPoll = usePoll(loadQuota, SLOW_POLL_MS, hasQuota, profileEpoch)
  const pointsPoll = usePoll(loadPoints, SLOW_POLL_MS, hasPoints, profileEpoch)

  const jobList = jobsPoll.data?.jobs ?? null
  const running = jobList === null ? null : jobList.filter((job) => job.state === 'running').length
  const pending = jobList === null ? null : jobList.filter((job) => job.state === 'pending').length
  const quotaPercent = quotaUsagePercent(quotaPoll.data?.quotas?.[0])
  const points = pointsPoll.data?.points?.avail ?? null

  /**
   * 历史作业（`sacct`，最近 7 天）——**只给命令面板搜索用**。
   *
   * 为什么不放进轮询：`sacct` 比 `squeue` 慢得多，而历史数据几乎不变，
   * 每 20 秒查一次纯属浪费跳板机。
   *
   * 所以策略是**按需加载一次**：用户第一次敲开命令面板去搜、
   * 并且当前队列里没搜到时才发这条命令。加载过就不再发。
   *
   * 另一个好处：历史作业带着 `workDir`（`sacct` 的 `working_directory`），
   * 而队列里的作业没有——所以从历史里点进日志，定位比从队列里点更准。
   */
  const [historyJobs, setHistoryJobs] = useState<JobHistory[] | null>(null)
  const historyLoadingRef = useRef(false)
  const loadHistoryForSearch = useCallback(async (): Promise<void> => {
    if (historyJobs !== null || historyLoadingRef.current) return
    historyLoadingRef.current = true
    try {
      const response = await window.hpc.listJobHistory({ days: 7 })
      if (response.ok && response.jobs) {
        // 与作业页一致：按作业号倒序，最近的在前
        setHistoryJobs([...response.jobs].sort((a, b) => Number(b.id) - Number(a.id)))
      } else {
        // 失败就当"没有历史"，不弹错误——用户只是想搜个作业号，
        // 不该为此看到一个红框。真正的失败在作业页的历史标签里能看到。
        setHistoryJobs([])
      }
    } catch {
      setHistoryJobs([])
    } finally {
      historyLoadingRef.current = false
    }
  }, [historyJobs])

  /**
   * 连接状态以"作业轮询"为准：它最快也最频繁。
   * 拿到过数据、最近一次却失败 → 连接异常；一次都没成功 → 还在连。
   */
  const status: ConnectionStatus =
    jobsPoll.data !== null ? (jobsPoll.error ? 'offline' : 'online') : jobsPoll.error ? 'offline' : 'connecting'

  // —— 通知中心 ——
  const [notifications, setNotifications] = useState<AppNotification[]>([])
  const [panelOpen, setPanelOpen] = useState(false)
  /** 上一次的作业快照，用来算差集。null = 还没拿到第一份 */
  const previousJobs = useRef<JobWatchEntry[] | null>(null)

  const pushNotification = useCallback(
    (item: { level: NotificationLevel; title: string; detail?: string; jobId?: string }): void => {
      const notification: AppNotification = {
        ...item,
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        at: Date.now(),
        read: false
      }
      setNotifications((list) => [notification, ...list].slice(0, MAX_NOTIFICATIONS))

      // 系统通知：窗口在前台时主进程会直接跳过，这里不用判断焦点
      if (typeof window.hpc?.showNotification === 'function') {
        void window.hpc
          .showNotification({ title: item.title, body: item.detail })
          .catch(() => {
            // 弹不出系统通知不该影响应用内那份记录
          })
      }
    },
    []
  )

  /**
   * 作业状态变化 → 通知。
   *
   * `squeue` 只列活跃作业，所以"运行中忽然消失"就是结束了；
   * 但成功还是失败它不会说，得再查一次 `scontrol show job`（刚结束的作业还在控制器里）。
   * 这一步只发生在作业真的结束时，不在轮询的常驻路径上。
   */
  useEffect(() => {
    const list = jobsPoll.data?.jobs
    if (!list) return

    const next: JobWatchEntry[] = list.map((job) => ({ id: job.id, name: job.name, state: job.state }))
    const events = diffJobSnapshots(previousJobs.current, next)
    previousJobs.current = next

    /** 这一轮里结束的作业，攒到一起再发通知 */
    const finished: JobWatchEvent[] = []

    for (const event of events) {
      if (event.kind === 'started') {
        pushNotification({
          level: 'info',
          title: `作业 ${event.jobId} 开始运行`,
          detail: event.jobName,
          jobId: event.jobId
        })
        continue
      }

      if (event.kind === 'dropped') {
        pushNotification({
          level: 'warning',
          title: `作业 ${event.jobId} 还没开始就离开队列`,
          detail: `${event.jobName} · 可能被取消或被抢占`,
          jobId: event.jobId
        })
        continue
      }

      finished.push(event)
    }

    /*
     * 结束事件先收集、再统一发。
     *
     * 一次实验交 30 个 job，同一轮轮询里可能一次结束 10 个——挨个弹就是灾难。
     * 一个：保持原来的详细消息；多个：合成一条「10 个作业结束（8 成功 / 2 失败）」。
     *
     * 这是"作业组"的降噪部分；分组本身在作业页里做（见 `lib/job-groups.ts`）。
     */
    if (finished.length === 1) {
      const only = finished[0]!
      void (async () => {
        try {
          const response = await window.hpc.readJobDetail({ jobId: only.jobId })
          const detail = response.ok ? response.detail : null

          if (!detail) {
            pushNotification({
              level: 'info',
              title: `作业 ${only.jobId} 已离开队列`,
              detail: response.error?.message ?? '查不到最终状态，去作业页看看',
              jobId: only.jobId
            })
            return
          }

          const mapped = END_STATE[detail.state] ?? { text: '已结束', level: 'info' as const }
          pushNotification({
            level: mapped.level,
            title: `作业 ${only.jobId} ${mapped.text}`,
            detail: [
              detail.name,
              detail.nodes ? `跑在 ${detail.nodes}` : null,
              detail.state === 'completed' && detail.exitCode !== null ? `退出码 ${detail.exitCode}` : null,
              detail.stateReasonText || null
            ]
              .filter(Boolean)
              .join(' · '),
            jobId: only.jobId
          })
        } catch (err) {
          pushNotification({
            level: 'info',
            title: `作业 ${only.jobId} 已离开队列`,
            detail: `查不到最终状态：${err instanceof Error ? err.message : String(err)}`,
            jobId: only.jobId
          })
        }
      })()
    } else if (finished.length > 1) {
      void (async () => {
        const details = await Promise.all(
          finished.map((item) =>
            window.hpc
              .readJobDetail({ jobId: item.jobId })
              .then((response) => (response.ok ? response.detail : null))
              .catch(() => null)
          )
        )

        const ok = details.filter((detail) => detail?.state === 'completed').length
        const bad = details.filter((detail) =>
          ['failed', 'timeout', 'node-fail', 'out-of-memory', 'preempted'].includes(detail?.state ?? '')
        ).length
        const other = finished.length - ok - bad
        const names = [...new Set(finished.map((item) => item.jobName))].slice(0, 3).join('、')

        pushNotification({
          level: bad > 0 ? 'error' : 'success',
          title: `${finished.length} 个作业结束`,
          detail: [`${names}${finished.length > 3 ? ' 等' : ''}`, `${ok} 成功`, bad > 0 ? `${bad} 失败` : null, other > 0 ? `${other} 其他` : null]
            .filter(Boolean)
            .join(' · ')
        })
      })()
    }
  }, [jobsPoll.data, pushNotification])

  // —— 全局搜索 / 命令面板 ——
  const [paletteOpen, setPaletteOpen] = useState(false)
  /**
   * 最近选过的条目，用来给排序加权。
   *
   * **必须跨会话保留**：这个功能的价值全在"明天打开时它还记得我今天用过什么"。
   * 只活一次会话等于白做——第一版就是纯 `useState([])`，重启即忘。
   *
   * 只存 id 字符串（如 `nav:nodes`），不存对象：条目标题/副标题随时可能改，
   * 存快照会让排序权重跟着过期数据走。
   */
  const [recentIds, setRecentIds] = useState<string[]>(loadRecentIds)
  const rememberRecent = useCallback((id: string): void => {
    setRecentIds((ids) => {
      const next = pushRecent(ids, id)
      saveRecentIds(next)
      return next
    })
  }, [])
  /** 从命令面板打开日志弹窗的作业（不经过作业页） */
  const [paletteJob, setPaletteJob] = useState<{ id: string; name: string; workDir: string | null } | null>(null)
  /** true = 让作业页弹出提交表单（它消费后会立刻清回 false） */
  const [submitRequest, setSubmitRequest] = useState(false)

  // —— 命令记录（底部抽屉）——
  const [traceOpen, setTraceOpen] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(TRACE_PREF_KEY) === '1'
    } catch {
      return false
    }
  })
  const applyTraceOpen = useCallback((open: boolean): void => {
    setTraceOpen(open)
    try {
      window.localStorage.setItem(TRACE_PREF_KEY, open ? '1' : '0')
    } catch {
      // 隐私模式/存储被禁：只是记不住偏好，不影响功能
    }
  }, [])
  const toggleTrace = useCallback((): void => applyTraceOpen(!traceOpen), [applyTraceOpen, traceOpen])

  /**
   * 命令面板第一次打开时，顺手把历史作业捞一次。
   *
   * 不放在轮询里：`sacct` 慢，而历史数据基本不变，每 20 秒查一次是浪费跳板机。
   * 也不放在冷启动里：那是启动页要跑的路径，不该为"可能要搜历史作业"
   * 付这个代价（启动页的预算是 8000ms，实测 346ms，别自己加负担）。
   *
   * 打开面板时加载是折中的：用户已经在主动找东西了，多这 200~400ms 可接受；
   * 而且 `loadHistoryForSearch` 自己保证只发一次。
   */
  useEffect(() => {
    if (paletteOpen) void loadHistoryForSearch()
  }, [paletteOpen, loadHistoryForSearch])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // 焦点在终端里时把 Ctrl+K 让给 shell（bash 的 kill-line），别抢
      const inTerminal = (event.target as HTMLElement | null)?.closest('[data-terminal]') !== null
      if (inTerminal) return

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((open) => !open)
        return
      }
      // Ctrl+`：和 VSCode 同一个位置的开合习惯
      if ((event.ctrlKey || event.metaKey) && event.key === '`') {
        event.preventDefault()
        toggleTrace()
        return
      }
      // 兜底：焦点不在输入框里时（比如刚点过结果区）Esc 也要能关
      if (event.key === 'Escape') setPaletteOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggleTrace])

  const paletteItems: PaletteItem[] = useMemo(() => {
    /**
     * 导航项从 `DOCK_TABS` 生成，**不再手写第二份清单**。
     *
     * 原来这里是一个手写的 5 项数组，而 Dock 有 7 个页签——
     * 「隧道」和「终端」在命令台里搜不到，用户敲 Ctrl+K 搜"隧道"得到"没有匹配"，
     * 于是不再信任这个入口。两份清单漂移没有任何编译期信号，只能靠单一数据源。
     */
    const nav: PaletteItem[] = DOCK_TABS.map((tab) => ({
      id: `nav:${tab.id}`,
      title: tab.label,
      subtitle: tab.hint,
      keywords: tab.keywords,
      kind: 'nav' as const
    }))
    const actions: PaletteItem[] = [
      { id: 'action:submit', title: '提交作业', subtitle: '打开提交表单', keywords: 'sbatch new', kind: 'action' },
      {
        id: 'action:trace',
        title: '命令记录',
        subtitle: '看应用背后发了哪些命令',
        keywords: 'trace command shell 日志 命令',
        kind: 'action'
      }
    ]
    // 当前队列里的作业：搜作业号或名字，直接跳到它的日志
    const jobs: PaletteItem[] = (jobList ?? []).map((job) => ({
      id: `job:${job.id}`,
      title: `${job.id}  ${job.name}`,
      subtitle: [job.rawState, job.nodes].filter(Boolean).join(' · '),
      keywords: 'job',
      kind: 'job' as const
    }))

    /**
     * 历史作业（已完成/失败/取消的）。
     *
     * 解决的真实场景：「上周那个跑挂的作业编号 21130x，我想看它的日志」——
     * 它早就不在 `squeue` 里了，以前必须先切作业页、再点「历史（7 天）」、
     * 再在列表里翻。而这恰恰是命令面板最该解决的事。
     *
     * 用 `hjob:` 前缀而不是 `job:`：两者 id 可能重叠（同一个作业既在队列里
     * 又刚结束进了 sacct），前缀不同才能分清点哪个。队列里的优先显示。
     */
    const queuedIds = new Set((jobList ?? []).map((job) => job.id))
    const history: PaletteItem[] = (historyJobs ?? [])
      .filter((job) => !queuedIds.has(job.id))
      .map((job) => ({
        id: `hjob:${job.id}`,
        title: `${job.id}  ${job.name}`,
        // 历史作业要标出结局和结束时间，否则一列作业号看不出哪个是那个失败的
        subtitle: [job.rawState, job.endTime ? formatAgo(job.endTime) : null].filter(Boolean).join(' · '),
        keywords: `job history sacct ${job.name}`,
        kind: 'job' as const
      }))

    /**
     * 这里**不做截断**。
     *
     * 曾经写过 `history.slice(0, 200)`，看起来是"给模糊匹配设个上限防止卡顿"，
     * 实际截掉的是按作业号倒序的前 200 条，而不是最相关的 200 条——
     * 想搜的作业如果排在第 201 位，面板只会说"没有匹配"，
     * 用户以为是 sacct 没数据，其实是自己的代码剪掉的。
     * 上限现在由面板在**排序之后**施加（`RESULT_LIMIT`）。
     */
    return [...actions, ...nav, ...jobs, ...history]
  }, [jobList, historyJobs])

  const clearSubmitRequest = useCallback(() => setSubmitRequest(false), [])

  const runPaletteItem = useCallback(
    (item: PaletteItem): void => {
      rememberRecent(item.id)
      setPaletteOpen(false)

      if (item.id.startsWith('nav:')) {
        setTab(item.id.slice('nav:'.length) as Tab)
        return
      }
      if (item.id === 'action:submit') {
        setTab('jobs')
        setSubmitRequest(true)
        return
      }
      if (item.id === 'action:trace') {
        applyTraceOpen(true)
        return
      }
      if (item.id.startsWith('job:')) {
        const jobId = item.id.slice('job:'.length)
        const job = jobList?.find((entry) => entry.id === jobId)
        // `squeue` 不给工作目录，只能让日志弹窗去猜文件名（猜错就给候选人）
        if (job) setPaletteJob({ id: job.id, name: job.name, workDir: null })
        return
      }
      /**
       * 历史作业：`sacct` 带 `working_directory`，所以这里能给出精确的 workDir。
       *
       * 这也是"搜到历史作业"的额外价值：从历史点进日志比从队列点更准，
       * 因为日志弹窗不用猜 `<作业名>-<作业号>.out`——很多作业用了
       * `--output xxx.log`，猜必错（docs/04 E17）。
       */
      if (item.id.startsWith('hjob:')) {
        const jobId = item.id.slice('hjob:'.length)
        const job = historyJobs?.find((entry) => entry.id === jobId)
        if (job) setPaletteJob({ id: job.id, name: job.name, workDir: job.workDir })
      }
    },
    [historyJobs, jobList, rememberRecent]
  )

  const unreadCount = notifications.filter((item) => !item.read).length

  /**
   * 顶部提示条的内容。按严重度排好——BannerStack 会自己再把 blocker 提到前面，
   * 这里保持一个合理的书写顺序（越严重的写在越前面）便于阅读代码。
   */
  const banners: BannerItem[] = []
  if (preloadOutdated) {
    banners.push({
      id: 'preload',
      level: 'blocker',
      tag: '版本旧',
      message: (
        <>
          窗口里跑的 preload 还是上一次编译的，新接口（命令台、隧道自检、启动页）会报{' '}
          <code className="font-mono">is not a function</code>。
        </>
      ),
      detail: (
        <>
          把应用完全关掉，重新 <code className="font-mono">npm run dev</code> 即可。这不是代码 bug。
        </>
      )
    })
  }
  /*
   * 没配置时整页换成向导，不再用「横幅 + 让人手改 JSON」。
   *
   * 那条横幅对写代码的人够用，对"装完想连集群"的人不够：不知道该放哪、
   * 哪个字段必填、密码该不该写进去。向导把这三件事一次问完。
   *
   * 注意 `booting` 结束后才会走到这里，所以启动页仍然先跑一遍三步检查
   * （它会报告"找不到配置文件"，那正是向导要解决的问题）。
   */
  const needsSetup = appInfo !== null && !appInfo.configExists

  const statusDetail = jobsPoll.error
    ? `最近一次查询失败：${(jobsPoll.error as Error).message}`
    : jobsPoll.updatedAt !== null
      ? `最近更新：${new Date(jobsPoll.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}（每 20 秒刷新）`
      : '正在连接集群…'

  return (
    <div className="relative flex h-full flex-col">
      <TitleBar
        status={status}
        statusDetail={statusDetail}
        running={running}
        pending={pending}
        quotaPercent={quotaPercent}
        points={points}
        // 标题栏三块电量数字可点击跳页：作业 / 存储（资源页的配额）/ 点数
        onNavigate={setTab}
        activeTab={tab}
        onSearch={() => setPaletteOpen(true)}
        traceOpen={traceOpen}
        onToggleTrace={toggleTrace}
        profileSwitcher={
          <ProfileSwitcher
            onSwitched={(result) => {
              // 加一：三个轮询立刻重来，各页面的数据也跟着重置
              setProfileEpoch((value) => value + 1)
              // 历史作业是 sacct 拉的，属于旧机器，清掉
              setHistoryJobs(null)
              const closed = result.closed
              const parts: string[] = []
              if (closed?.terminals) parts.push(`${closed.terminals} 个终端`)
              if (closed?.tunnels) parts.push(`${closed.tunnels} 条隧道`)
              if (closed?.connections) parts.push(`${closed.connections} 条连接`)
              pushNotification({
                level: parts.length > 0 ? 'warning' : 'success',
                title: `已切换到 ${result.activeId}`,
                // 如实报告断了什么：用户手动开的东西被关掉，必须让他知道
                detail: parts.length > 0 ? `为切换断开了 ${parts.join('、')}。` : undefined
              })
            }}
            onError={(message, hint) => {
              pushNotification({ level: 'error', title: '切换失败', detail: hint ? `${message}（${hint}）` : message })
            }}
          />
        }
        bell={
          <NotificationBell
            unread={unreadCount}
            open={panelOpen}
            onClick={() => {
              setPanelOpen((open) => !open)
              // 打开就算读过了：徽章的数字是"有新东西"，不是"待办事项"
              if (!panelOpen) setNotifications((list) => list.map((item) => ({ ...item, read: true })))
            }}
          />
        }
      />

      {paletteOpen && (
        <CommandPalette
          items={paletteItems}
          recentIds={recentIds}
          onRun={runPaletteItem}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {paletteJob && (
        <JobLogDialog
          jobId={paletteJob.id}
          jobName={paletteJob.name}
          workDir={paletteJob.workDir}
          onClose={() => setPaletteJob(null)}
        />
      )}

      {panelOpen && (
        <NotificationPanel
          items={notifications}
          onMarkAllRead={() => setNotifications((list) => list.map((item) => ({ ...item, read: true })))}
          onClear={() => setNotifications([])}
          onClose={() => setPanelOpen(false)}
          onOpenJobs={() => {
            setTab('jobs')
            setPanelOpen(false)
          }}
        />
      )}

      {/*
        顶部提示条。原来这里是两段独立 JSX（preload 过期、配置缺失），
        会同时出现并吃掉 100px 以上，且都在最该留给内容的位置。
        现在交给 BannerStack：一次只显示最严重的一条，其余折叠。

        两处都**不给关闭按钮**：它们描述的是"当前状态下部分功能就是坏的"，
        不是通知。重启/建好配置就消失，留着比让人误关掉强。
      */}
      <BannerStack items={banners} />

      {/*
        没有配置 → 整页向导（Dock 也藏起来：那些页此刻全都会报错，
        点进去只会得到一屏红字，对"还没配"的人是噪声）。
        TitleBar 必须留着——窗口是无边框的，没有它就没法关窗口。
      */}
      {needsSetup ? (
        <SetupWizard onDone={() => void checkConfig()} />
      ) : (
      <div className="flex min-h-0 flex-1">
        <Dock active={tab} onChange={setTab} />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {tab === 'files' && (
            <FileView defaultStartDir={defaultStartDir} onStartDirChange={setDefaultStartDir} />
          )}
          {tab === 'jobs' && (
            <JobsView
              submitRequest={submitRequest}
              onSubmitRequestHandled={clearSubmitRequest}
              refreshKey={profileEpoch}
            />
          )}
          {tab === 'nodes' && <ResourcesView refreshKey={profileEpoch} />}
          {tab === 'points' && <PointsView refreshKey={profileEpoch} />}
          {tab === 'tunnels' && <TunnelsView />}
          {tab === 'terminal' && <TerminalView />}
          {tab === 'settings' && (
            <SettingsView defaultStartDir={defaultStartDir} onStartDirChange={setDefaultStartDir} />
          )}
          {tab === 'diagnostics' && <DiagnosticsView onOpenSettings={() => setTab('settings')} />}
        </div>
      </div>
      )}

      {/*
        命令台改成浮层（见 TracePanel）：这里不再改变主布局的高度，
        所以它移到最外层也不会把文件页的传输条挤出屏幕。
      */}
      {traceOpen && <TracePanel onClose={() => applyTraceOpen(false)} />}

      {/*
        启动页盖在最上面。它自己负责淡出，`booting` 置 false 后整体卸载。
        z 值比命令台/弹窗都高：冷启动时这些东西都还没出现，
        但如果用户按 Esc 跳过，之后打开它们也不该被启动页（正在淡出）挡住。
      */}
      {booting && (
        <BootSplash
          onDone={() => setBooting(false)}
          onDiagnose={() => {
            setBooting(false)
            setTab('diagnostics')
          }}
        />
      )}
    </div>
  )
}
