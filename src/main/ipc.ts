/**
 * IPC 注册与白名单。
 *
 * 渲染层没有 Node 权限，只能调这里注册过的方法（docs/04 §1.2）。
 * 所有需要碰网络的事情都发生在主进程，参数必须是可结构化克隆的普通对象——
 * 所以 Error 实例在这里先摊平成 PlainError，否则自定义字段（kind/hint/raw）过不了 IPC。
 */
import { BrowserWindow, Notification, app, dialog, ipcMain, nativeImage, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DirListing } from './fs/listing'
import { clearListingCache, invalidateListing, listLocalDir, listRemoteDir } from './fs/listing'
import type { TrashFn } from './fs/ops'
import {
  copyLocal,
  deleteLocal,
  deleteRemote,
  mkdirLocal,
  mkdirRemote,
  moveLocal,
  moveRemote,
  remoteHome,
  renameLocal,
  renameRemote
} from './fs/ops'
import type { Capabilities } from './ssh/capabilities'
import type { ConfigLocation } from './config-dir'
import { canCreateAt, isDirWritable } from './config-location'
import type { ApplySetupResult } from './setup'
import type { SetupDraft } from '../shared/setup'
import { defaultSshDir, readSshConfig, type SshImportResult } from './ssh-config-file'
import { TUNNEL_DEFAULTS, validateTunnelPorts, type TunnelDefaults } from '../shared/tunnel-defaults'
import { judgeLatency, type ProfileLatency } from '../shared/latency'
import { probeLatency } from './ssh/latency'
import { buildDiagnosticsBundle } from './diagnostics/bundle'
import { patchProfile, type ProfilePatch } from './profiles-edit'
import type { KnownHostsStore } from './ssh/known-hosts'
import { capabilityCacheKey, probeCapabilities } from './ssh/capabilities'
import type { Job } from './adapters/types'
import { SQUEUE_COMMAND, parseSqueue } from './adapters/squeue'
import type { JobHistory } from './adapters/sacct'
import { parseSacct, sacctCommand } from './adapters/sacct'
import type { JobDetail } from './adapters/types'
import { parseScontrolJob, scontrolJobCommand } from './adapters/scontrol-job'
import { resolveJobLogPath } from './domain/job-log'
import { lookupPortOwner, portBusyHint } from './domain/port-owner'
import { readProxyPort } from './domain/proxy-config'
import { clusterEgress, localProxyEgress, type EgressProbe } from './domain/egress'
import { openWithFallback, type FallbackInfo, type OpenResult } from './domain/reverse-port'
import type { TraceRecord, TraceStore } from './trace/store'
import { TRACE_LIMIT, type TraceEntry } from '../shared/trace'
import { parseNodeDetail } from './adapters/node-detail'
import { buildInventory, prettyGpuType, type GpuTypeStock, type Inventory } from './domain/inventory'
import type { Quota } from './adapters/types'
import { QUOTA_COMMAND, parseQuota } from './adapters/quota'
import type { GpuPrice } from './adapters/types'
import { GPU_PRICE_COMMAND, parseGpuPrice } from './adapters/gpu-price'
import type { Points } from './adapters/types'
import { POINTS_COMMAND, parsePoints } from './adapters/points'
import type { PointsUsage } from './adapters/points-usage'
import { USAGE_COMMAND, parseUsageTable } from './adapters/points-usage'
import { checkTransfer, giftInstruction } from './domain/points-transfer'
import { runWithPassword, extractCommandOutput, isPasswordRunSuccess } from './ssh/interactive'
import type { CredentialVault } from './credentials/vault'
import { explainVaultError } from './credentials/vault'
import {
  CREDENTIAL_KINDS,
  describeScope,
  isCredentialKind,
  type CredentialKind
} from './credentials/types'
import { findPlaintextAuth } from './credentials/resolve'
import { judgeLdapProbe, judgeSshProbe, testPassphrase, type CredentialTestOutcome } from './credentials/test'
import { Session } from './ssh/session'
import { readFile } from 'node:fs/promises'
import type { TunnelInfo, TunnelManager, TunnelRequest } from './forward/tunnel'
import type { ReverseTunnelManager, ReverseTunnelRequest } from './forward/reverse'
import type { TerminalService } from './terminal/service'
import {
  SBATCH_COMMAND,
  explainSbatchError,
  parseSubmittedJobId,
  parseTestOnlyOutput
} from './domain/sbatch'
import { shq } from './ssh/shell'
import type { BootStatus } from '../shared/boot'
import type { ConnectionPool } from './ssh/pool'
import { ConfigError } from './profiles'
import { loadProfiles, pickProfile } from './profiles'
import type { ProfileState, ProfileSummary } from './profile-state'
import { switchBlocker } from './profile-state'
import { SshError, normalizeSshError } from './ssh/errors'
import type { KVStore } from './store/kv'
import type { PlanRequest, TransferPlan } from './transfer/planner'
import type { QueueSnapshot } from './transfer/queue'
import { clearMirror, mirrorStats, prepareDragFile } from './transfer/mirror'
import type { TransferService } from './transfer/service'
import { makeDragIcon } from './shell/drag-icon'

export interface PlainError {
  kind: string
  message: string
  hint?: string
  raw: string
  code?: string
  /** 配置类错误的逐条问题清单 */
  issues?: string[]
}

export interface AppInfo {
  name: string
  version: string
  platform: string
  arch: string
  versions: { electron: string; node: string; chrome: string }
  configPath: string
  configExists: boolean
}

/**
 * 配置目录的现状。
 *
 * `source` 必须回给界面——用户改了"用程序目录"却没生效时，
 * 唯一能解释清楚的就是"当前生效的是哪一档、为什么"。
 */
export interface ConfigDirInfo {
  dir: string
  source: 'env' | 'custom' | 'portable' | 'default'
  /** 便携模式会用的目录（`<程序目录>/config`） */
  portableDir: string
  /** 兜底目录（`%APPDATA%/<productName>/config`） */
  defaultDir: string
  appRoot: string
  /** 指针文件里存的模式 */
  mode: 'auto' | 'custom' | 'portable'
  customDir?: string
  /** 便携目录存在但写不进去时，退回默认并说明原因 */
  fallback?: 'portable-not-writable'
  /** 由环境变量决定时，界面上的按钮要禁用——改了也不会生效 */
  readonly: boolean
}

export interface ProbeRequest {
  profileId?: string
}

export interface ProbeResponse {
  ok: boolean
  totalMs: number
  profile?: { id: string; label: string; host: string; port: number; username: string }
  capabilities?: Capabilities
  error?: PlainError
  warnings?: string[]
}

/** 本机栏默认打开哪个目录；没设置时用用户主目录 */
const LOCAL_START_KEY = 'files.localStartDir'

/** 测速结果缓存时长：面板开开关关不该每次都重新登录一遍 */
const LATENCY_TTL_MS = 5 * 60 * 1000
/** 测速缓存：按 profileId 存最近一次结果 */
const latencyCache = new Map<string, ProfileLatency>()
/** 正在进行的探测（同一时刻只测一台，并发会互相拖慢） */
let latencyInFlight: Promise<ProfileLatency> | null = null
let latencyInFlightId: string | null = null
/** 反向隧道默认端口：集群侧监听 / 本机代理 */
const TUNNEL_REMOTE_KEY = 'tunnel.reverseRemotePort'
const TUNNEL_LOCAL_KEY = 'tunnel.reverseLocalPort'

export interface JobsListResponse {
  ok: boolean
  jobs?: Job[]
  /** 这次查询的往返耗时，界面上显示"3 秒前更新"用 */
  durationMs?: number
  error?: PlainError
}

/** 库存型号项，多一个翻译好的人话名字 */
export interface GpuTypeStockPayload extends GpuTypeStock {
  label: string
}

export type InventoryPayload = Omit<Inventory, 'gpuTypes'> & { gpuTypes: GpuTypeStockPayload[] }

export interface SubmitJobRequest {
  /** command = 写一份新脚本；script = 直接提交已有的 .sh */
  mode: 'command' | 'script'
  /** 远端绝对路径 */
  scriptPath: string
  /** 仅 command 模式用：要写入的脚本内容 */
  content?: string
  /** sbatch 参数（不含命令名和脚本路径） */
  args: string[]
  profileId?: string
}

export interface DryRunResponse {
  ok: boolean
  startAt?: string | null
  nodes?: string | null
  processors?: number | null
  raw?: string
  error?: PlainError
}

export interface SubmitJobResponse {
  ok: boolean
  jobId?: string
  /** 实际提交的命令，出错时给用户看 */
  command?: string
  error?: PlainError
}

export interface GpuPriceResponse {
  ok: boolean
  prices?: GpuPrice[]
  durationMs?: number
  error?: PlainError
}

export interface QuotaResponse {
  ok: boolean
  quotas?: Quota[]
  durationMs?: number
  error?: PlainError
}

export interface JobLogResponse {
  ok: boolean
  /** 日志最后若干行 */
  content?: string
  /** 实际读到的文件路径 */
  path?: string
  /** 路径是怎么定下来的：`scontrol` 精确值 / `sacct` 推断。出问题时第一眼要看这个 */
  source?: 'scontrol' | 'sacct'
  /** 试过但没有的路径 */
  tried?: string[]
  error?: PlainError
}

export interface TerminalOpenResponse {
  ok: boolean
  sessionId?: string
  error?: PlainError
}

export interface TunnelStartResponse {
  ok: boolean
  tunnel?: TunnelInfo
  /** 默认端口被占时退到了别的端口；null/缺省表示开在了用户要的端口上 */
  fallback?: FallbackInfo | null
  /** 集群上 http_proxy 指向的端口；null = 读不到。和 listenPort 不一致时界面要提醒 */
  proxyPort?: number | null
  error?: PlainError
}

export interface TunnelListResponse {
  ok: boolean
  tunnels?: TunnelInfo[]
  error?: PlainError
}

export interface TunnelVerifyResponse {
  ok: boolean
  /** 集群侧经隧道取到的出口 IP */
  cluster?: EgressProbe
  /** 本机经 Clash 取到的出口 IP */
  local?: EgressProbe
  /** true = 两条路出口相同（确认走的是你的电脑）；null = 有一边没测出来 */
  same?: boolean | null
  /**
   * 探测期间这条隧道的计数器是否动过。
   *
   * `true` 说明字节确实穿过了本机的隧道——比出口 IP 更硬的证据（代理做负载均衡时
   * 出口 IP 天然会变）。`null` 表示没给出 tunnelId，无从判断。
   */
  moved?: boolean | null
  error?: PlainError
}

export interface PointsResponse {
  ok: boolean
  points?: Points
  durationMs?: number
  error?: PlainError
}

/** 点数消耗明细（`scir-account details [-r]`） */
export interface PointsUsageResponse {
  ok: boolean
  usage?: PointsUsage
  durationMs?: number
  error?: PlainError
}

/**
 * 送点数的请求。
 *
 * `password` **只在这一次调用里出现**，不落盘、不进日志、不进命令台记录
 * （`scir-account transfer` 的参数里没有密码，它是从 stdin 读的，
 * 所以命令记录里天然不会带）。用完立刻从内存里丢掉。
 */
export interface PointsTransferRequest {
  target: string
  points: number
  /** 几个月后过期（1 号到期），对应 `--month` */
  month: number
  /**
   * 用户当场输入的密码。只在这一次调用里存在，不落盘、不进日志、不进命令台。
   *
   * 留空且 `useStoredPassword` 为 true 时，主进程自己去凭据库取——
   * 这样存好的密码**完全不经过渲染层**。
   */
  password?: string
  /** 用「设置 → 登录凭据」里存的平台账号密码 */
  useStoredPassword?: boolean
  profileId?: string | null
}

export interface PointsTransferResponse {
  ok: boolean
  /** 转账成功后平台回的那行 `Transfer Status: …`，没有就为空 */
  message?: string
  /** 转账后重新查到的余额；查失败时为 undefined（转账本身可能已成功） */
  points?: Points
  durationMs?: number
  error?: PlainError
}

export interface JobDetailResponse {
  ok: boolean
  detail?: JobDetail
  /** 详情从哪来：`scontrol` 有精确输出路径，`sacct` 只有历史记录 */
  source?: 'scontrol' | 'sacct'
  error?: PlainError
}

export interface JobLogStreamStart {
  ok: boolean
  /** 停止时要带回这个 id */
  streamId?: string
  path?: string
  source?: 'scontrol' | 'sacct'
  /** 定位失败时试过的候选路径 */
  tried?: string[]
  /** tail 已经在跑了；失败时给出原因 */
  error?: PlainError
}

export interface LogRequest {
  jobId: string
  /** 历史表格里现成的就顺手带上，能省一次查询；没有也能查 */
  jobName?: string | null
  workDir?: string | null
  profileId?: string | null
}

/** 一路正在跟随的日志 */
interface LogStreamState {
  /** 按 webContents.id 区分，一个窗口只留一路 */
  senderId: number
  controller: AbortController
  buffer: string
  timer: NodeJS.Timeout | null
  flush: () => void
}

/** 跟随日志的合并推送间隔。日志一秒能刷几百行，一条一块地发会把渲染层打死 */
const LOG_FLUSH_INTERVAL_MS = 120

export interface NodeJob {
  id: string
  user: string
  cpus: number
  /** 占用的 GRES，比如 `gres:gpu:tesla_v100-sxm2-16gb:2`；纯 CPU 作业是 null */
  gres: string | null
  /** 预计结束时间，集群原样返回的字符串；N/A 表示没设时限 */
  endTime: string | null
  name: string
}

export interface NodeJobsResponse {
  ok: boolean
  jobs?: NodeJob[]
  error?: PlainError
}

export interface NodesListResponse {
  ok: boolean
  inventory?: InventoryPayload
  durationMs?: number
  error?: PlainError
}

export interface JobsHistoryResponse {
  ok: boolean
  jobs?: JobHistory[]
  durationMs?: number
  error?: PlainError
}

export interface JobCancelResponse {
  ok: boolean
  error?: PlainError
}

export interface IpcDeps {
  pool: ConnectionPool
  /**
   * "当前用哪台跳板机"的唯一持有者。
   *
   * 所有要连网络的 handler 都从这里取 profile，**不再直接调 `pickProfile`**。
   * 这就是"切换"能一次性生效的原因：只有一处状态。
   */
  profileState: ProfileState
  /**
   * 凭据保险库。
   *
   * 注意 `profileState` 里**已经注入了同一份** vault——`current()` 会用它把
   * 密码填进 profile，所以连终端/隧道/传输这些 handler 都不需要自己碰它。
   * 这里再传一份，是给"设置页管凭据"用的（增删改查、看状态）。
   */
  credentials: CredentialVault
  /** 主机指纹库。测速和连接池**必须共用同一个实例**，否则新记住的指纹互相看不见 */
  knownHosts?: KnownHostsStore
  /** 读关窗策略（托盘驻留） */
  getResidency?: () => 'quit' | 'when-busy' | 'always'
  /** 写关窗策略；实现方负责持久化与托盘菜单刷新 */
  setResidency?: (mode: 'quit' | 'when-busy' | 'always') => void
  /** 有没有传输/隧道在跑（决定"关窗是否驻留"） */
  hasActiveWork?: () => boolean
  configPath: () => string
  /** 配置目录现状（含"为什么是这个目录"） */
  configInfo: () => ConfigDirInfo
  /** 换配置目录；实现里负责写指针并重启应用 */
  setConfigLocation: (location: ConfigLocation) => { ok: boolean; error?: string }
  /** 首次向导：生成 profiles.json + 存凭据；`restartRequired` 表示目录变了需要重启 */
  applyInitialSetup: (request: {
    draft: SetupDraft
    /** 一起写入的其它主机（从 SSH 配置勾选进来的） */
    extras?: SetupDraft[]
    mode: ConfigLocation['mode']
    dir?: string
  }) => ApplySetupResult & { restartRequired: boolean }
  cache: KVStore
  transfer: TransferService
  tunnels: TunnelManager
  reverseTunnels: ReverseTunnelManager
  terminals: TerminalService
  trace: TraceStore
}

export interface ListProfilesResponse {
  ok: boolean
  profiles?: ProfileSummary[]
  activeId?: string
  error?: PlainError
}

/** 凭据状态。`available: false` 时界面必须禁用"保存"并说明原因 */
export interface CredentialsStatusResponse {
  ok: boolean
  status?: {
    available: boolean
    backend: string
    stored: number
    sessionOnly: number
  }
  error?: PlainError
}

export interface CredentialItem {
  kind: CredentialKind
  scope: string
  /** 给用户看的短形式（路径只留最后两段） */
  display: string
  /** 种类的中文名 */
  label: string
  /** 落盘时间；只在本次运行记住时为 null */
  savedAt: string | null
  sessionOnly: boolean
}

/** 一个"可以设凭据的位置"。scope 由主进程算好，界面只负责回传 */
export interface CredentialTarget {
  kind: CredentialKind
  scope: string
  display: string
  /** 属于哪条 profile（界面上分组用） */
  ownerLabel: string
  configured: boolean
  /** true = 不填也能正常登录（私钥不带口令是常态） */
  optional?: boolean
}

export interface CredentialsListResponse {
  ok: boolean
  status?: {
    available: boolean
    backend: string
    stored: number
    sessionOnly: number
  }
  items?: CredentialItem[]
  /** 可以设凭据的位置（scope 已由主进程算好） */
  targets?: CredentialTarget[]
  /** 配置文件里还写着明文的字段，提示用户迁走 */
  plaintext?: {
    profileId: string
    label: string
    field: 'password' | 'passphrase'
    canEncrypt: boolean
  }[]
  /** 用密码登录但还没存密码的 profile */
  missing?: { profileId: string; label: string }[]
  error?: PlainError
}

export interface CredentialsSetRequest {
  kind: CredentialKind
  scope: string
  /** 明文密码。只在这一次调用里存在，不落日志、不进命令台 */
  secret: string
  /** false = 只在本次运行内记住；默认 true */
  persist?: boolean
}

export interface CredentialsSetResponse {
  ok: boolean
  /** 是否真的落盘了。false 表示只在本次运行内有效 */
  persisted?: boolean
  /** 失败原因（已经是人话，可直接显示） */
  reason?: string
}

export interface CredentialsTestRequest {
  kind: CredentialKind
  scope: string
  /** 不传就测库里存的那条；传了就是"先存再测" */
  secret?: string
  profileId?: string | null
}

export interface CredentialsTestResponse {
  outcome: CredentialTestOutcome
}

export interface SetActiveResponse {
  ok: boolean
  activeId?: string
  /** 为了这次切换断掉了什么；界面据实告诉用户，不要悄悄关 */
  closed?: { terminals: number; tunnels: number; connections: number }
  error?: PlainError
}

export interface PlanTransferResponse {
  ok: boolean
  plan?: TransferPlan
  error?: PlainError
}

export interface StartTransferRequest {
  planId: string
  /** 目标已存在时怎么办；默认 fail（保守） */
  onConflict?: 'fail' | 'skip' | 'overwrite' | 'rename'
}

export interface StartTransferResponse {
  ok: boolean
  snapshot?: QueueSnapshot
  error?: PlainError
}

export interface ListDirRequest {
  side: 'local' | 'remote'
  /** 省略时：远端用 home，本地用用户目录 */
  path?: string
  /** 跳过缓存强制重读。刷新按钮用，保证用户看到的是"现在真实的样子" */
  noCache?: boolean
  profileId?: string
}

export interface ListDirResponse {
  ok: boolean
  listing?: DirListing
  error?: PlainError
}

export interface PrepareDragResponse {
  ok: boolean
  /** 本地镜像路径，直接喂给 startDrag */
  localPath?: string
  /** true 表示命中缓存，没有下载 */
  cached?: boolean
  bytes?: number
  error?: PlainError
}

export interface DeleteRequest {
  side: 'local' | 'remote'
  /** 要删的完整路径，支持多选批量 */
  paths: string[]
  /**
   * 仅本地有效：绕过回收站直接永久删除。
   * 只在前一次回收站失败、且用户二次确认后才会传 true。
   */
  permanent?: boolean
  profileId?: string
}

export interface DeleteResponse {
  /** 全部成功才是 true；部分失败要看 failed 明细 */
  ok: boolean
  deleted: string[]
  failed: Array<{ path: string; error: PlainError }>
  /** 全部失败时的第一条错误，方便界面直接显示 */
  error?: PlainError
}

export interface RenameRequest {
  side: 'local' | 'remote'
  path: string
  /** 新名字，不是完整路径——只改这一层 */
  newName: string
  profileId?: string
}

export interface RenameResponse {
  ok: boolean
  newPath?: string
  error?: PlainError
}

export interface MkdirRequest {
  side: 'local' | 'remote'
  /** 在哪个目录下新建 */
  parent: string
  name: string
  profileId?: string
}

export interface MkdirResponse {
  ok: boolean
  newPath?: string
  error?: PlainError
}

/** 移动/剪切：把一批路径搬进某个目录（保留原名） */
export interface MoveRequest {
  side: 'local' | 'remote'
  paths: string[]
  /** 目标目录（不是完整目标路径） */
  targetDir: string
  profileId?: string
}

export interface MoveResponse {
  ok: boolean
  /** 成功移动后的新路径 */
  moved: string[]
  /** 逐条失败的原因。批量操作必须能说清"哪几个没成、为什么" */
  failed: Array<{ path: string; error: PlainError }>
  error?: PlainError
}

/** 作业号：只允许数字。数组作业的 `123_4` 形式不支持，日志定位只针对主作业 */
const JOB_ID_PATTERN = /^\d+$/

/** 读日志用：只取最后 200 行，训练日志动辄几 MB，全读回来既慢又没用 */
const LOG_TAIL_LINES = 200

export function toPlainError(err: unknown): PlainError {
  if (err instanceof ConfigError) {
    return {
      kind: 'config',
      message: err.message,
      hint: '修好配置文件后重新连接，不需要重启应用。',
      raw: [err.path, ...err.issues].join('\n'),
      issues: err.issues
    }
  }
  if (err instanceof SshError) {
    return { kind: err.kind, message: err.message, hint: err.hint, raw: err.raw, code: err.code }
  }
  const normalized = normalizeSshError(err)
  return {
    kind: normalized.kind,
    message: normalized.message,
    hint: normalized.hint,
    raw: normalized.raw,
    code: normalized.code
  }
}

export function registerIpcHandlers(deps: IpcDeps): void {
  /** 正在跟随的日志，key 是 streamId */
  const logStreams = new Map<string, LogStreamState>()

  /**
   * 关窗策略（托盘驻留）。
   *
   * 传了合法 mode 就写，没传就只读。写入由 `index.ts` 负责持久化 + 刷新托盘菜单——
   * 这里只做转发，因为它拿不到 Tray 和窗口。
   */
  ipcMain.handle(
    'app:residency',
    (_event, mode?: string): { ok: boolean; mode: 'quit' | 'when-busy' | 'always' } => {
      if (mode === 'quit' || mode === 'when-busy' || mode === 'always') {
        deps.setResidency?.(mode)
      }
      return { ok: true, mode: deps.getResidency?.() ?? 'quit' }
    }
  )

  /** 当前有没有"关掉会心疼"的活（给设置页显示"现在关窗会被拦下"用） */
  ipcMain.handle('app:activity', (): { ok: boolean; active: boolean } => ({
    ok: true,
    active: deps.hasActiveWork?.() ?? false
  }))

  ipcMain.handle('app:info', (): AppInfo => {
    const configPath = deps.configPath()
    return {
      name: 'HPC 工作台',
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      versions: {
        electron: process.versions.electron ?? '—',
        node: process.versions.node,
        chrome: process.versions.chrome ?? '—'
      },
      configPath,
      configExists: existsSync(configPath)
    }
  })

  /**
   * 在资源管理器里打开目录。
   *
   * 打包之后默认配置在 `%APPDATA%/HPC Workbench/config`，这条路径没人背得下来，
   * 而"未配置"横幅只能把路径**以文本形式**写出来（还要用户复制粘贴到地址栏）。
   * 给一个按钮直接跳过去，比任何文案都直接——这是"装完就能配"的第一步。
   *
   * `which` 只允许两个值，**不接受任意路径**：渲染层能传过来的路径不该直接交给
   * `shell.openPath`，那是把"打开任意位置"的能力暴露给了一个可能被 XSS 影响的层。
   * `appRoot` 是给便携模式用的——用户要往程序目录里放 `config/`，得先能找到它。
   */
  ipcMain.handle(
    'app:open-config-dir',
    async (_event, which?: 'current' | 'appRoot' | 'profileFile'): Promise<{ ok: boolean; path: string; error?: string }> => {
      const info = deps.configInfo()
      const dir = which === 'appRoot' ? info.appRoot : info.dir
      /*
       * `profileFile` 直接交给系统默认程序打开 `profiles.json`。
       * 改一个端口不该逼用户先找目录、再找文件——这一条就是从"改 2223"的
       * 真实需求里长出来的。
       */
      const target = which === 'profileFile' ? deps.configPath() : dir
      if (which !== 'profileFile') {
        try {
          mkdirSync(dir, { recursive: true })
        } catch {
          // 建不出来就交给 openPath 去报，它的错误信息更具体
        }
      }
      const failure = await shell.openPath(target)
      return failure ? { ok: false, path: target, error: failure } : { ok: true, path: target }
    }
  )

  /**
   * 取一台主机的**可编辑字段**（给编辑表单用）。
   *
   * 为什么不复用 `connection:list-profiles`：那个接口刻意**不带 auth**
   * （`ProfileSummary` 的约定是"私钥路径不出主进程"）。编辑表单必须看到路径才能改，
   * 所以单开一个接口，并用注释把边界写清楚：**路径**可以出，**私钥内容**永远不出。
   */
  ipcMain.handle(
    'profile:detail',
    (
      _event,
      id: string
    ): {
      ok: boolean
      profile?: {
        id: string
        label: string
        host: string
        port: number
        username: string
        auth: { method: 'key' | 'password'; privateKeyPath?: string }
        hasPassword: boolean
      }
      error?: PlainError
    } => {
      try {
        const loaded = loadProfiles(deps.configPath())
        const found = loaded.profiles.find((item) => item.id === id)
        if (!found) {
          return {
            ok: false,
            error: {
              kind: 'config',
              message: `找不到 id 为 ${id} 的主机`,
              hint: '刷新一下再试。',
              raw: id
            }
          }
        }
        return {
          ok: true,
          profile: {
            id: found.id,
            label: found.label,
            host: found.host,
            port: found.port,
            username: found.username,
            auth: {
              method: found.auth.method,
              privateKeyPath: found.auth.method === 'key' ? found.auth.privateKeyPath : undefined
            },
            hasPassword:
              found.auth.method === 'password'
                ? deps.credentials.has('ssh-password', found.id)
                : false
          }
        }
      } catch (err) {
        return { ok: false, error: toPlainError(err) }
      }
    }
  )

  /**
   * 改一台已有的跳板机。
   *
   * 三个要点：
   * 1. **id 不可改**（纯函数里强制），它是连接池的键；
   * 2. **原子写**：先写同目录临时文件再 `rename`，写一半断电不会毁掉整份配置；
   * 3. 改完 `pool.invalidate(id)`，否则旧会话还在用旧端口，用户以为改了却没生效。
   */
  ipcMain.handle(
    'profile:update',
    (
      _event,
      patch: ProfilePatch & { password?: string }
    ): { ok: boolean; changed?: boolean; previous?: unknown; error?: PlainError } => {
      try {
        const configPath = deps.configPath()
        let current: string
        try {
          current = readFileSync(configPath, 'utf8')
        } catch (err) {
          return {
            ok: false,
            error: {
              kind: 'config',
              message: '读不到配置文件',
              hint: '用「设置 → 配置目录 → 编辑配置文件」看一眼它还在不在。',
              raw: err instanceof Error ? err.message : String(err)
            }
          }
        }

        const result = patchProfile(current, patch, configPath)

        if (result.changed) {
          // 原子写：同目录临时文件 + rename（跨盘 rename 会失败，所以必须同目录）
          const tmp = join(dirname(configPath), `.profiles.${Date.now().toString(36)}.tmp`)
          writeFileSync(tmp, result.text, 'utf8')
          renameSync(tmp, configPath)
        }

        // 只有用户重填了密码才动钥匙串；没填就保持原样
        if (patch.auth.method === 'password' && patch.password) {
          deps.credentials.set('ssh-password', patch.id, patch.password)
        }

        // 参数可能变了：把这条连接扔掉，下次用新配置重建
        deps.pool.invalidate(patch.id)

        return { ok: true, changed: result.changed, previous: result.previous }
      } catch (err) {
        return { ok: false, error: toPlainError(err) }
      }
    }
  )

  /**
   * 导出诊断包。
   *
   * 采集全部在主进程完成（渲染层没有 fs），脱敏在 `shared/diagnostic.ts`，
   * 打包在 `diagnostics/bundle.ts`。这里只负责：选保存位置 → 收集数据源 → 返回结果。
   *
   * **任何一项采集失败都不影响整包**，失败信息写进包里的 manifest。
   */
  ipcMain.handle(
    'diag:export-bundle',
    async (
      event,
      request?: { includeProbe?: boolean }
    ): Promise<{
      ok: boolean
      path?: string
      bytes?: number
      files?: string[]
      truncated?: boolean
      failed?: Array<{ name: string; error: string }>
      error?: PlainError
    }> => {
      try {
        const window = BrowserWindow.fromWebContents(event.sender)
        const stamp = new Date()
          .toISOString()
          .replace(/[-:T]/g, '')
          .slice(0, 14)
        const defaultPath = join(app.getPath('downloads'), `hpc-diagnose-${stamp}.tar.gz`)
        const picked = window
          ? await dialog.showSaveDialog(window, {
              title: '保存诊断包',
              defaultPath,
              filters: [{ name: '诊断包', extensions: ['tar.gz', 'tgz'] }]
            })
          : await dialog.showSaveDialog({
              title: '保存诊断包',
              defaultPath,
              filters: [{ name: '诊断包', extensions: ['tar.gz', 'tgz'] }]
            })

        if (picked.canceled || !picked.filePath) return { ok: false }

        const info = deps.configInfo()
        const dir = info.dir

        const readMaybe = (path: string): string | null => {
          try {
            return readFileSync(path, 'utf8')
          } catch {
            return null
          }
        }

        const result = await buildDiagnosticsBundle(
          {
            appInfo: {
              name: 'HPC 工作台',
              version: app.getVersion(),
              platform: process.platform,
              arch: process.arch,
              versions: {
                electron: process.versions.electron ?? '—',
                node: process.versions.node,
                chrome: process.versions.chrome ?? '—'
              },
              configDir: dir,
              configDirSource: info.source,
              configExists: existsSync(deps.configPath())
            },
            configDir: info,
            profilesRaw: readMaybe(deps.configPath()),
            knownHostsRaw: readMaybe(join(dir, 'known_hosts.json')),
            trace: deps.trace,
            // 勾了才跑：导出这个动作本身不该再连一次集群
            probe: request?.includeProbe
              ? async () => {
                  const loaded = loadProfiles(deps.configPath())
                  const profile = deps.profileState.current(loaded, undefined)
                  try {
                    const capabilities = await deps.pool.run(profile, (session) =>
                      probeCapabilities(session, profile)
                    )
                    return { ok: true, profile: profile.id, capabilities }
                  } catch (err) {
                    return { ok: false, profile: profile.id, error: toPlainError(err) }
                  }
                }
              : null
          },
          { target: picked.filePath, includeProbe: Boolean(request?.includeProbe) }
        )

        return {
          ok: true,
          path: result.path,
          bytes: result.bytes,
          files: result.files,
          truncated: result.truncated,
          failed: result.failed
        }
      } catch (err) {
        return { ok: false, error: toPlainError(err) }
      }
    }
  )

  /** 在文件管理器里定位到某个文件（诊断包导出后"打开所在文件夹"） */
  ipcMain.handle('diag:reveal', (_event, target: string): { ok: boolean } => {
    try {
      shell.showItemInFolder(target)
      return { ok: true }
    } catch {
      return { ok: false }
    }
  })

  /**
   * 重新走一遍配置向导。
   *
   * 做法是**把现有 `profiles.json` 改名备份再重启**，而不是提供一个"编辑表单"：
   * 向导已经把校验规则、字段说明、SSH 导入全串好了，再写一套编辑界面等于
   * 两份规则两个真相。备份保证了"点错了也不丢"。
   *
   * `credentials.json` **不删**——密码和主机是分开存的，重配主机通常还想用同一个密码。
   */
  ipcMain.handle('app:reset-config', (): { ok: boolean; error?: string; backup?: string } => {
    const configPath = deps.configPath()
    if (!existsSync(configPath)) return { ok: true }

    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const backup = `${configPath}.bak-${stamp}`
    try {
      renameSync(configPath, backup)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    setTimeout(() => {
      app.releaseSingleInstanceLock()
      app.relaunch()
      app.exit(0)
    }, 400)
    return { ok: true, backup }
  })

  /** 配置目录现状：路径 + 来源 + 三个候选位置 */
  ipcMain.handle('app:config-dir', (): ConfigDirInfo => deps.configInfo())

  /**
   * 专门给"选配置目录"用的选择框。
   *
   * 不复用 `fs:pick-directory`：那个的标题和按钮文案是"下载到哪个目录"，
   * 拿来选配置目录会让人以为选错了东西。文案是功能的一部分。
   */
  ipcMain.handle('app:pick-config-dir', async (event): Promise<{ ok: boolean; path?: string }> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: '选择配置目录',
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
      buttonLabel: '用这个目录'
    }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return { ok: false }
    return { ok: true, path: result.filePaths[0] }
  })

  /**
   * 换配置目录。
   *
   * **主进程负责校验可写性**，不合格直接拒绝——放它过去的话，用户会在下次启动时
   * 得到"配置读不出来"，而真正的原因（没权限）已经不在屏幕上了。
   *
   * 通过后写指针文件并**自动重启**：运行中换目录会让已知服务一半写旧、一半读新。
   */
  ipcMain.handle(
    'app:set-config-dir',
    async (_event, request: { mode: 'auto' | 'custom' | 'portable'; dir?: string }): Promise<{
      ok: boolean
      error?: string
    }> => {
      const info = deps.configInfo()
      if (info.readonly) {
        return { ok: false, error: '当前目录由环境变量 HPC_WORKBENCH_CONFIG_DIR 指定，改了不会生效' }
      }

      const mode = request?.mode
      if (mode === 'custom') {
        const dir = request.dir?.trim()
        if (!dir) return { ok: false, error: '请先选一个目录' }
        const target = { mode: 'custom' as const, dir }
        if (!canCreateAt(dir) && !isDirWritable(dir)) {
          return { ok: false, error: `这个目录写不进去：${dir}` }
        }
        return deps.setConfigLocation(target)
      }

      if (mode === 'portable') {
        if (!canCreateAt(info.portableDir) && !isDirWritable(info.portableDir)) {
          return {
            ok: false,
            error: `程序目录写不进去：${info.appRoot}。装到 Program Files 时会这样，改装到用户目录或选别的目录。`
          }
        }
        return deps.setConfigLocation({ mode: 'portable' })
      }

      return deps.setConfigLocation({ mode: 'auto' })
    }
  )

  /**
   * 首次向导：把填表结果写成配置文件并存入凭据。
   *
   * 主进程负责最后一道校验（`validateProfiles` 走同一套规则），
   * 所以渲染层的即时提示只是**体验**，不是安全边界。
   */
  ipcMain.handle(
    'app:setup-apply',
    (
      _event,
      request: { draft: SetupDraft; extras?: SetupDraft[]; mode: 'auto' | 'custom' | 'portable'; dir?: string }
    ): ApplySetupResult & { restartRequired: boolean } => deps.applyInitialSetup(request)
  )

  /**
   * 重启应用。
   *
   * 向导在"配置目录变了"时需要它——新进程会重新解析目录。
   * 顺序与 `setConfigLocation` 里一致：**先松单实例锁，再重启**，
   * 否则新进程拿不到锁会走 `app.quit()`，用户看到的是"应用没了"。
   */
  ipcMain.handle('app:relaunch', (): { ok: boolean } => {
    setTimeout(() => {
      app.releaseSingleInstanceLock()
      app.relaunch()
      app.exit(0)
    }, 150)
    return { ok: true }
  })

  /**
   * 读 `~/.ssh/config`（或用户指定的文件/目录）并解析成可填入向导的主机列表。
   *
   * 只读，不写任何东西。`target` 为空时用 `~/.ssh`。
   */
  ipcMain.handle('app:ssh-config', (_event, target?: string): SshImportResult => readSshConfig(target))

  /**
   * 选 SSH 配置文件。
   *
   * 同时允许选目录和文件：`config` 不存在时（用户把主机写在别处）
   * 只给"选文件"是选不了的，而只给"选目录"又没法指到某个具体文件。
   */
  ipcMain.handle('app:pick-ssh-config', async (event): Promise<{ ok: boolean; path?: string }> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: '选择 SSH 配置',
      defaultPath: defaultSshDir(),
      properties: ['openFile', 'openDirectory'] as Array<'openFile' | 'openDirectory'>,
      buttonLabel: '读取这里'
    }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return { ok: false }
    return { ok: true, path: result.filePaths[0] }
  })

  /**
   * 反向隧道的默认端口。
   *
   * 存成"用户偏好"而不是写死在界面上：21056 必须和集群 `~/.profile` 的
   * `http_proxy` 一致，7897 是本机 Clash 的端口——这两件事每个环境都不同，
   * 写死等于让用户每次开隧道都手动改一遍。
   */
  ipcMain.handle('app:tunnel-defaults', (): TunnelDefaults => ({
    remotePort: deps.cache.get<number>(TUNNEL_REMOTE_KEY) ?? TUNNEL_DEFAULTS.remotePort,
    localPort: deps.cache.get<number>(TUNNEL_LOCAL_KEY) ?? TUNNEL_DEFAULTS.localPort
  }))

  /**
   * 保存隧道默认端口。
   *
   * **校验放在这里**：界面上只做了即时提示，真正决定能不能存的是主进程。
   * 一个 70000 存进去，下次开隧道时才在 `listen()` 处失败，而那条报错
   * 离"端口填错了"很远。
   */
  ipcMain.handle(
    'app:set-tunnel-defaults',
    (_event, request: TunnelDefaults): { ok: boolean; error?: string; saved?: TunnelDefaults } => {
      const check = validateTunnelPorts({
        remotePort: String(request?.remotePort ?? ''),
        localPort: String(request?.localPort ?? '')
      })
      const firstError = Object.values(check.errors)[0]
      if (firstError) return { ok: false, error: firstError }

      const saved: TunnelDefaults = {
        remotePort: Number(request.remotePort),
        localPort: Number(request.localPort)
      }
      deps.cache.set(TUNNEL_REMOTE_KEY, saved.remotePort)
      deps.cache.set(TUNNEL_LOCAL_KEY, saved.localPort)
      return { ok: true, saved }
    }
  )

  /**
   * 测一台跳板机的连接耗时（四段拆分）。
   *
   * ## 两条自律
   *
   * 1. **不轮询**。每次探测都是一次真实的 SSH 登录，会在集群上留 auth 记录，
   *    频率高了要么被管理员找，要么触发 `MaxStartups`。所以只手动触发。
   * 2. **同一时刻只测一台**。并发建连只会让两台互相拖慢，测出来都不准。
   *
   * 结果缓存 5 分钟：面板开开关关不该每次都重新登录一遍。
   */
  ipcMain.handle(
    'profile:latency',
    async (
      _event,
      request?: { profileId?: string; force?: boolean }
    ): Promise<{ ok: boolean; latency?: ProfileLatency; cached?: boolean; error?: PlainError }> => {
      try {
        const loaded = loadProfiles(deps.configPath())
        const profile = deps.profileState.current(loaded, request?.profileId)

        if (!request?.force) {
          const cached = latencyCache.get(profile.id)
          if (cached && Date.now() - cached.at < LATENCY_TTL_MS) {
            return { ok: true, latency: cached, cached: true }
          }
        }

        if (latencyInFlight) {
          if (latencyInFlightId !== profile.id) {
            return {
              ok: false,
              error: {
                kind: 'busy',
                message: '正在测另一台跳板机',
                hint: '同时测两台会互相拖慢，等它测完再点这台。',
                raw: latencyInFlightId ?? ''
              }
            }
          }
          return { ok: true, latency: await latencyInFlight, cached: false }
        }

        latencyInFlightId = profile.id
        latencyInFlight = (async (): Promise<ProfileLatency> => {
          const probe = await probeLatency(profile, { knownHosts: deps.knownHosts })
          const judged = judgeLatency(probe)
          return { ...probe, profileId: profile.id, at: Date.now(), ...judged }
        })()

        try {
          const latency = await latencyInFlight
          latencyCache.set(profile.id, latency)
          return { ok: true, latency, cached: false }
        } finally {
          latencyInFlight = null
          latencyInFlightId = null
        }
      } catch (err) {
        return { ok: false, error: toPlainError(err) }
      }
    }
  )

  /**
   * 启动页的三步状态。
   *
   * 冷启动时窗口已经 `show:false` 等着，那 1–3 秒原本是纯空白。
   * 这个方法把这段时间变成三段有结论的检查：
   *
   * 1. `config` —— 配置文件在不在（本地 `existsSync`，1 ms）
   * 2. `connect` —— 能不能连上、以谁的身份（一条 `echo`，复用连接池）
   * 3. `queue`   —— 队列读不读得到（一条 `squeue --json`，顺带把数字给主界面）
   *
   * **失败就停在那一步**，不继续执行后面的：连不上还去查队列只会多一条
   * 无关的报错，反而盖住真正的原因。每一步都带上 hint，让人知道下一步干什么。
   *
   * 刻意不复用 `probe()`：探针要跑 9 条命令、2–4 秒，那是"深入体检"。
   * 启动页如果自己成为瓶颈，就失去了意义。
   */
  ipcMain.handle('app:boot-status', async (_event, request?: { profileId?: string }): Promise<BootStatus> => {
    const startedAt = Date.now()
    const steps: BootStatus['steps'] = []
    const rawParts: string[] = []

    // —— 第 1 步：配置文件 ——
    const configStart = Date.now()
    const configPath = deps.configPath()
    if (!existsSync(configPath)) {
      steps.push({
        phase: 'config',
        ok: false,
        message: '找不到配置文件',
        hint: `把 profiles.example.json 复制成 ${configPath}，填上主机、用户名和认证方式`,
        ms: Date.now() - configStart
      })
      return { ok: false, steps, totalMs: Date.now() - startedAt }
    }
    steps.push({
      phase: 'config',
      ok: true,
      message: '配置文件已找到',
      ms: Date.now() - configStart
    })

    /*
     * —— 第 2、3 步共用一次连接 ——
     *
     * ⚠️ `connectStart` **必须**在 `loadProfiles` 之前取。
     *
     * 读配置 + 解析凭据（含一次同步的 DPAPI 解密）也属于"启动要等的时间"，
     * 但它以前发生在 `connectStart` 之前、不计入任何一步——于是启动页上
     * 三步的 ms 都不大，用户却实实在在地多等了一截，而且**没有任何线索**
     * 说明时间去哪了。这类"看不见的耗时"是最难查的一种。
     */
    const connectStart = Date.now()
    let loaded: ReturnType<typeof loadProfiles>
    let profile: ReturnType<typeof pickProfile>
    try {
      loaded = loadProfiles(configPath)
      profile = deps.profileState.current(loaded, request?.profileId)
    } catch (err) {
      steps.push({
        phase: 'connect',
        ok: false,
        message: '配置文件读不出来',
        hint: err instanceof Error ? err.message : String(err),
        ms: Date.now() - connectStart
      })
      return { ok: false, steps, totalMs: Date.now() - startedAt, raw: rawParts.join('\n\n') }
    }
    const prepareMs = Date.now() - connectStart

    try {
      const who = await deps.pool.run(profile, async (session) => {
        const result = await session.exec('echo "$USER@$(hostname -s)"')
        return result
      })

      if (who.code !== 0) {
        rawParts.push(`$ echo "$USER@$(hostname -s)"\nexit=${String(who.code)}\n${who.stderr}`)
        steps.push({
          phase: 'connect',
          ok: false,
          message: '能连上，但登录后取不到身份信息',
          hint: '看下面的原始输出；也可以在诊断页跑一次完整探测',
          ms: Date.now() - connectStart
        })
        return { ok: false, steps, totalMs: Date.now() - startedAt, raw: rawParts.join('\n\n') }
      }

      const target = who.stdout.trim().split('\n').pop()?.trim() || profile.label
      steps.push({
        phase: 'connect',
        ok: true,
        message: `已连接 ${target}`,
        /*
         * 解析耗时一般只有几毫秒，不值得刷在界面上。但一旦超过 100 ms
         * 就说明配置读取或凭据解密出了问题（大配置文件、系统钥匙串慢），
         * 这时把数字露出来，用户下次报"启动慢"就有据可查。
         */
        hint: prepareMs > 100 ? `其中读取配置与凭据 ${prepareMs}ms` : undefined,
        ms: Date.now() - connectStart
      })

      // —— 第 3 步：队列 ——
      const queueStart = Date.now()
      // 到这里 connect 步就结束了，先把数字定下来，后面日志才有意义
      const connectMs = queueStart - connectStart
      try {
        const listResult = await deps.pool.run(profile, (session) => session.exec(SQUEUE_COMMAND))
        const parsed = parseSqueue(listResult.stdout)
        if (!parsed.ok) {
          rawParts.push(`$ ${SQUEUE_COMMAND}\nexit=${String(listResult.code)}\n${parsed.reason}\n${listResult.stderr}`)
          steps.push({
            phase: 'queue',
            ok: false,
            message: '连上了，但队列读不出来',
            hint: parsed.reason,
            ms: Date.now() - queueStart
          })
          return {
            ok: false,
            steps,
            target,
            totalMs: Date.now() - startedAt,
            raw: rawParts.join('\n\n')
          }
        }

        const jobs = parsed.data
        const running = jobs.filter((job) => job.state === 'running').length
        const pending = jobs.filter((job) => job.state === 'pending').length
        steps.push({
          phase: 'queue',
          ok: true,
          message: jobs.length === 0 ? '队列里没有作业' : `${jobs.length} 个作业（${running} 跑 / ${pending} 排）`,
          ms: Date.now() - queueStart
        })

        /*
         * 开发模式下把耗时拆开打印一次。
         *
         * 启动页只看得到三步的 ms，而"读配置 + 解析凭据"这一段以前根本没被计时
         * ——于是出现"三步数字都不大、但就是等了很久"这种查不动的现象。
         * 这行日志就是为了下次再有人说启动慢时，能一眼看出时间去哪了：
         * 本地解析通常个位数毫秒，网络（connect/queue）是几百毫秒量级。
         *
         * 用 `app.isPackaged` 而不是环境变量：打包后自动静默，不用额外配置。
         *
         * **日志保持纯 ASCII**：Windows 控制台默认是 GBK，中文会打成
         * `閰嶇疆` 那种乱码，让人根本没法贴出来。
         */
        if (!app.isPackaged) {
          console.log(
            `[boot] prepare ${prepareMs}ms | connect ${connectMs - prepareMs}ms | ` +
              `queue ${Date.now() - queueStart}ms | total ${Date.now() - startedAt}ms`
          )
        }

        return {
          ok: true,
          steps,
          target,
          queue: { total: jobs.length, running, pending },
          totalMs: Date.now() - startedAt
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        rawParts.push(`$ ${SQUEUE_COMMAND}\n${message}`)
        steps.push({
          phase: 'queue',
          ok: false,
          message: '连上了，但查队列时断了',
          hint: message,
          ms: Date.now() - queueStart
        })
        return { ok: false, steps, target, totalMs: Date.now() - startedAt, raw: rawParts.join('\n\n') }
      }
    } catch (err) {
      // 连接层失败：SshError 带 code；其它异常兜底
      const message = err instanceof Error ? err.message : String(err)
      rawParts.push(`connect ${profile.host}:${String(profile.port)}\n${message}`)
      steps.push({
        phase: 'connect',
        ok: false,
        message,
        hint: '检查跳板机是否可达、私钥是否有效，或者去诊断页跑一次完整探测',
        ms: Date.now() - connectStart
      })
      return { ok: false, steps, totalMs: Date.now() - startedAt, raw: rawParts.join('\n\n') }
    }
  })

  /**
   * 命令记录：界面上的「命令台」读这些。
   *
   * 只读三个方法——**没有任何"通过它执行命令"的入口**，这不是一个伪装成终端的后门。
   * 真实的命令只能由各页面自己的业务方法发出，这里只负责把已经发生的摊开给人看。
   */
  ipcMain.handle('trace:list', (): { ok: true; entries: TraceEntry[] } => ({
    ok: true,
    entries: deps.trace.list()
  }))

  ipcMain.handle(
    'trace:detail',
    (_event, id: number): { ok: true; record: TraceRecord } | { ok: false; error: PlainError } => {
      const record = deps.trace.detail(Number(id))
      if (!record) {
        return {
          ok: false,
          error: {
            kind: 'trace',
            message: '这条记录已经不在了',
            hint: `命令记录只留最近 ${TRACE_LIMIT} 条，更早的已经被顶掉。`,
            raw: `id=${String(id)}`
          }
        }
      }
      return { ok: true, record }
    }
  )

  ipcMain.handle('trace:clear', (): { ok: true } => {
    deps.trace.clear()
    return { ok: true }
  })

  /**
   * 开一个交互式终端（登录节点上的 PTY）。
   *
   * 计算节点大多禁了直连 SSH（docs/04 §3.1 P3），所以终端开在登录节点上——
   * 这也正是 `module load` / `conda activate` / `salloc` 该用的地方。
   */
  ipcMain.handle(
    'terminal:open',
    async (event, request: { cols?: number; rows?: number; profileId?: string } | undefined): Promise<TerminalOpenResponse> => {
      try {
        const cols = Math.floor(Number(request?.cols ?? 80))
        const rows = Math.floor(Number(request?.rows ?? 24))

        const loaded = loadProfiles(deps.configPath())
        const profile = deps.profileState.current(loaded, request?.profileId)

        return await deps.pool.run(profile, async (session) => {
          const sessionId = await deps.terminals.open(session, event.sender.id, {
            cols: Number.isFinite(cols) ? cols : 80,
            rows: Number.isFinite(rows) ? rows : 24
          })
          // 窗口关掉/刷新时把远端 shell 收掉，别在集群上留一堆僵尸进程
          event.sender.once('destroyed', () => deps.terminals.closeForOwner(event.sender.id))
          return { ok: true, sessionId }
        })
      } catch (err) {
        return { ok: false, error: toPlainError(err) }
      }
    }
  )

  /**
   * 键盘输入。用 `send` 而不是 `invoke`：输入要的是延迟，不需要回执。
   * 每个按键都走一次 invoke 的往返，快速打字时会明显发涩。
   */
  ipcMain.on('terminal:write', (_event, payload: { sessionId?: string; data?: string }) => {
    const sessionId = String(payload?.sessionId ?? '')
    if (sessionId.length === 0) return
    deps.terminals.write(sessionId, String(payload?.data ?? ''))
  })

  ipcMain.on('terminal:resize', (_event, payload: { sessionId?: string; cols?: number; rows?: number }) => {
    const sessionId = String(payload?.sessionId ?? '')
    if (sessionId.length === 0) return
    const cols = Math.floor(Number(payload?.cols ?? 0))
    const rows = Math.floor(Number(payload?.rows ?? 0))
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 20 || rows < 5) return
    deps.terminals.resize(sessionId, { cols, rows })
  })

  ipcMain.handle('terminal:close', (_event, sessionId: string): { ok: boolean } => {
    return { ok: deps.terminals.close(String(sessionId ?? '')) }
  })

  /**
   * 开一条端口转发。
   *
   * 目标必须是一个已经在跑的服务（计算节点上的 Jupyter / TensorBoard）。
   * 这里不验证远端端口通不通——开隧道只需要本地能监听，
   * 远端通不通要等第一个连接进来才知道。
   */
  ipcMain.handle(
    'forward:start',
    async (
      _event,
      request: (TunnelRequest & { profileId?: string }) | undefined
    ): Promise<TunnelStartResponse> => {
      try {
        const remoteHost = String(request?.remoteHost ?? '').trim()
        const remotePort = Number(request?.remotePort ?? 0)

        // 主机名会进 SSH 的 direct-tcpip 请求，只允许常规字符：别让它变成任意主机探测
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(remoteHost)) {
          throw new SshError({
            kind: 'config',
            message: `目标主机不合法：${remoteHost || '（空）'}`,
            hint: '填计算节点名（如 gpu10）或 127.0.0.1（登录节点自己）。',
            raw: String(request?.remoteHost)
          })
        }
        if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
          throw new SshError({
            kind: 'config',
            message: `目标端口不合法：${request?.remotePort ?? '（空）'}`,
            hint: '端口是 1–65535 的整数。',
            raw: String(request?.remotePort)
          })
        }

        const loaded = loadProfiles(deps.configPath())
        const profile = deps.profileState.current(loaded, request?.profileId)

        return await deps.pool.run(profile, async (session) => {
          const tunnel = await deps.tunnels.open(session, {
            remoteHost,
            remotePort,
            localPort: request?.localPort,
            label: request?.label,
            profileId: profile.id,
            profileLabel: profile.label
          })
          return { ok: true, tunnel }
        })
      } catch (err) {
        return { ok: false, error: toPlainError(err) }
      }
    }
  )

  /**
   * 反向转发（`-R`）：在**集群**上监听，转发回**本机**的服务。
   *
   * 对应手敲的 `ssh -R 127.0.0.1:55555:127.0.0.1:7897 hpc`，
   * 典型用途是让集群上的程序借本机的代理上网。
   *
   * 集群侧只绑 127.0.0.1（写死在 `Session.forwardIn` 里，不给配置项）；
   * 绑定失败会立刻抛，不会"假装成功"——对应原命令的 `ExitOnForwardFailure=yes`。
   */
  ipcMain.handle(
    'forward:start-reverse',
    async (
      _event,
      request: (ReverseTunnelRequest & { profileId?: string }) | undefined
    ): Promise<TunnelStartResponse> => {
      try {
        const remotePort = Number(request?.remotePort ?? 0)
        const localPort = Number(request?.localPort ?? 0)

        if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
          throw new SshError({
            kind: 'config',
            message: `集群侧端口不合法：${request?.remotePort ?? '（空）'}`,
            hint: '端口是 1–65535 的整数。',
            raw: String(request?.remotePort)
          })
        }
        if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
          throw new SshError({
            kind: 'config',
            message: `本机目标端口不合法：${request?.localPort ?? '（空）'}`,
            hint: '端口是 1–65535 的整数。',
            raw: String(request?.localPort)
          })
        }

        const localHost = String(request?.localHost ?? '127.0.0.1').trim()
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(localHost)) {
          throw new SshError({
            kind: 'config',
            message: `本机目标主机不合法：${localHost || '（空）'}`,
            hint: '一般就是 127.0.0.1。',
            raw: localHost
          })
        }

        const loaded = loadProfiles(deps.configPath())
        const profile = deps.profileState.current(loaded, request?.profileId)

        return await deps.pool.run(profile, async (session) => {
          let opened: OpenResult<TunnelInfo>
          try {
            opened = await openWithFallback({
              run: session,
              requested: remotePort,
              selfUsername: profile.username,
              tryOpen: (port) =>
                deps.reverseTunnels.open(session, {
                  remotePort: port,
                  localPort,
                  localHost,
                  // label 里带端口，界面上能一眼看出这条开在哪儿
                  label: request?.label,
                  profileId: profile.id,
                  profileLabel: profile.label
                })
            })
          } catch (err) {
            const plain = toPlainError(err)
            // ssh2 对 tcpip-forward 失败只会给 "Unable to bind to 127.0.0.1:55555"，
            // 协议里不带原因（docs/04 E25）。所以趁连接还在，**真去查一次**是谁占着。
            //
            // 走到这里说明"换端口也不行"（附近都满了），或者不是绑定问题。
            // 不要 throw：'channel' 类错误被标成 retryable，抛出去会让 pool 重连再试一遍，
            // 白等两个来回还是同一个结果。
            if (!/unable to bind/i.test(`${plain.message}\n${plain.raw}`)) throw err

            const owner = await lookupPortOwner(session, remotePort)
            return {
              ok: false,
              error: {
                ...plain,
                // 端口号放在 hint 里说，message 只给结论：
                // 界面上是「message · hint」拼起来显示的，两边都带端口会读成结巴
                message: '集群侧端口绑不上',
                hint: portBusyHint(remotePort, owner)
              }
            }
          }

          // 顺带读一眼集群上 http_proxy 指向哪里：两边对不上时界面要提醒。
          // 这一步失败不影响隧道本身（readProxyPort 内部吞异常，返回 null）。
          const proxyPort = await readProxyPort(session)
          return { ok: true, tunnel: opened.tunnel, fallback: opened.fallback, proxyPort }
        })
      } catch (err) {
        return { ok: false, error: toPlainError(err) }
      }
    }
  )

  ipcMain.handle('forward:stop', (_event, id: string): { ok: boolean } => {
    const tunnelId = String(id ?? '')
    // 两个管理器各自的 id 前缀分得开，不用额外记一张表
    const closed = tunnelId.startsWith('rev-')
      ? deps.reverseTunnels.close(tunnelId)
      : deps.tunnels.close(tunnelId)
    return { ok: closed }
  })

  ipcMain.handle('forward:list', (): TunnelListResponse => ({
    ok: true,
    tunnels: [...deps.tunnels.list(), ...deps.reverseTunnels.list()]
  }))

  /**
   * 集群上登录 shell 默认把代理指向哪个端口（读 `~/.profile` 的 `http_proxy`）。
   *
   * 反向隧道的监听端口必须和它一致，否则隧道开着也没人用。界面在选"集群 → 本机"
   * 方向时先问一下，不一致就当场提醒，而不是等用户困惑"为什么 codex 还是连不上"。
   */
  ipcMain.handle(
    'forward:proxy-port',
    async (
      _event,
      request?: { profileId?: string }
    ): Promise<{ ok: boolean; port?: number | null; error?: PlainError }> => {
      try {
        const loaded = loadProfiles(deps.configPath())
        const profile = deps.profileState.current(loaded, request?.profileId)
        return await deps.pool.run(profile, async (session) => ({
          ok: true,
          port: await readProxyPort(session)
        }))
      } catch (err) {
        return { ok: false, error: toPlainError(err) }
      }
    }
  )

  /**
   * 验证一条反向隧道是不是**真的**能用。
   *
   * 「端口绑上了」只说明第一关过了。真正要回答的是：从现在这个端口出去，
   * 请求有没有绕回**你这台电脑**。做法是两边各取一次出口 IP 再比对——
   * 这也是唯一能发现"端口上蹲着别人的服务"的手段（比"页面显示已开"可靠得多）。
   */
  ipcMain.handle(
    'forward:verify',
    async (
      _event,
      request?: { port?: number; localPort?: number; profileId?: string; tunnelId?: string }
    ): Promise<TunnelVerifyResponse> => {
      const port = Number(request?.port ?? 0)
      const localPort = Number(request?.localPort ?? 0)

      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return {
          ok: false,
          error: {
            kind: 'config',
            message: `要测的端口不合法：${request?.port ?? '（空）'}`,
            hint: '端口是 1–65535 的整数。',
            raw: String(request?.port)
          }
        }
      }

      try {
        const loaded = loadProfiles(deps.configPath())
        const profile = deps.profileState.current(loaded, request?.profileId)
        const hasLocal = Number.isInteger(localPort) && localPort >= 1 && localPort <= 65535

        /*
         * 探测前后各读一次这条隧道的计数器。
         *
         * 出口 IP 相等是"走的是我"的证据，但**它会被代理的负载均衡打坏**：
         * Clash 用 url-test / load-balance 组时，两次请求可以落到不同上游节点，
         * 出口 IP 天然不同——那不是隧道坏了。而计数器变了是**更硬的证据**：
         * 字节确实穿过了本机上这条隧道。
         */
        const tunnelId = typeof request?.tunnelId === 'string' ? request.tunnelId : ''
        const before = tunnelId ? deps.reverseTunnels.get(tunnelId) : null

        // 两边并行：集群侧要一次 SSH 往返，本机侧要等 Clash 回包，串起来会慢一倍
        const [cluster, local] = await Promise.all([
          deps.pool.run(profile, (session) => clusterEgress(session, port)),
          hasLocal
            ? localProxyEgress(localPort)
            : Promise.resolve<EgressProbe>({ ip: null, error: '没有给出本机代理端口' })
        ])

        const after = tunnelId ? deps.reverseTunnels.get(tunnelId) : null
        const moved =
          before && after
            ? after.connections > before.connections ||
              after.bytesIn > before.bytesIn ||
              after.bytesOut > before.bytesOut
            : null

        const same = cluster.ip !== null && local.ip !== null ? cluster.ip === local.ip : null
        return { ok: true, cluster, local, same, moved }
      } catch (err) {
        return { ok: false, error: toPlainError(err) }
      }
    }
  )

  /**
   * 用系统浏览器打开一个地址。
   *
   * **只允许 http/https 的本地回环地址**：这个能力是给"打开隧道"用的，
   * 放开成任意 URL 等于给渲染层一个可以启动外部程序的口子。
   */
  ipcMain.handle('app:open-local-url', async (_event, rawUrl: string): Promise<{ ok: boolean; reason?: string }> => {
    const url = String(rawUrl ?? '').trim()
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return { ok: false, reason: '不是合法地址' }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, reason: '只允许 http/https' }
    }
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
      return { ok: false, reason: '只允许本地地址' }
    }
    await shell.openExternal(url)
    return { ok: true }
  })

  /**
   * 系统通知（作业跑完/失败）。
   *
   * **窗口在前台时不弹**：用户正看着界面，通知中心里加一条就够了，
   * 再弹一个系统气泡是打扰。判断放在主进程是因为只有这里知道窗口焦点。
   *
   * 这是尽力而为的旁路：失败也不抛，界面不该因为弹不出通知就报错。
   */
  ipcMain.handle(
    'notify:show',
    (event, request: { title: string; body?: string } | undefined): { ok: boolean; skipped?: boolean; reason?: string } => {
      const title = String(request?.title ?? '').trim()
      const body = String(request?.body ?? '').trim()
      if (title.length === 0) return { ok: false, reason: '标题为空' }

      // 截断长度：Windows 通知区放不下长文本，超了会被系统按乱码截
      const safeTitle = title.slice(0, 120)
      const safeBody = body.slice(0, 400)

      const senderWindow = BrowserWindow.fromWebContents(event.sender)
      if (senderWindow && !senderWindow.isDestroyed() && senderWindow.isFocused()) {
        return { ok: true, skipped: true }
      }
      if (!Notification.isSupported()) return { ok: false, reason: '当前系统不支持通知' }

      const notification = new Notification({ title: safeTitle, body: safeBody })
      // 点通知就把窗口拉回来——用户看到"作业失败"第一反应是去看日志
      notification.on('click', () => {
        const target = senderWindow && !senderWindow.isDestroyed() ? senderWindow : BrowserWindow.getAllWindows()[0]
        if (!target) return
        if (target.isMinimized()) target.restore()
        target.show()
        target.focus()
      })
      notification.show()
      return { ok: true }
    }
  )

  ipcMain.handle('fs:list', async (_event, request: ListDirRequest | undefined): Promise<ListDirResponse> => {
    const side = request?.side ?? 'local'

    try {
      if (side === 'local') {
        // 没指定 path 时用用户设置的默认目录
        let startDir = request?.path?.trim() ? request.path : deps.cache.get<string>(LOCAL_START_KEY)

        // 设置的目录可能已经被删了（U 盘拔了、文件夹改名）。
        // 这时候不能报错让用户卡在空白页，清掉设置回退到主目录。
        if (startDir && !existsSync(startDir)) {
          deps.cache.delete(LOCAL_START_KEY)
          startDir = undefined
        }

        return { ok: true, listing: await listLocalDir(startDir) }
      }

      const loaded = loadProfiles(deps.configPath())
      const profile = deps.profileState.current(loaded, request?.profileId)
      const listing = await deps.pool.run(profile, (session) =>
        listRemoteDir(session, request?.path, { noCache: request?.noCache === true })
      )
      return { ok: true, listing }
    } catch (err) {
      return { ok: false, error: toPlainError(err) }
    }
  })

  /**
   * 弹系统目录选择框，返回用户选中的目录。
   *
   * 用途：从集群「下载到…」任意位置，省得在应用里一层层导航过去。
   * 这就是"把文件拖到资源管理器"那个需求的可靠替代——
   * 真正的 `startDrag` 要求文件已经在磁盘上，远端文件得先下载完才能拖，
   * 那个等待期用户是没法接受的（详见 docs/04）。
   */
  ipcMain.handle('fs:pick-directory', async (event): Promise<{ ok: boolean; path?: string }> => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = window
      ? await dialog.showOpenDialog(window, {
          title: '选择下载到哪个目录',
          properties: ['openDirectory', 'createDirectory'],
          buttonLabel: '下载到这里'
        })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })

    if (result.canceled || result.filePaths.length === 0) return { ok: false }
    return { ok: true, path: result.filePaths[0] }
  })

  /**
   * 拖出到资源管理器：第一步，把远端文件镜像到本地临时目录。
   *
   * 为什么要分两步：`startDrag` 只认磁盘上已有的文件，而下载是异步的。
   * 渲染层在 `dragstart` 里先 preventDefault 把默认拖拽拦下来，
   * 等这个调用返回本地路径之后，再发起一次真正的系统拖拽。
   */
  ipcMain.handle(
    'fs:prepare-drag',
    async (event, request: { path: string; profileId?: string }): Promise<PrepareDragResponse> => {
      try {
        const loaded = loadProfiles(deps.configPath())
        const profile = deps.profileState.current(loaded, request.profileId)

        const prepared = await deps.pool.run(profile, (session) =>
          prepareDragFile(session, request.path, {
            onProgress: (bytes, total) => {
              // 大文件第一次拖要等，至少让界面能显示"在下"
              if (!event.sender.isDestroyed()) {
                event.sender.send('fs:drag-progress', { bytes, total })
              }
            }
          })
        )
        return { ok: true, localPath: prepared.localPath, cached: prepared.cached, bytes: prepared.bytes }
      } catch (err) {
        return { ok: false, error: toPlainError(err) }
      }
    }
  )

  /**
   * 拖出到资源管理器：第二步，让系统接管拖拽。
   *
   * 注意时序：`startDrag` 最好在用户鼠标还按着的时候调用。
   * 文件已缓存时这一步是瞬时的，体验和拖本地文件一样；
   * 第一次拖需要等下载，用户往往会松手，那就要再拖一次（见 docs/04 的说明）。
   */
  ipcMain.handle('fs:start-drag', (event, localPath: string): { ok: boolean; error?: PlainError } => {
    try {
      event.sender.startDrag({
        file: localPath,
        icon: nativeImage.createFromBuffer(makeDragIcon(32))
      })
      return { ok: true }
    } catch (err) {
      return {
        ok: false,
        error: {
          kind: 'unknown',
          message: '系统拖拽启动失败',
          hint: '可能是文件已经被删掉了。',
          raw: (err as Error).message
        }
      }
    }
  })

  ipcMain.handle(
    'fs:delete',
    async (_event, request: DeleteRequest): Promise<DeleteResponse> => {
      const deleted: string[] = []
      const failed: Array<{ path: string; error: PlainError }> = []

      try {
        if (request.side === 'local') {
          // 本地默认进回收站；只有用户二次确认后才走永久删除
          const trash: TrashFn = (path) => shell.trashItem(path)
          for (const path of request.paths) {
            try {
              await deleteLocal(path, trash, request.permanent === true)
              deleted.push(path)
            } catch (err) {
              failed.push({ path, error: toPlainError(err) })
            }
          }
        } else {
          const loaded = loadProfiles(deps.configPath())
          const profile = deps.profileState.current(loaded, request.profileId)
          await deps.pool.run(profile, async (session) => {
            // 家目录只取一次，批量删时不必每次往返
            const home = await remoteHome(session)
            for (const path of request.paths) {
              try {
                await deleteRemote(session, path, home)
                deleted.push(path)
                // 缓存必须立刻失效，否则界面上"删完还在"
                invalidateListing(session, path)
              } catch (err) {
                failed.push({ path, error: toPlainError(err) })
              }
            }
          })
        }
      } catch (err) {
        // 连接层失败：整批都算失败
        const error = toPlainError(err)
        return { ok: false, deleted, failed: request.paths.map((path) => ({ path, error })), error }
      }

      return {
        ok: failed.length === 0,
        deleted,
        failed,
        error: deleted.length === 0 ? failed[0]?.error : undefined
      }
    }
  )

  /**
   * 把一批本地路径复制到某个目录。
   *
   * 主要用途：从集群拖文件到本机栏时，文件已经镜像在本地了，
   * 复制过来就等于"下载完成"。顺带也就支持了本机内部拖拽复制。
   */
  ipcMain.handle(
    'fs:copy-local',
    async (
      _event,
      request: { paths: string[]; targetDir: string }
    ): Promise<{ ok: boolean; copied: string[]; failed: Array<{ path: string; error: PlainError }> }> => {
      const copied: string[] = []
      const failed: Array<{ path: string; error: PlainError }> = []

      for (const path of request.paths) {
        try {
          copied.push(await copyLocal(path, request.targetDir))
        } catch (err) {
          failed.push({ path, error: toPlainError(err) })
        }
      }

      return { ok: failed.length === 0, copied, failed }
    }
  )

  /**
   * 拉取「我的作业」队列。
   *
   * 用 `squeue --me --json`：只查自己的，既快又不会看到别人的作业。
   * 队列为空是正常状态（不是错误），返回空数组，界面给引导文案。
   */
  ipcMain.handle(
    'jobs:list',
    async (_event, request: { profileId?: string } | undefined): Promise<JobsListResponse> => {
      const started = Date.now()
      try {
        const loaded = loadProfiles(deps.configPath())
        const profile = deps.profileState.current(loaded, request?.profileId)

        const jobs = await deps.pool.run(profile, async (session) => {
          const result = await session.exec(SQUEUE_COMMAND)

          // 非 0 退出：命令本身有问题（老版本不支持 --json、权限不足等），
          // 不能当成"没有作业"，必须如实报错
          if (result.code !== 0) {
            throw new SshError({
              kind: 'remote',
              message: `squeue 执行失败（退出码 ${result.code ?? 'null'}）`,
              hint: '可能是这个集群的 SLURM 版本不支持 --json。',
              raw: [`$ ${SQUEUE_COMMAND}`, result.stderr.trim() || '（无输出）'].join('\n'),
              code: String(result.code)
            })
          }

          const parsed = parseSqueue(result.stdout)
          if (!parsed.ok) {
            // 解析失败必须带上原文，否则用户没法自救（docs/03 的硬规则）
            throw new SshError({
              kind: 'remote',
              message: `解析作业队列失败：${parsed.reason}`,
              hint: '把下面的原始输出发出来，方便对照字段变化。',
              raw: parsed.raw
            })
          }
          return parsed.data
        })

        return { ok: true, jobs, durationMs: Date.now() - started }
      } catch (err) {
        return { ok: false, error: toPlainError(err) }
      }
    }
  )

  /** 取消作业。jobId 必须是自己查出来的纯数字，防止拼进别的命令 */
  ipcMain.handle(
    'jobs:cancel',
    async (_event, request: { jobId: string; profileId?: string }): Promise<JobCancelResponse> => {
      try {
        const jobId = String(request.jobId ?? '').trim()
        if (!/^\d+$/.test(jobId)) {
          throw new SshError({
            kind: 'config',
            message: `作业号不合法：${jobId || '（空）'}`,
            raw: JSON.stringify(request)
          })
        }

        const loaded = loadProfiles(deps.configPath())
        const profile = deps.profileState.current(loaded, request.profileId)

        await deps.pool.run(profile, async (session) => {
          const result = await session.exec(`scancel ${jobId}`)
          if (result.code !== 0) {
            throw new SshError({
              kind: 'remote',
              message: `取消作业 ${jobId} 失败（退出码 ${result.code ?? 'null'}）`,
              hint: '可能作业已经结束了。刷新一下看看。',
              raw: [`$ scancel ${jobId}`, result.stderr.trim() || '（无输出）'].join('\n'),
              code: String(result.code)
            })
          }
        })

        return { ok: true }
      } catch (err) {
        return { ok: false, error: toPlainError(err) }
      }
    }
  )

  /**
   * 历史作业（sacct）。用来回答"上次那个作业为什么挂了"。
   *
   * 注意 `sacct --me` 在这个版本上不认，命令里用的是 `-u "$USER"`，
   * 详见 adapters/sacct.ts 的注释。
   */
  ipcMain.handle(
    'jobs:history',
    async (_event, request: { days?: number; profileId?: string } | undefined): Promise<JobsHistoryResponse> => {
      const started = Date.now()
      try {
        const days = Math.min(90, Math.max(1, Math.floor(request?.days ?? 7)))
        const command = sacctCommand(days)

        const loaded = loadProfiles(deps.configPath())
        const profile = deps.profileState.current(loaded, request?.profileId)

        const jobs = await deps.pool.run(profile, async (session) => {
          const result = await session.exec(command)

          if (result.code !== 0) {
            throw new SshError({
              kind: 'remote',
              message: `sacct 执行失败（退出码 ${result.code ?? 'null'}）`,
              hint: '可能是这个集群的 sacct 不支持 --json，或者记账服务没开。',
              raw: [`$ ${command}`, result.stderr.trim() || '（无输出）'].join('\n'),
              code: String(result.code)
            })
          }

          const parsed = parseSacct(result.stdout)
          if (!parsed.ok) {
            throw new SshError({
              kind: 'remote',
              message: `解析历史作业失败：${parsed.reason}`,
              hint: '把下面的原始输出发出来，方便对照字段变化。',
              raw: parsed.raw
            })
          }
          return parsed.data
        })

        return { ok: true, jobs, durationMs: Date.now() - started }
      } catch (err) {
        return { ok: false, error: toPlainError(err) }
      }
    }
  )

  /**
   * 节点库存（`scontrol show node --json`）。
   *
   * 这是**逐节点的库存真值**，`sinfo` 是分区聚合、拿不到逐节点 GPU，
   * 所以这里只用 scontrol。
   *
   * 返回前在 domain 层聚合成「按型号的库存」，型号顺便翻译成人话
   * ——`nvidia_a100_80gb_pcie` 这种名字不该直接甩给用户看。
   */
  ipcMain.handle(
    'nodes:list',
    async (_event, request: { profileId?: string } | undefined): Promise<NodesListResponse> => {
      const started = Date.now()
      try {
        const loaded = loadProfiles(deps.configPath())
        const profile = deps.profileState.current(loaded, request?.profileId)

        const inventory = await deps.pool.run(profile, async (session) => {
          const result = await session.exec('scontrol show node --json')

          if (result.code !== 0) {
            throw new SshError({
              kind: 'remote',
              message: `scontrol 执行失败（退出码 ${result.code ?? 'null'}）`,
              hint: '可能是这个集群的 SLURM 不支持 --json。',
              raw: ['$ scontrol show node --json', result.stderr.trim() || '（无输出）'].join('\n'),
              code: String(result.code)
            })
          }

          const parsed = parseNodeDetail(result.stdout)
          if (!parsed.ok) {
            throw new SshError({
              kind: 'remote',
              message: `解析节点信息失败：${parsed.reason}`,
              hint: '把下面的原始输出发出来，方便对照字段变化。',
              raw: parsed.raw
            })
          }
          return buildInventory(parsed.data)
        })

        const payload: InventoryPayload = {
          ...inventory,
          gpuTypes: inventory.gpuTypes.map((item) => ({ ...item, label: prettyGpuType(item.type) }))
        }

        return { ok: true, inventory: payload, durationMs: Date.now() - started }
      } catch (err) {
        return { ok: false, error: toPlainError(err) }
      }
    }
  )

  /**
   * 存储配额（GPFS 的 `mmlsquota`）。
   *
   * **必须用绝对路径 `/usr/lpp/mmfs/bin/mmlsquota`**：实测这台机器上
   * `mmlsquota` 不在 PATH 里（`command not found`），但绝对路径能跑。
   * 换成裸命令名就会一直失败。
   *
   * 这个命令要查 GPFS 元数据，实测约 550 ms，比 squeue/scontrol 慢不少，
   * 所以界面只在需要时刷。
   */
  ipcMain.handle(
    'quota:get',
    async (_event, request: { profileId?: string } | undefined): Promise<QuotaResponse> => {
      const started = Date.now()
      try {
        const loaded = loadProfiles(deps.configPath())
        const profile = deps.profileState.current(loaded, request?.profileId)

        const quotas = await deps.pool.run(profile, async (session) => {
          const result = await session.exec(QUOTA_COMMAND)

          if (result.code !== 0) {
            throw new SshError({
              kind: 'remote',
              message: `查询配额失败（退出码 ${result.code ?? 'null'}）`,
              hint: '这个集群可能没有用 GPFS，或者配额命令在别的路径。',
              raw: [`$ ${QUOTA_COMMAND}`, result.stderr.trim() || '（无输出）'].join('\n'),
              code: String(result.code)
            })
          }

          const parsed = parseQuota(result.stdout)
          if (!parsed.ok) {
            throw new SshError({
              kind: 'remote',
              message: `解析配额失败：${parsed.reason}`,
              hint: '把下面的原始输出发出来，方便对照格式变化。',
              raw: parsed.raw
            })
          }
          return parsed.data
        })

        return { ok: true, quotas, durationMs: Date.now() - started }
      } catch (err) {
        return { ok: false, error: toPlainError(err) }
      }
    }
  )

  /**
   * 点数余额（`scir-account -d`）。
   *
   * 标题栏要常驻显示——它和存储水位一样是"电量"级别的信息，
   * 跑到一半因为点数不够被掐掉很烦，所以必须一直看得见。
   */
  ipcMain.handle(
    'points:get',
    async (_event, request: { profileId?: string } | undefined): Promise<PointsResponse> => {
      const started = Date.now()
      try {
        const loaded = loadProfiles(deps.configPath())
        const profile = deps.profileState.current(loaded, request?.profileId)

        const points = await deps.pool.run(profile, async (session) => {
          const result = await session.exec(POINTS_COMMAND)

          if (result.code !== 0) {
            throw new SshError({
              kind: 'remote',
              message: `查询点数失败（退出码 ${result.code ?? 'null'}）`,
              hint: '这个集群可能没装 scir-account，或者命令名不一样。',
              raw: [`$ ${POINTS_COMMAND}`, result.stderr.trim() || '（无输出）'].join('\n'),
              code: String(result.code)
            })
          }

          const parsed = parsePoints(result.stdout)
          if (!parsed.ok) {
            throw new SshError({
              kind: 'remote',
              message: `解析点数失败：${parsed.reason}`,
              hint: '把下面的原始输出发出来，方便对照格式变化。',
              raw: parsed.raw
            })
          }
          return parsed.data
        })

        return { ok: true, points, durationMs: Date.now() - started }
      } catch (err) {
        return { ok: false, error: toPlainError(err) }
      }
    }
  )

  /**
   * 点数消耗明细（`scir-account details -r`）。
   *
   * 这个命令**不带任何时间过滤参数**（实测 `details` 只有 `-r` / `-d` 两个选项），
   * 一次返回账号下全部可查的作业记录。所以它天然不适合 5 分钟轮询——
   * 只在用户打开点数面板时按需拉一次，和 `price:get` 同一档。
   *
   * `-r` 带上 Resources 列的理由：没有它就只有 JID/名字/时长/点数，
   * 用户看不出"这 0.01 点是哪张卡扣的"。代价是那一列很宽（实测 100+ 字符），
   * 界面默认折叠、可展开。
   */
  ipcMain.handle(
    'points:usage',
    async (_event, request: { profileId?: string } | undefined): Promise<PointsUsageResponse> => {
      const started = Date.now()
      try {
        const loaded = loadProfiles(deps.configPath())
        const profile = deps.profileState.current(loaded, request?.profileId)

        const usage = await deps.pool.run(profile, async (session) => {
          const result = await session.exec(USAGE_COMMAND)

          if (result.code !== 0) {
            throw new SshError({
              kind: 'remote',
              message: `查询消耗记录失败（退出码 ${result.code ?? 'null'}）`,
              hint: '把下面的原始输出发出来，方便对照是命令变了还是账号权限问题。',
              raw: [`$ ${USAGE_COMMAND}`, result.stderr.trim() || '（无输出）'].join('\n'),
              code: String(result.code)
            })
          }

          const parsed = parseUsageTable(result.stdout)
          if (!parsed.ok) {
            throw new SshError({
              kind: 'remote',
              message: `解析消耗记录失败：${parsed.reason}`,
              hint: '表格格式可能变了。原始输出在下面。',
              raw: parsed.raw
            })
          }
          return parsed.data
        })

        return { ok: true, usage, durationMs: Date.now() - started }
      } catch (err) {
        return { ok: false, error: toPlainError(err) }
      }
    }
  )

  /**
   * 送点数（`scir-account transfer`）。
   *
   * ⚠️ **这是本应用唯一一个会真正动到钱的 IPC。** 三条防护：
   *
   * 1. 参数在本地先校验（`checkTransfer`）。`--points=-5` 到了远端只会报
   *    `unexpected argument '-5'`，用户根本看不懂；而且账号名要防注入。
   * 2. 密码**只在这一个调用里存在**，用完即弃。它不会被写进 KVStore、
   *    不会进命令台（`openShell` 不记 trace，且命令串里本来就没有密码）。
   * 3. 执行完**立刻重查一次余额**。因为转账成功与否不能只看退出码——
   *    要让用户看到点数真的少了，这是唯一可信的证据。
   *
   * 失败时把 PTY 的原始输出**原样带回去**：`LdapError(rc: 49)` 这种
   * 只有用户自己能判断是"密码打错了"还是"账号被锁了"。
   */
  ipcMain.handle(
    'points:transfer',
    async (_event, request: PointsTransferRequest): Promise<PointsTransferResponse> => {
      const started = Date.now()
      try {
        const check = checkTransfer({
          target: request?.target ?? '',
          points: Number(request?.points),
          month: Number(request?.month)
        })
        if (!check.ok) {
          return {
            ok: false,
            error: toPlainError(
              new SshError({
                kind: 'config',
                message: check.reason,
                hint: '在界面上改一下参数再试。',
                raw: `target=${String(request?.target)} points=${String(request?.points)} month=${String(request?.month)}`
              })
            )
          }
        }

        const loaded = loadProfiles(deps.configPath())
        const profile = deps.profileState.current(loaded, request?.profileId)

        /*
         * 密码从哪来：优先用调用方传的明文（用户当场输入），
         * 其次用凭据库里存的（`useStoredPassword`）。
         *
         * 这里的方向很重要：**存好的密码从主进程直接取，不经过渲染层**。
         * 所以界面上勾了"用已保存的密码"时，明文根本不离开主进程。
         */
        const typed = typeof request?.password === 'string' ? request.password : ''
        const wantStored = request?.useStoredPassword === true

        let password = typed
        let storedMissing = false
        if (password.length === 0 && wantStored) {
          const found = deps.credentials.get('platform-password', profile.username)
          if (found.ok) {
            password = found.secret
          } else {
            storedMissing = true
          }
        }

        if (password.length === 0) {
          return {
            ok: false,
            error: toPlainError(
              new SshError({
                kind: 'config',
                message: storedMissing
                  ? '没有可用的已保存密码'
                  : '要填集群密码才能转账',
                hint: storedMissing
                  ? '去「设置 → 登录凭据 → 平台账号密码」存一份，或者这次手动输入。'
                  : '这个密码只用于这一次转账，不会被保存。',
                raw: storedMissing ? 'stored credential missing or undecryptable' : 'password is empty'
              })
            )
          }
        }

        const outcome = await deps.pool.run(profile, async (session) => {
          const run = await runWithPassword(session, check.command, password)
          const text = extractCommandOutput(run.output)
          const verdict = isPasswordRunSuccess({ ...run, output: text })

          let points: Points | undefined
          if (verdict.ok) {
            // 成功之后重查余额：让用户看到点数确实少了，这是唯一可信的证据
            const after = await session.exec(POINTS_COMMAND)
            if (after.code === 0) {
              const parsed = parsePoints(after.stdout)
              if (parsed.ok) points = parsed.data
            }
          }

          return { run, text, verdict, points }
        })

        if (!outcome.verdict.ok) {
          const hint = outcome.run.timedOut
            ? '等了 25 秒没有任何回应。多半是这台机器不让开交互终端，或者命令卡在了别的地方。**请先到集群上用 `scir-account -d` 看一眼余额**，确认这次到底有没有转出去，再决定要不要重试。'
            : /rc:\s*49|AuthFailed/i.test(outcome.text)
              ? '密码不对，或者这个账号没权限做转账。密码错了 LDAP 就返回 49。'
              : '平台拒绝了这次转账。下面的原始输出是它自己的说明。'
          throw new SshError({
            kind: 'remote',
            message: `转账没成功：${outcome.verdict.reason ?? '原因不明'}`,
            hint,
            raw: [`$ ${check.command}`, outcome.text || '（没有任何输出）'].join('\n')
          })
        }

        return {
          ok: true,
          message: outcome.text,
          points: outcome.points,
          durationMs: Date.now() - started
        }
      } catch (err) {
        return { ok: false, error: toPlainError(err) }
      }
    }
  )

  /**
   * 生成「让他人赠送点数」的说明文本。
   *
   * 实测 `transfer` **没有**反向指令——平台侧只有"我把点数转给你"，
   * 没有"你向某人要点数"。所以这个接口返回的是给**对方**看的一段话，
   * 里面填的是**我自己的账号名**（从 profile 拿，不是猜的）。
   */
  ipcMain.handle(
    'points:gift-instruction',
    async (_event, request: { points?: number; month?: number; profileId?: string } | undefined) => {
      try {
        const loaded = loadProfiles(deps.configPath())
        const profile = deps.profileState.current(loaded, request?.profileId)
        return {
          ok: true as const,
          text: giftInstruction({
            username: profile.username,
            points: request?.points,
            month: request?.month
          })
        }
      } catch (err) {
        return { ok: false as const, error: toPlainError(err) }
      }
    }
  )

  /**
   * 凭据状态：系统钥匙串能不能用、存了几条。
   *
   * 界面第一件事就是问这个——不能加密时要**禁用保存按钮并说明原因**，
   * 而不是让用户点了保存、以为存上了。
   */
  ipcMain.handle('credentials:status', async (): Promise<CredentialsStatusResponse> => {
    try {
      return { ok: true, status: deps.credentials.status() }
    } catch (err) {
      return { ok: false, error: toPlainError(err) }
    }
  })

  /**
   * 凭据清单 + "配置文件里还有哪些明文"。
   *
   * 清单里**不含任何密文或明文**，只有 kind / scope / 时间。
   * 明文检测用的是 `loadProfiles()` 的原始结果，**不能**用
   * `profileState.current()`——后者会把库里的密码填进 `auth.password`，
   * 于是每条 password 型 profile 都会被误报成"明文未迁移"。
   *
   * `targets` 是"**可以**给哪些位置设凭据"，由主进程算好 scope：
   * 界面不该自己拼 `scope`（私钥的 scope 是绝对路径，渲染层根本拿不到）。
   * 这样界面只是渲染一个列表，不用理解三套 scope 规则。
   */
  ipcMain.handle('credentials:list', async (): Promise<CredentialsListResponse> => {
    try {
      const vault = deps.credentials
      const status = vault.status()
      const loaded = loadProfiles(deps.configPath())

      const items = vault.list().map((entry) => ({
        kind: entry.kind,
        scope: entry.scope,
        display: describeScope(entry.kind, entry.scope),
        label: CREDENTIAL_KINDS.find((meta) => meta.kind === entry.kind)?.label ?? entry.kind,
        savedAt: entry.savedAt,
        sessionOnly: entry.sessionOnly
      }))

      /*
       * 可设置的位置：
       * - 每条 profile 的 SSH 密码（method=password 才列，key 型不需要）
       * - 每条 profile 的私钥口令（method=key 才列）
       *
       * 私钥的 scope 是绝对路径。这不算违背"auth 不出主进程"——
       * 那条原则针对的是密码和口令，路径本身不是凭据（用户在文件页也能看到它）。
       */
      const targets: CredentialTarget[] = []
      for (const profile of loaded.profiles) {
        if (profile.auth.method === 'password') {
          targets.push({
            kind: 'ssh-password',
            scope: profile.id,
            display: `${profile.label}（${profile.username}）`,
            ownerLabel: profile.label,
            configured: vault.has('ssh-password', profile.id)
          })
          continue
        }
        const keyPath = profile.auth.privateKeyPath
        if (keyPath) {
          targets.push({
            kind: 'key-passphrase',
            scope: keyPath,
            display: describeScope('key-passphrase', keyPath),
            ownerLabel: profile.label,
            configured: vault.has('key-passphrase', keyPath),
            // 私钥**不一定**带口令，所以界面上这条是可选的
            optional: true
          })
        }
      }

      // 平台账号密码：按当前账号存一份，跨 profile 共用
      const active = deps.profileState.current(loaded)
      targets.push({
        kind: 'platform-password',
        scope: active.username,
        display: active.username,
        ownerLabel: '平台账号',
        configured: vault.has('platform-password', active.username)
      })

      return {
        ok: true,
        status,
        items,
        targets,
        plaintext: findPlaintextAuth(loaded.profiles, { canEncrypt: status.available }),
        // 哪些 profile 还没配凭据 —— 界面直接标出来，省得用户自己比对
        missing: loaded.profiles
          .filter((profile) => profile.auth.method === 'password')
          .filter((profile) => !vault.has('ssh-password', profile.id))
          .map((profile) => ({ profileId: profile.id, label: profile.label }))
      }
    } catch (err) {
      return { ok: false, error: toPlainError(err) }
    }
  })

  /**
   * 存一条凭据。
   *
   * `persist: false` 表示"只在本次运行内记住"——钥匙串不可用时这是**唯一**
   * 可行的方式，也是共用电脑时用户主动的选择。它不写盘。
   *
   * 密码只在这次调用里出现：不写日志、不进命令台、不返回给渲染层任何回显。
   */
  ipcMain.handle(
    'credentials:set',
    async (_event, request: CredentialsSetRequest): Promise<CredentialsSetResponse> => {
      try {
        if (!isCredentialKind(request?.kind)) {
          return { ok: false, reason: '不认识的凭据种类' }
        }
        const secret = typeof request.secret === 'string' ? request.secret : ''
        if (secret.length === 0) {
          return { ok: false, reason: '密码是空的' }
        }
        const scope = typeof request.scope === 'string' ? request.scope : ''

        const vault = deps.credentials
        if (request.persist === false) {
          vault.rememberForSession(request.kind, scope, secret)
          return { ok: true, persisted: false }
        }

        // 不落盘就走不到这里：钥匙串不可用时明确拒绝，绝不悄悄存明文
        if (!vault.status().available) {
          return {
            ok: false,
            reason: `${vault.status().backend}不可用，这台机器上无法安全保存密码。可以选「只在本次运行内记住」。`
          }
        }

        vault.set(request.kind, scope, secret)
        return { ok: true, persisted: true }
      } catch (err) {
        return { ok: false, reason: explainVaultError(err) }
      }
    }
  )

  ipcMain.handle(
    'credentials:remove',
    async (_event, request: { kind?: string; scope?: string } | undefined) => {
      try {
        if (!isCredentialKind(request?.kind)) {
          return { ok: false as const, reason: '不认识的凭据种类' }
        }
        deps.credentials.remove(request.kind, request.scope ?? '')
        return { ok: true as const }
      } catch (err) {
        return { ok: false as const, reason: explainVaultError(err) }
      }
    }
  )

  /**
   * 测一个密码对不对。
   *
   * ## 唯一可靠的办法就是真的去认证一次
   *
   * 密码是加密存的，程序解开密文只能证明"密钥还在"，不能证明"里面那串是对的"
   * ——它没有正确答案可比。所以这里真的去问认证方（详见 `credentials/test.ts`）。
   *
   * ## 三种凭据的代价差很远，界面上要说明
   *
   * - `key-passphrase`：本地解一次私钥，**不联网**
   * - `ssh-password`：真发一次 SSH 认证（1~2 秒）
   * - `platform-password`：**会向平台发一次 0 点转账**（转给自己，等于空操作，
   *   但确实是一次请求）。所以界面必须提前告诉用户，不能偷偷发。
   *
   * ## 探针连接不校验主机指纹
   *
   * 这个探针的职责只有一个：密码对不对。指纹问题在正常连接时已经会拦，
   * 混进来只会让用户看到"连不上"而误以为密码错。
   */
  ipcMain.handle(
    'credentials:test',
    async (_event, request: CredentialsTestRequest): Promise<CredentialsTestResponse> => {
      try {
        if (!isCredentialKind(request?.kind)) {
          return { outcome: { status: 'unsupported', message: '不认识的凭据种类' } }
        }
        const kind = request.kind
        const scope = typeof request.scope === 'string' ? request.scope : ''

        // 没传明文就用库里存的——这样"测已保存的"不需要把密码再传一遍
        const typed = typeof request.secret === 'string' && request.secret.length > 0 ? request.secret : null
        const lookup = typed !== null ? { ok: true as const, secret: typed } : deps.credentials.get(kind, scope)
        if (!lookup.ok) {
          return {
            outcome: {
              status: 'unsupported',
              message:
                lookup.reason === 'undecryptable'
                  ? '这条密码解不开（可能换了系统账户），没法测。重新输一次。'
                  : '这条还没保存，没有可测的内容。'
            }
          }
        }
        const secret = lookup.secret

        if (kind === 'key-passphrase') {
          // scope 就是私钥的绝对路径，本地读文件解一次，不碰网络
          if (scope.length === 0) {
            return { outcome: { status: 'unsupported', message: '这条凭据没有关联私钥文件' } }
          }
          let material: Buffer
          try {
            material = await readFile(scope)
          } catch (err) {
            return {
              outcome: {
                status: 'unreachable',
                message: '读不到私钥文件，没法验证口令。',
                detail: err instanceof Error ? err.message : String(err)
              }
            }
          }
          return { outcome: testPassphrase(material, secret) }
        }

        if (kind === 'ssh-password') {
          const loaded = loadProfiles(deps.configPath())
          const found = loaded.profiles.find((item) => item.id === scope)
          if (!found) {
            return { outcome: { status: 'unsupported', message: `配置里找不到 id 为 ${scope} 的跳板机` } }
          }

          // 用这个密码覆盖 profile 的认证方式，开一次连接就关掉
          const probe: typeof found = {
            ...found,
            auth: { method: 'password', password: secret }
          }
          let session: Session | null = null
          try {
            session = await Session.open(probe, {})
            return { outcome: { status: 'ok', message: '密码正确，SSH 认证通过了。' } }
          } catch (err) {
            return { outcome: judgeSshProbe(err) }
          } finally {
            // 探针连接用完立刻断，不占服务端的 MaxSessions 名额
            await session?.close().catch(() => undefined)
          }
        }

        // platform-password：只能通过 transfer 走 LDAP
        const loaded = loadProfiles(deps.configPath())
        const profile = deps.profileState.current(loaded, request.profileId)

        /*
         * 0 点 + 转给自己：等于空操作，但会真的走到 LDAP 认证那一步。
         * 用 `shq()` 包账号名——虽然它来自 profile 而不是用户输入，
         * 但拼命令时一律过一遍，不给"哪天 profile 被填成怪值"留口子。
         */
        const command = [
          'scir-account',
          'transfer',
          '--points=0',
          `--target=${shq(profile.username)}`,
          '--month=1'
        ].join(' ')

        const run = await deps.pool.run(profile, async (session) =>
          runWithPassword(session, command, secret, { timeoutMs: 20_000 })
        )

        return {
          outcome: judgeLdapProbe({
            finished: run.finished,
            timedOut: run.timedOut,
            code: run.code,
            output: extractCommandOutput(run.output)
          })
        }
      } catch (err) {
        return {
          outcome: {
            status: 'unreachable',
            message: '测试过程中出错了，没法判断密码对错。',
            detail: err instanceof Error ? err.message : String(err)
          }
        }
      }
    }
  )

  /**
   * 显卡单价（`scir-watch -s`）。
   *
   * **只用来取价，不当库存真值**（docs/03 §5.0）：
   * 它给的 FREE GPUs 只是那一行的快照，逐节点库存还是以 scontrol 为准。
   * 实测两边是对得上的，但语义上要分清——价格可信、库存不可全信。
   */
  ipcMain.handle(
    'price:get',
    async (_event, request: { profileId?: string } | undefined): Promise<GpuPriceResponse> => {
      const started = Date.now()
      try {
        const loaded = loadProfiles(deps.configPath())
        const profile = deps.profileState.current(loaded, request?.profileId)

        const prices = await deps.pool.run(profile, async (session) => {
          const result = await session.exec(GPU_PRICE_COMMAND)

          if (result.code !== 0) {
            throw new SshError({
              kind: 'remote',
              message: `查询显卡价格失败（退出码 ${result.code ?? 'null'}）`,
              hint: '这个集群可能没有 scir-watch，或者改名了。',
              raw: [`$ ${GPU_PRICE_COMMAND}`, result.stderr.trim() || '（无输出）'].join('\n'),
              code: String(result.code)
            })
          }

          const parsed = parseGpuPrice(result.stdout)
          if (!parsed.ok) {
            throw new SshError({
              kind: 'remote',
              message: `解析显卡价格失败：${parsed.reason}`,
              hint: '把下面的原始输出发出来，方便对照格式变化。',
              raw: parsed.raw
            })
          }
          return parsed.data
        })

        return { ok: true, prices, durationMs: Date.now() - started }
      } catch (err) {
        return { ok: false, error: toPlainError(err) }
      }
    }
  )

  /**
   * 提交作业。
   *
   * 两种模式：
   * - `command`：把预览过的脚本内容写到远端，再 `sbatch` 那个文件
   * - `script`：不写文件，直接 `sbatch <参数> 已有脚本`
   *
   * **目标文件已存在就拒绝**，不静默覆盖——用户可能正在改那份脚本，
   * 悄悄覆盖掉比报错更糟。脚本名里带时间戳就是为了降低撞名概率。
   *
   * sbatch 输出必须能解析出作业号。解析不出来就按失败处理：
   * 编一个 0 出来会让用户以为交上去了，实际可能被策略拦了。
   */
  ipcMain.handle(
    'jobs:submit',
    async (_event, request: SubmitJobRequest): Promise<SubmitJobResponse> => {
      try {
        const scriptPath = String(request?.scriptPath ?? '').trim()
        if (!scriptPath.startsWith('/')) {
          throw new SshError({
            kind: 'config',
            message: '脚本路径必须是远端绝对路径',
            raw: JSON.stringify(request?.scriptPath)
          })
        }

        const args = Array.isArray(request?.args) ? request.args.map(String) : []
        const loaded = loadProfiles(deps.configPath())
        const profile = deps.profileState.current(loaded, request?.profileId)

        const result = await deps.pool.run(profile, async (session) => {
          const sftp = await session.sftp()

          if (request.mode === 'command') {
            const exists = await new Promise<boolean>((resolve) => {
              sftp.stat(scriptPath, (err) => resolve(!err))
            })
            if (exists) {
              throw new SshError({
                kind: 'config',
                message: `远端已经有同名脚本：${scriptPath}`,
                hint: '换一个作业名，或者手动改掉那个旧脚本。',
                raw: scriptPath
              })
            }

            await new Promise<void>((resolve, reject) => {
              sftp.writeFile(scriptPath, request.content ?? '', (err) => {
                if (err) {
                  reject(
                    new SshError({
                      kind: 'remote',
                      message: `写脚本失败：${scriptPath}`,
                      hint: '检查这个目录有没有写权限。',
                      raw: err.message
                    })
                  )
                  return
                }
                resolve()
              })
            })
          }

          // 参数和路径都过 shq，作业名里带空格/引号也不会把命令拼坏
          const command = [SBATCH_COMMAND, ...args.map((arg) => shq(arg)), shq(scriptPath)].join(' ')
          const exec = await session.exec(command)

          if (exec.code !== 0) {
            // sbatch 的原始报错常常是 "total cpus num(8) > tres total num(1) * cpu_limit(4)"
            // 这种，用户看不出该改哪个数，所以先尝试翻译成人话
            const explained = explainSbatchError(exec.stderr)

            throw new SshError({
              kind: 'remote',
              message: `提交失败（退出码 ${exec.code ?? 'null'}）`,
              hint:
                explained ??
                (request.mode === 'command'
                  ? `脚本已经写到 ${scriptPath}，可以打开看看或者改完重交。`
                  : '检查分区名、卡数是否超过上限、时限是否超过分区限制。'),
              raw: [`$ ${command}`, exec.stderr.trim() || exec.stdout.trim() || '（无输出）'].join('\n'),
              code: String(exec.code)
            })
          }

          const jobId = parseSubmittedJobId(exec.stdout)
          if (!jobId) {
            throw new SshError({
              kind: 'remote',
              message: 'sbatch 没有返回作业号',
              hint: '命令执行了但输出里没有 "Submitted batch job"，可能被策略拦下了。',
              raw: [`$ ${command}`, exec.stdout.trim(), exec.stderr.trim()].filter(Boolean).join('\n')
            })
          }

          return { jobId, command }
        })

        return { ok: true, jobId: result.jobId, command: result.command }
      } catch (err) {
        return { ok: false, error: toPlainError(err) }
      }
    }
  )

  /**
   * 预估作业什么时候能开始跑（`sbatch --test-only`）。
   *
   * 写一个临时脚本 → `--test-only`（只做资源检查，**不占资源**）→ 解析排程 → 删临时文件。
   *
   * ⚠️ 已知局限：`--test-only` **不检查集群扩展的配比限制**。实测 1 卡 8 核它
   * 照样给出排程，但真实提交会被拒。所以界面要写明"只是估算"。
   */
  ipcMain.handle(
    'jobs:dry-run',
    async (_event, request: SubmitJobRequest): Promise<DryRunResponse> => {
      const tempPath = `/tmp/wb-dryrun-${Date.now()}-${Math.floor(Math.random() * 1000)}.sbatch`
      try {
        const args = Array.isArray(request?.args) ? request.args.map(String) : []
        const loaded = loadProfiles(deps.configPath())
        const profile = deps.profileState.current(loaded, request?.profileId)

        return await deps.pool.run(profile, async (session) => {
          const sftp = await session.sftp()
          let scriptToTest = request.scriptPath

          if (request.mode === 'command') {
            await new Promise<void>((resolve, reject) => {
              sftp.writeFile(tempPath, request.content ?? '', (err) => (err ? reject(err) : resolve()))
            })
            scriptToTest = tempPath
          }

          try {
            const command = ['sbatch', '--test-only', ...args.map((arg) => shq(arg)), shq(scriptToTest)].join(' ')
            const exec = await session.exec(command)
            const output = `${exec.stdout}\n${exec.stderr}`.trim()

            if (exec.code !== 0) {
              return {
                ok: false,
                raw: [`$ ${command}`, output].join('\n'),
                error: {
                  kind: 'remote',
                  message: '预估失败',
                  hint: explainSbatchError(exec.stderr) ?? '这个集群可能不支持 --test-only。',
                  raw: output
                }
              }
            }

            const parsed = parseTestOnlyOutput(output)
            return { ok: true, ...parsed, raw: output }
          } finally {
            if (request.mode === 'command') {
              await new Promise<void>((resolve) => sftp.unlink(tempPath, () => resolve()))
            }
          }
        })
      } catch (err) {
        return { ok: false, error: toPlainError(err) }
      }
    }
  )

  /**
   * 某台机器上现在跑着谁的作业（`squeue -w <node> -t RUNNING`）。
   *
   * 用途：解释"为什么这台机器卡空着却跑不了"——能看到是哪些作业占着核。
   *
   * ⚠️ `END_TIME` 是**按作业 `--time` 时限算出来的上限**，不是预测值。
   * 作业经常提前跑完，没设时限的会给 N/A。界面上必须说明这一点，
   * 否则用户会把它当成"精确结束时间"去规划。
   *
   * 为什么用 `-o` 而不是 `--json`：`-w` 对 `--json` 不生效（实测返回全集群 203 个作业、
   * 1.3 MB），而 `-o` 只返回这台机器的几行、几百字节。
   */
  ipcMain.handle(
    'nodes:jobs',
    async (_event, request: { nodeName: string; profileId?: string }): Promise<NodeJobsResponse> => {
      try {
        const nodeName = String(request?.nodeName ?? '').trim()
        // 节点名只允许字母数字和 - _，防注入
        if (!/^[A-Za-z0-9_-]+$/.test(nodeName)) {
          throw new SshError({
            kind: 'config',
            message: `节点名不合法：${nodeName || '（空）'}`,
            raw: JSON.stringify(request?.nodeName)
          })
        }

        const loaded = loadProfiles(deps.configPath())
        const profile = deps.profileState.current(loaded, request?.profileId)

        const jobs = await deps.pool.run(profile, async (session) => {
          const command = `squeue -w ${shq(nodeName)} -t RUNNING -h -o "%i|%u|%C|%b|%e|%j"`
          const result = await session.exec(command)

          if (result.code !== 0) {
            throw new SshError({
              kind: 'remote',
              message: `查询节点作业失败（退出码 ${result.code ?? 'null'}）`,
              hint: '可能是节点名写错了，或者这台机器上没有作业。',
              raw: [`$ ${command}`, result.stderr.trim() || '（无输出）'].join('\n'),
              code: String(result.code)
            })
          }

          const parsed: NodeJob[] = []
          for (const line of result.stdout.split(/\r?\n/)) {
            if (!line.trim()) continue
            const parts = line.split('|')
            if (parts.length < 6) continue
            // 作业名里可能带竖线，剩下的全部合并回名字
            const [id, user, cpus, gres, endTime] = parts
            const name = parts.slice(5).join('|')

            parsed.push({
              id: (id ?? '').trim(),
              user: (user ?? '').trim(),
              cpus: Number.parseInt(cpus ?? '0', 10) || 0,
              gres: gres && gres !== 'N/A' ? gres : null,
              endTime: endTime && endTime !== 'N/A' ? endTime : null,
              name: name.trim()
            })
          }
          return parsed
        })

        return { ok: true, jobs }
      } catch (err) {
        return { ok: false, error: toPlainError(err) }
      }
    }
  )

  /**
   * 读作业的输出日志（最后 200 行，一次性）。
   *
   * 路径怎么定见 `resolveJobLogPath`——先问 `scontrol` 要精确的 `standard_output`，
   * 查不到才退回 `sacct` + 命名约定。
   *
   * `jobName` / `workDir` 现在都只是**提示**（历史表格里现成的就顺手带上），
   * 不再强制要求：运行中的作业也能直接查。
   */
  ipcMain.handle(
    'jobs:log',
    async (_event, request: LogRequest | undefined): Promise<JobLogResponse> => {
      try {
        const jobId = String(request?.jobId ?? '').trim()
        if (!JOB_ID_PATTERN.test(jobId)) {
          throw new SshError({ kind: 'config', message: `作业号不合法：${jobId || '（空）'}`, raw: jobId })
        }

        const loaded = loadProfiles(deps.configPath())
        const profile = deps.profileState.current(loaded, request?.profileId)

        return await deps.pool.run(profile, async (session) => {
          const found = await resolveJobLogPath(session, jobId, {
            jobName: request?.jobName,
            workDir: request?.workDir
          })
          if (!found.ok) {
            return {
              ok: false,
              tried: found.tried,
              error: { kind: 'remote', message: found.reason, hint: found.hint, raw: found.raw }
            }
          }

          if (!found.data.exists) {
            return {
              ok: false,
              path: found.data.path,
              error: {
                kind: 'remote',
                message: `输出文件还不存在：${found.data.path}`,
                hint: '作业可能还没产生输出。用「跟随输出」可以一直等它出现。',
                raw: found.data.path
              }
            }
          }

          const result = await session.exec(`tail -n ${LOG_TAIL_LINES} -- ${shq(found.data.path)}`)
          if (result.code !== 0 && result.stdout.length === 0) {
            return {
              ok: false,
              path: found.data.path,
              error: {
                kind: 'remote',
                message: `读日志失败（退出码 ${result.code ?? '未知'}）`,
                hint: result.stderr.trim() || '文件可能没有读权限。',
                raw: result.stderr || `exit=${result.code}`
              }
            }
          }

          return { ok: true, path: found.data.path, source: found.data.source, content: result.stdout }
        })
      } catch (err) {
        return { ok: false, error: toPlainError(err) }
      }
    }
  )

  /**
   * 作业详情（`scontrol show job <id> --json`）。
   *
   * 拿不到时退回 `sacct` 的历史记录——作业结束后 5 分钟就会被控制器清掉，
   * 那时候只有 sacct 还记着。两种情况都如实标出 `source`，别让人以为是同一份数据。
   */
  ipcMain.handle(
    'jobs:detail',
    async (_event, request: LogRequest | undefined): Promise<JobDetailResponse> => {
      try {
        const jobId = String(request?.jobId ?? '').trim()
        if (!JOB_ID_PATTERN.test(jobId)) {
          throw new SshError({ kind: 'config', message: `作业号不合法：${jobId || '（空）'}`, raw: jobId })
        }

        const loaded = loadProfiles(deps.configPath())
        const profile = deps.profileState.current(loaded, request?.profileId)

        return await deps.pool.run(profile, async (session) => {
          const raw = await session.exec(scontrolJobCommand(jobId))
          const parsed = parseScontrolJob(raw.stdout)
          if (parsed.ok) return { ok: true, detail: parsed.data, source: 'scontrol' as const }

          // scontrol 查不到（多半是作业已结束并被清理）：退回 sacct
          const history = await session.exec(sacctCommand(30))
          const sacct = parseSacct(history.stdout)
          if (!sacct.ok) {
            return {
              ok: false,
              error: {
                kind: 'remote',
                message: parsed.reason,
                hint: '历史记录也读不出来，作业可能太老了。',
                raw: [parsed.raw, sacct.raw].join('\n\n')
              }
            }
          }

          const row = sacct.data.find((item) => item.id === jobId)
          if (!row) {
            return {
              ok: false,
              error: {
                kind: 'remote',
                message: `最近 30 天里没有作业 ${jobId} 的记录`,
                hint: '作业号可能写错了，或者它比 30 天还早。',
                raw: parsed.raw
              }
            }
          }

          return {
            ok: true,
            source: 'sacct' as const,
            detail: {
              id: row.id,
              name: row.name,
              state: row.state,
              rawState: row.rawState,
              stateReason: row.stateReason,
              stateReasonText: row.stateReason ?? '',
              user: '',
              partition: row.partition,
              nodes: row.nodes,
              nodeCount: row.nodeCount,
              cpus: row.cpus,
              memoryMb: null,
              gpus: row.gpus,
              gpuDetail: [],
              timeLimitMinutes: row.timeLimitMinutes,
              submitTime: row.submitTime,
              startTime: row.startTime,
              endTime: row.endTime,
              workDir: row.workDir,
              // sacct 不给输出文件名，只能留空——由 resolveJobLogPath 去猜
              stdoutPath: null,
              stderrPath: null,
              command: null,
              exitCode: row.exitStatus,
              derivedExitCode: null,
              tresAlloc: null,
              tresReq: null
            }
          }
        })
      } catch (err) {
        return { ok: false, error: toPlainError(err) }
      }
    }
  )

  /**
   * 跟随日志（`tail -F`），一块一块推给渲染层。
   *
   * 三个约束：
   * 1. **tail 不 await**。它永不结束，await 会把这次 IPC 调用挂死。
   * 2. **IPC 要合并推送**。训练日志一秒能刷几百行，一条一块地发会把渲染层打死
   *    （和传输进度的教训一样）。
   * 3. **一个窗口只留一路**。旧的不停，通道越开越多，最后撞上服务端 MaxSessions。
   */
  ipcMain.handle(
    'jobs:log-start',
    async (event, request: LogRequest | undefined): Promise<JobLogStreamStart> => {
      try {
        const jobId = String(request?.jobId ?? '').trim()
        if (!JOB_ID_PATTERN.test(jobId)) {
          throw new SshError({ kind: 'config', message: `作业号不合法：${jobId || '（空）'}`, raw: jobId })
        }

        // 同一个窗口之前开的跟随全部停掉
        for (const state of logStreams.values()) {
          if (state.senderId === event.sender.id) state.controller.abort()
        }

        const streamId = `log-${jobId}-${Date.now().toString(36)}`
        const controller = new AbortController()
        const sender = event.sender
        const loaded = loadProfiles(deps.configPath())
        const profile = deps.profileState.current(loaded, request?.profileId)

        const resolved = await deps.pool.run(profile, async (session) => {
          const found = await resolveJobLogPath(session, jobId, {
            jobName: request?.jobName,
            workDir: request?.workDir
          })
          if (!found.ok) return found

          const state: LogStreamState = {
            senderId: sender.id,
            controller,
            buffer: '',
            timer: null,
            flush: () => {}
          }
          logStreams.set(streamId, state)
          state.flush = (): void => {
            if (state.buffer.length === 0) return
            const text = state.buffer
            state.buffer = ''
            if (!sender.isDestroyed()) sender.send('jobs:log-chunk', { streamId, text })
          }

          // 注意这里**没有 await**：tail -f 会一直跑，await 就把 IPC 挂住了
          void session
            .tail(`tail -n ${LOG_TAIL_LINES} -F -- ${shq(found.data.path)}`, {
              onText: (text) => {
                state.buffer += text
                // 刷屏时别等定时器，攒太多会一次性甩一个巨大的字符串给渲染层
                if (state.buffer.length >= 256 * 1024) state.flush()
              },
              onStderr: (text) => {
                state.buffer += text
              },
              signal: controller.signal
            })
            .then((result) => {
              if (state.timer) clearInterval(state.timer)
              state.flush()
              logStreams.delete(streamId)
              if (sender.isDestroyed()) return
              sender.send('jobs:log-end', {
                streamId,
                aborted: result.aborted,
                code: result.code,
                reason: result.aborted
                  ? '已停止跟随'
                  : result.code === 0
                    ? '日志输出结束（远端命令退出了）'
                    : result.stderr.trim() || `tail 异常退出（退出码 ${result.code ?? '未知'}）`
              })
            })
            .catch((err: unknown) => {
              if (state.timer) clearInterval(state.timer)
              logStreams.delete(streamId)
              if (sender.isDestroyed()) return
              sender.send('jobs:log-end', {
                streamId,
                aborted: true,
                code: null,
                reason: `${(err as Error).message ?? String(err)}`
              })
            })

          state.timer = setInterval(state.flush, LOG_FLUSH_INTERVAL_MS)

          return { ok: true as const, data: found.data }
        })

        if (!resolved.ok) {
          return {
            ok: false,
            tried: resolved.tried,
            error: { kind: 'remote', message: resolved.reason, hint: resolved.hint, raw: resolved.raw }
          }
        }

        return {
          ok: true,
          streamId,
          path: resolved.data.path,
          source: resolved.data.source
        }
      } catch (err) {
        return { ok: false, error: toPlainError(err) }
      }
    }
  )

  /** 停止跟随。远端 tail 会被 TERM 掉，不留孤儿进程 */
  ipcMain.handle('jobs:log-stop', (_event, streamId: string): { ok: boolean } => {
    const state = logStreams.get(typeof streamId === 'string' ? streamId : '')
    if (!state) return { ok: true }
    state.controller.abort()
    return { ok: true }
  })

  /** 拖拽镜像当前占用（设置页显示用） */
  ipcMain.handle('fs:mirror-stats', (): Promise<{ files: number; bytes: number }> => mirrorStats())

  /** 清空拖拽镜像。下次拖文件会重新下载 */
  ipcMain.handle('fs:clear-mirror', async (): Promise<{ files: number; bytes: number }> => clearMirror())

  /** 读当前设置的默认目录；null 表示没设置（用用户主目录） */
  ipcMain.handle('fs:get-local-start', (): { dir: string | null } => ({
    dir: deps.cache.get<string>(LOCAL_START_KEY) ?? null
  }))

  /** 设置或清除默认目录。传 null / 空串 = 恢复默认 */
  ipcMain.handle('fs:set-local-start', (_event, dir: string | null): { dir: string | null } => {
    const trimmed = typeof dir === 'string' ? dir.trim() : ''

    if (trimmed.length > 0) {
      deps.cache.set(LOCAL_START_KEY, trimmed)
      return { dir: trimmed }
    }

    deps.cache.delete(LOCAL_START_KEY)
    return { dir: null }
  })

  ipcMain.handle('fs:rename', async (_event, request: RenameRequest): Promise<RenameResponse> => {
    try {
      if (request.side === 'local') {
        return { ok: true, newPath: await renameLocal(request.path, request.newName) }
      }
      const loaded = loadProfiles(deps.configPath())
      const profile = deps.profileState.current(loaded, request.profileId)
      const newPath = await deps.pool.run(profile, async (session) => {
        const result = await renameRemote(session, request.path, request.newName)
        // 改名同时影响旧路径和新路径所在的目录
        invalidateListing(session, request.path)
        invalidateListing(session, result)
        return result
      })
      return { ok: true, newPath }
    } catch (err) {
      return { ok: false, error: toPlainError(err) }
    }
  })

  ipcMain.handle('fs:mkdir', async (_event, request: MkdirRequest): Promise<MkdirResponse> => {
    try {
      if (request.side === 'local') {
        return { ok: true, newPath: await mkdirLocal(request.parent, request.name) }
      }
      const loaded = loadProfiles(deps.configPath())
      const profile = deps.profileState.current(loaded, request.profileId)
      const newPath = await deps.pool.run(profile, async (session) => {
        const result = await mkdirRemote(session, request.parent, request.name)
        invalidateListing(session, result)
        return result
      })
      return { ok: true, newPath }
    } catch (err) {
      return { ok: false, error: toPlainError(err) }
    }
  })

  /**
   * 移动/剪切一批条目到另一个目录。
   *
   * 语义和 `fs:delete` 一致：**逐条做、逐条报**。批量移动里一个文件被占用，
   * 不该让其余九个都不动——那会让用户完全无法收拾现场。
   * 全部失败时仍然返回 `ok: false`，并给出第一条的原因当摘要。
   */
  ipcMain.handle('fs:move', async (_event, request: MoveRequest): Promise<MoveResponse> => {
    const moved: string[] = []
    const failed: Array<{ path: string; error: PlainError }> = []

    try {
      if (request.side === 'local') {
        for (const path of request.paths) {
          try {
            moved.push(await moveLocal(path, request.targetDir))
          } catch (err) {
            failed.push({ path, error: toPlainError(err) })
          }
        }
      } else {
        const loaded = loadProfiles(deps.configPath())
        const profile = deps.profileState.current(loaded, request.profileId)
        await deps.pool.run(profile, async (session) => {
          for (const path of request.paths) {
            try {
              const target = await moveRemote(session, path, request.targetDir)
              moved.push(target)
              // 源目录和目标目录的缓存都得失效，否则界面上"移完还在这"
              invalidateListing(session, path)
              invalidateListing(session, target)
            } catch (err) {
              failed.push({ path, error: toPlainError(err) })
            }
          }
        })
      }
    } catch (err) {
      // 连接层失败：整批都算失败
      const error = toPlainError(err)
      return { ok: false, moved, failed: request.paths.map((path) => ({ path, error })), error }
    }

    return {
      ok: failed.length === 0,
      moved,
      failed,
      error: moved.length === 0 ? failed[0]?.error : undefined
    }
  })

  ipcMain.handle('transfer:plan', async (_event, request: PlanRequest): Promise<PlanTransferResponse> => {
    try {
      return { ok: true, plan: await deps.transfer.plan(request) }
    } catch (err) {
      return { ok: false, error: toPlainError(err) }
    }
  })

  ipcMain.handle(
    'transfer:start',
    async (_event, request: StartTransferRequest): Promise<StartTransferResponse> => {
      try {
        return { ok: true, snapshot: await deps.transfer.start(request.planId, request.onConflict) }
      } catch (err) {
        return { ok: false, error: toPlainError(err) }
      }
    }
  )

  /**
   * 取消传输。
   *
   * `request.cleanup` 为 true 时，连已经传到磁盘上的半截文件一起删掉。
   * 传对象而不是裸 taskId，是因为这个决定必须由用户在界面上做——
   * 默认值（不传）是**不删**，宁可留个 `.part` 让人自己看一眼，
   * 也不要悄悄删掉别人正在看的半截数据。
   */
  ipcMain.handle(
    'transfer:cancel',
    async (_event, request: { taskId: string; cleanup?: boolean } | string): Promise<unknown> => {
      // 兼容旧调用（裸 taskId）：preload 升级前的老窗口还在传字符串
      const taskId = typeof request === 'string' ? request : request.taskId
      const cleanup = typeof request === 'string' ? false : (request.cleanup ?? false)
      if (typeof taskId !== 'string' || taskId.length === 0) {
        return { result: 'not-found' }
      }
      return deps.transfer.cancel(taskId, cleanup)
    }
  )

  ipcMain.handle('hpc:probe', async (_event, request: ProbeRequest | undefined): Promise<ProbeResponse> => {
    const startedAt = Date.now()
    const configPath = deps.configPath()

    let loaded
    try {
      loaded = loadProfiles(configPath)
    } catch (err) {
      return { ok: false, totalMs: Date.now() - startedAt, error: toPlainError(err) }
    }

    let profile
    try {
      profile = deps.profileState.current(loaded, request?.profileId)
    } catch (err) {
      return { ok: false, totalMs: Date.now() - startedAt, error: toPlainError(err) }
    }

    const summary = {
      id: profile.id,
      label: profile.label,
      host: profile.host,
      port: profile.port,
      username: profile.username
    }

    try {
      const capabilities = await deps.pool.run(profile, (session) => probeCapabilities(session, profile))
      deps.cache.set(capabilityCacheKey(profile.id), {
        capabilities,
        savedAt: new Date().toISOString()
      })
      return { ok: true, totalMs: Date.now() - startedAt, profile: summary, capabilities, warnings: loaded.warnings }
    } catch (err) {
      return {
        ok: false,
        totalMs: Date.now() - startedAt,
        profile: summary,
        error: toPlainError(err),
        warnings: loaded.warnings
      }
    }
  })

  /*
   * —— 跳板机切换 ——
   *
   * 后端一直是多 profile 的（连接池按 id 分槽、pickProfile 支持 id），
   * 只是渲染层从来没传过 id。现在把"当前用哪台"收进 `deps.profileState`，
   * 渲染层只负责"切"，不再需要知道 id。
   */

  ipcMain.handle('connection:list-profiles', (): ListProfilesResponse => {
    try {
      return { ok: true, ...deps.profileState.list() }
    } catch (err) {
      return { ok: false, error: toPlainError(err) }
    }
  })

  ipcMain.handle('connection:get-active', (): { activeId: string | null } => {
    try {
      return { activeId: deps.profileState.activeId() }
    } catch {
      // 配置读不出来时界面不该崩，只是显示"未知"
      return { activeId: null }
    }
  })

  /**
   * 切换跳板机。
   *
   * 顺序是刻意的：**先确认能不能切，再动状态，最后才拆旧连接**。
   * 反过来（先拆再校验）会让一次失败的切换把用户正在用的连接搞没。
   */
  ipcMain.handle('connection:set-active', async (_event, request: { id?: string }): Promise<SetActiveResponse> => {
    const id = typeof request?.id === 'string' ? request.id.trim() : ''

    /*
     * ① 先判断能不能切。**顺序是刻意的**：先校验再动状态，
     * 反过来会让一次失败的切换把用户正在用的连接搞没。
     *
     * 判断逻辑在 `switchBlocker`（纯函数，可单测）——这里只负责把它的结论翻译成 IPC 结果。
     */
    let sameAsCurrent = false
    try {
      sameAsCurrent = deps.profileState.activeId() === id
    } catch {
      // 配置读不出来：交给下面的 set() 去抛真正的错误
    }

    const blocker = switchBlocker({
      targetId: id,
      sameAsCurrent,
      transferActive: deps.transfer.hasActive()
    })
    if (blocker) {
      return {
        ok: false,
        error: {
          kind: id.length === 0 ? 'config' : 'busy',
          message: blocker,
          raw: 'switch blocked'
        }
      }
    }

    let result: ReturnType<typeof deps.profileState.set>
    try {
      // ② 校验 id 并写状态；id 不存在时这里抛 ConfigError，且**不会写坏已有选择**
      result = deps.profileState.set(id)
    } catch (err) {
      return { ok: false, error: toPlainError(err) }
    }

    if (result.previous.id === result.next.id) {
      return { ok: true, activeId: result.next.id }
    }

    // ③ 拆掉挂在旧机器上的一切。顺序：终端 → 隧道 → 连接
    const terminals = deps.terminals.list().length
    deps.terminals.closeAll()

    const tunnelCount = deps.tunnels.list().length
    deps.tunnels.closeAll()

    const reverseCount = deps.reverseTunnels.list().length
    deps.reverseTunnels.closeAll()

    // 8 秒 TTL 的远端目录缓存里全是旧机器的路径，留着会让用户看到别人的目录
    clearListingCache()

    const dropped = await deps.pool.drop(result.previous.id, result.next.id)

    return {
      ok: true,
      activeId: result.next.id,
      // 让界面能明确告诉用户"为了切换断了什么"，而不是悄悄关掉
      closed: { terminals, tunnels: tunnelCount + reverseCount, connections: dropped }
    }
  })
}
