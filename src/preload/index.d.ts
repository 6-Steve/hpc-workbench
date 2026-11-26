/**
 * 渲染层可见的 API 形状（全局声明，渲染层直接用，不需要 import）。
 *
 * 这份声明是 preload 白名单在类型系统里的镜像。新增 IPC 方法时，
 * main/ipc.ts、preload/index.ts、这里三处要同时加。
 */

interface PlainError {
  kind: string
  message: string
  hint?: string
  raw: string
  code?: string
  issues?: string[]
}

interface AppInfo {
  name: string
  version: string
  platform: string
  arch: string
  versions: { electron: string; node: string; chrome: string }
  configPath: string
  configExists: boolean
}

/** 配置目录现状。`source` 决定界面上显示"便携模式/自定义/默认/环境变量" */
interface ConfigDirInfo {
  dir: string
  source: 'env' | 'custom' | 'portable' | 'default'
  /** 便携模式会用的目录（`<程序目录>/config`） */
  portableDir: string
  /** 兜底目录（`%APPDATA%/<productName>/config`） */
  defaultDir: string
  appRoot: string
  mode: 'auto' | 'custom' | 'portable'
  customDir?: string
  /** 程序目录里有 config 但写不进去时，已退回默认 */
  fallback?: 'portable-not-writable'
  /** 由环境变量决定——按钮要禁用，改了不会生效 */
  readonly: boolean
}

/** 首次向导的表单内容（与 `src/shared/setup.ts` 的 `SetupDraft` 一致） */
interface SetupDraft {
  label: string
  host: string
  port: string
  username: string
  method: 'key' | 'password'
  privateKeyPath: string
  passphrase: string
  password: string
}

interface SetupIssue {
  field:
    | 'label'
    | 'host'
    | 'port'
    | 'username'
    | 'privateKeyPath'
    | 'passphrase'
    | 'password'
    | 'general'
  message: string
}

interface SetupResult {
  ok: boolean
  issues?: SetupIssue[]
  /** 写成功的配置文件绝对路径 */
  configPath?: string
  /** 配置写好了但密码没进钥匙串之类 */
  warnings?: string[]
  /** 目录变了 → 要重启才对所有服务生效 */
  restartRequired: boolean
}

/** `~/.ssh/config` 里的一台主机 */
interface SshImportHost {
  alias: string
  hostName: string
  user?: string
  port?: number
  identityFile?: string
  proxyJump?: string
  /** 展开后的私钥绝对路径 */
  identityAbsolute?: string
  keyExists?: boolean
  /** 私钥带口令——向导要提示填口令 */
  keyEncrypted?: boolean
}

interface SshImportResult {
  dir: string
  configPath: string
  found: boolean
  hosts: SshImportHost[]
  /** 同目录下的私钥候选 */
  keys: Array<{ path: string; name: string; encrypted: boolean }>
  warnings: string[]
}

/** 一次测速结果：四段耗时 + 判读。字段与 `src/shared/latency.ts` 对应 */
interface ProfileLatency {
  profileId: string
  at: number
  tcpMs: number | null
  sshdMs: number | null
  authMs: number | null
  execMs: number | null
  totalMs: number | null
  /** 卡在哪一段（超时才有）；此时前面几段的数字仍然有效 */
  timedOutAt?: 'tcp' | 'sshd' | 'auth' | 'exec'
  failure?:
    | 'unreachable'
    | 'auth-failed'
    | 'exec-failed'
    | 'unknown-host'
    | 'hostkey-mismatch'
    | null
  error?: string
  verdict:
    | 'ok'
    | 'network-slow'
    | 'sshd-busy'
    | 'auth-slow'
    | 'exec-slow'
    | 'timeout'
    | 'unreachable'
    | 'auth-failed'
    | 'exec-failed'
    | 'unknown-host'
    | 'hostkey-mismatch'
    | 'unknown'
  headline: string
  detail: string
}

interface ProbeEvidence {
  command: string
  code: number | null
  stderr: string
  durationMs: number
  truncated: boolean
}

interface Capabilities {
  profileId: string
  host: string
  username: string
  sinfoJson: boolean
  squeueJson: boolean
  sacctJson: boolean
  scontrolJson: boolean
  slurmVersion: string | null
  slurmVersionNumber: string | null
  os: string | null
  home: string | null
  sbatchAvailable: boolean
  quotaCommand: string
  quotaToolFound: boolean
  probedAt: string
  durationMs: number
  notes: string[]
  evidence: Record<string, ProbeEvidence>
}

interface ProbeResponse {
  ok: boolean
  totalMs: number
  profile?: { id: string; label: string; host: string; port: number; username: string }
  capabilities?: Capabilities
  error?: PlainError
  warnings?: string[]
}

/** 一条可切换的跳板机。**不含 auth**：私钥路径不出主进程 */
interface ProfileSummary {
  id: string
  label: string
  host: string
  port: number
  username: string
  /** profiles.json 里 defaultProfile 指的那条 */
  isDefault: boolean
}

interface ListProfilesResponse {
  ok: boolean
  profiles?: ProfileSummary[]
  activeId?: string
  error?: PlainError
}

interface SetActiveResponse {
  ok: boolean
  activeId?: string
  /** 为了这次切换断掉了什么（终端 / 隧道 / 连接） */
  closed?: { terminals: number; tunnels: number; connections: number }
  error?: PlainError
}

interface DirEntry {
  name: string
  kind: 'file' | 'dir' | 'link' | 'other'
  size: number | null
  mtime: number | null
}

interface DirListing {
  side: 'local' | 'remote'
  path: string
  parent: string | null
  separator: string
  entries: DirEntry[]
  truncated: boolean
  /** 虚拟根（本地「此电脑」）：里面的条目是盘符，不是普通目录 */
  virtualRoot?: boolean
}

interface ListDirResponse {
  ok: boolean
  listing?: DirListing
  error?: PlainError
}

interface PathStats {
  fileCount: number
  dirCount: number
  totalBytes: number
  largestFileBytes: number
  truncated: boolean
}

interface StrategyDecision {
  strategy: 'sftp' | 'tar' | 'multistream'
  effective: 'sftp' | 'tar'
  avgBytes: number
  reason: string
  warnings: string[]
}

interface PlanItem {
  name: string
  kind: 'file' | 'dir'
  source: string
  target: string
  stats: PathStats
}

interface TransferPlan {
  id: string
  direction: 'upload' | 'download'
  targetDir: string
  items: PlanItem[]
  stats: PathStats
  decision: StrategyDecision
  summary: string
  warnings: string[]
  unsupported: Array<{ name: string; reason: string }>
  createdAt: number
  /** copy = 原样传；sync = 只传变更（`items` 里只有需要传的文件） */
  mode?: 'copy' | 'sync'
  /** 仅 sync 有：比对结果摘要 */
  sync?: SyncSummary
}

interface SyncSummary {
  counts: { new: number; update: number; same: number; conflict: number; orphan: number }
  conflicts: Array<{ rel: string; reason?: string }>
  /** 变更太多，建议改用整包 */
  suggestFull: boolean
  suggestions: string[]
  sourceRoot: string
  targetRoot: string
}

interface TaskSnapshot {
  id: string
  direction: 'upload' | 'download'
  localPath: string
  remotePath: string
  label: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled'
  bytes: number
  totalBytes: number | null
  bytesPerSecond: number
  attempt: number
  error?: { message: string; hint?: string; raw?: string; retryable: boolean }
}

interface QueueSnapshot {
  tasks: TaskSnapshot[]
  running: number
  queued: number
  finished: number
  doneBytes: number
  totalBytes: number
}

interface PlanTransferResponse {
  ok: boolean
  plan?: TransferPlan
  error?: PlainError
}

interface StartTransferResponse {
  ok: boolean
  snapshot?: QueueSnapshot
  error?: PlainError
}

interface DeleteResponse {
  ok: boolean
  deleted: string[]
  failed: Array<{ path: string; error: PlainError }>
  error?: PlainError
}

interface RenameResponse {
  ok: boolean
  newPath?: string
  error?: PlainError
}

interface MkdirResponse {
  ok: boolean
  newPath?: string
  error?: PlainError
}

interface MoveResponse {
  ok: boolean
  /** 成功移动后的新路径 */
  moved: string[]
  /** 逐条失败的原因：批量操作要能说清哪几个没成 */
  failed: Array<{ path: string; error: PlainError }>
  error?: PlainError
}

interface PrepareDragResponse {
  ok: boolean
  /** 本地镜像路径，直接喂给 startDrag */
  localPath?: string
  /** true 表示命中缓存，没有下载 */
  cached?: boolean
  bytes?: number
  error?: PlainError
}

type NodeState =
  | 'idle'
  | 'mixed'
  | 'alloc'
  | 'completing'
  | 'down'
  | 'drain'
  | 'fail'
  | 'maint'
  | 'reserved'
  | 'unknown'

type JobState =
  | 'pending'
  | 'running'
  | 'suspended'
  | 'completing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'node-fail'
  | 'preempted'
  | 'out-of-memory'
  | 'requeued'
  | 'configuring'
  | 'unknown'

interface Job {
  id: string
  name: string
  user: string
  partition: string
  state: JobState
  rawState: string
  reason: string | null
  /** 排队原因的人话版本 */
  reasonText: string
  nodes: string | null
  nodeCount: number | null
  cpus: number | null
  timeLimitMinutes: number | null
  submitTime: number | null
  startTime: number | null
  gpusRequested: number | null
  /** 用户自己挂起的作业，必须和普通排队分开看 */
  heldByUser: boolean
}

interface GpuCount {
  type: string
  count: number
}

interface NodeInfo {
  name: string
  states: NodeState[]
  rawStates: string[]
  /** 维护/故障中，整台不计入库存。false 不等于有货 */
  blocked: boolean
  gpus: GpuCount[]
  gpusUsed: GpuCount[]
  cpus: number
  allocCpus: number
  idleCpus: number
  realMemoryMb: number
  allocMemoryMb: number
  /** null = 集群没给，不是 0 */
  freeMemoryMb: number | null
  partitions: string[]
}

interface SubmitJobRequest {
  mode: 'command' | 'script'
  /** 远端绝对路径 */
  scriptPath: string
  /** 仅 command 模式：要写入的脚本内容 */
  content?: string
  /** sbatch 参数（不含命令名和脚本路径） */
  args: string[]
  profileId?: string
}

interface DryRunResponse {
  ok: boolean
  /** 集群返回的原始时间串（不带时区），如 2026-11-03T08:45:28 */
  startAt?: string | null
  nodes?: string | null
  processors?: number | null
  raw?: string
  error?: PlainError
}

interface SubmitJobResponse {
  ok: boolean
  jobId?: string
  /** 实际提交的命令，方便排查 */
  command?: string
  error?: PlainError
}

interface GpuPrice {
  host: string
  type: string
  /** 点/小时 */
  cost: number
  /** 该行给出的空闲卡数，仅供参考，不当库存真值 */
  freeGpus: number | null
  freeCpus: number | null
  freeMemoryGb: number | null
}

interface TerminalOpenResponse {
  ok: boolean
  sessionId?: string
  error?: PlainError
}

interface TerminalClosedPayload {
  sessionId: string
  code: number | null
  signal: string | null
  reason: string
}

interface TunnelInfo {
  id: string
  /** local = 本机监听转发到集群；reverse = 集群监听转发回本机 */
  direction: 'local' | 'reverse'
  label: string
  /** 目标：本地转发是集群上的服务；反向转发是你本机的服务 */
  targetHost: string
  targetPort: number
  /** 监听端口：本地转发在本机，反向转发在集群登录节点 */
  listenPort: number
  /** 只有 local 有能打开的地址；reverse 为 null */
  url: string | null
  openedAt: number
  connections: number
  bytesIn: number
  bytesOut: number
  lastError: string | null
  /** 底下的 SSH 连接还在不在。false = 集群侧监听端口已经没了，正在自动重连 */
  connected: boolean
  /** 这条隧道建在哪台跳板机上（两台登录节点会各有一条同名端口，靠它区分） */
  profileId?: string
  profileLabel?: string
}

interface TunnelFallback {
  requested: number
  actual: number
  owner: { uid: number; username: string | null } | null
  /** 占着端口的账号就是你自己（多半是已经开着一条同端口的隧道） */
  ownerIsSelf?: boolean
}

interface TunnelStartResponse {
  ok: boolean
  tunnel?: TunnelInfo
  /** 默认端口被占、退到了别的端口时才有 */
  fallback?: TunnelFallback | null
  /** 集群上 http_proxy 指向的端口；和 tunnel.listenPort 不一致说明白开了 */
  proxyPort?: number | null
  error?: PlainError
}

interface TunnelListResponse {
  ok: boolean
  tunnels?: TunnelInfo[]
  error?: PlainError
}

interface EgressProbe {
  ip: string | null
  error: string | null
}

interface TunnelVerifyResponse {
  ok: boolean
  cluster?: EgressProbe
  local?: EgressProbe
  /** true = 两边出口相同；null = 有一边没测出来，无法判断 */
  same?: boolean | null
  /** true = 探测期间这条隧道的计数器涨了（字节确实穿过了本机） */
  moved?: boolean | null
  error?: PlainError
}

interface PointsResponse {
  ok: boolean
  points?: { total: number; used: number; avail: number }
  durationMs?: number
  error?: PlainError
}

/** 一条点数消耗记录 = 一个作业（scir-account details） */
interface PointsUsageRow {
  jobId: string
  jobName: string
  /** 实际计费时长（小时）；运行中的作业是"到目前为止" */
  hours: number
  /** 申请时长上限（小时） */
  limitHours: number
  points: number
  /** `-r` 才有的 Resources 原串 */
  resources: string | null
  gpuType: string | null
  gpuCount: number | null
  /** SLURM 计费权重，不是点数 */
  billing: number | null
}

interface PointsUsage {
  rows: PointsUsageRow[]
  totals: { total: number; used: number; avail: number } | null
  /**
   * 逐条相加的结果与它和 `totals.used` 的差。
   * **差值非零是正常的**（每条只给 2 位小数，平台自己舍入过）。
   */
  sum: { points: number; diff: number | null }
}

interface PointsUsageResponse {
  ok: boolean
  usage?: PointsUsage
  durationMs?: number
  error?: PlainError
}

interface PointsTransferRequest {
  target: string
  points: number
  /** 几个月后到期（1 号），对应 --month */
  month: number
  /** 当场输入的密码；留空并传 useStoredPassword 时由主进程自己从凭据库取 */
  password?: string
  /** 用已保存的平台账号密码（明文就不经过渲染层了） */
  useStoredPassword?: boolean
  profileId?: string | null
}

interface PointsTransferResponse {
  ok: boolean
  /** 平台回的那行 Transfer Status */
  message?: string
  /** 转账后重查的余额，是最可信的证据 */
  points?: { total: number; used: number; avail: number }
  durationMs?: number
  error?: PlainError
}

interface GpuPriceResponse {
  ok: boolean
  prices?: GpuPrice[]
  durationMs?: number
  error?: PlainError
}

/** 凭据种类。scope 的含义随种类变，见 main/credentials/types.ts */
type CredentialKindName = 'ssh-password' | 'key-passphrase' | 'platform-password'

interface CredentialsStatus {
  /** 系统钥匙串能不能用。false 时只能"本次运行记住" */
  available: boolean
  /** 后端名字，如「Windows 数据保护（DPAPI）」 */
  backend: string
  stored: number
  sessionOnly: number
}

interface CredentialItemView {
  kind: CredentialKindName
  scope: string
  /** 路径只留最后两段，避免撑破设置页 */
  display: string
  label: string
  savedAt: string | null
  sessionOnly: boolean
}

interface CredentialsStatusResponse {
  ok: boolean
  status?: CredentialsStatus
  error?: PlainError
}

interface CredentialTargetView {
  kind: CredentialKindName
  scope: string
  display: string
  ownerLabel: string
  configured: boolean
  /** true = 不填也能正常登录（私钥不带口令是常态） */
  optional?: boolean
}

interface CredentialsListResponse {
  ok: boolean
  status?: CredentialsStatus
  items?: CredentialItemView[]
  /** 可以设凭据的位置（scope 已由主进程算好，界面只回传） */
  targets?: CredentialTargetView[]
  /** 配置文件里还写着明文的字段 */
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

interface CredentialsSetRequest {
  kind: CredentialKindName
  scope: string
  /** 明文密码。只在这一次调用里存在 */
  secret: string
  /** false = 只在本次运行内记住；默认 true */
  persist?: boolean
}

interface CredentialsSetResponse {
  ok: boolean
  persisted?: boolean
  /** 失败原因（已经是人话） */
  reason?: string
}

interface CredentialsTestRequest {
  kind: CredentialKindName
  scope: string
  /** 不传就测库里存的那条 */
  secret?: string
  profileId?: string | null
}

interface CredentialsTestResponse {
  outcome: {
    /** ok = 密码对；wrong = 密码错；unreachable = 连不上，判不了；unsupported = 测不了 */
    status: 'ok' | 'wrong' | 'unreachable' | 'unsupported'
    message: string
    /** 平台/ssh2 原文，折叠展示 */
    detail?: string
  }
}

interface QuotaDimension {
  used: number
  /** soft 为 null 表示没设软限 */
  soft: number | null
  hard: number | null
  /** 尚未结算的量，非零是正常的 */
  inDoubt: number
  /** 'none' / '7 days' / 'expired' */
  grace: string
}

interface Quota {
  filesystem: string
  type: string
  bytes: QuotaDimension
  files: QuotaDimension
  remarks: string
}

interface QuotaResponse {
  ok: boolean
  quotas?: Quota[]
  durationMs?: number
  error?: PlainError
}

interface GpuTypeStock {
  type: string
  /** 翻译成人话的型号名，如「A100 80GB」 */
  label: string
  total: number
  used: number
  free: number
  nodeCount: number
  freeNodes: string[]
}

interface InventoryPayload {
  gpuTypes: GpuTypeStock[]
  usableNodes: NodeInfo[]
  blockedNodes: NodeInfo[]
  totals: {
    nodes: number
    usableNodes: number
    gpuTotal: number
    gpuFree: number
    idleCpus: number
  }
}

interface JobLogResponse {
  ok: boolean
  content?: string
  path?: string
  /** 路径是怎么定下来的：scontrol 精确值 / sacct 推断 */
  source?: 'scontrol' | 'sacct'
  tried?: string[]
  error?: PlainError
}

/** 单个作业的详情（scontrol show job --json） */
interface JobDetail {
  id: string
  name: string
  state: JobState
  rawState: string
  stateReason: string | null
  stateReasonText: string
  user: string
  partition: string
  nodes: string | null
  nodeCount: number | null
  cpus: number | null
  memoryMb: number | null
  gpus: number | null
  gpuDetail: string[]
  timeLimitMinutes: number | null
  submitTime: number | null
  startTime: number | null
  endTime: number | null
  workDir: string | null
  /** 精确的输出文件路径；sacct 兜底时为 null */
  stdoutPath: string | null
  stderrPath: string | null
  command: string | null
  exitCode: string | null
  derivedExitCode: string | null
  tresAlloc: string | null
  tresReq: string | null
}

interface JobDetailResponse {
  ok: boolean
  detail?: JobDetail
  source?: 'scontrol' | 'sacct'
  error?: PlainError
}

interface JobLogStreamStart {
  ok: boolean
  streamId?: string
  path?: string
  source?: 'scontrol' | 'sacct'
  tried?: string[]
  error?: PlainError
}

interface NodeJob {
  id: string
  user: string
  cpus: number
  /** 占用的 GRES；纯 CPU 作业是 null */
  gres: string | null
  /** 集群返回的结束时间字符串；null 表示没设时限 */
  endTime: string | null
  name: string
}

interface NodeJobsResponse {
  ok: boolean
  jobs?: NodeJob[]
  error?: PlainError
}

interface NodesListResponse {
  ok: boolean
  inventory?: InventoryPayload
  durationMs?: number
  error?: PlainError
}

interface JobHistory {
  id: string
  name: string
  partition: string
  state: JobState
  rawState: string
  stateReason: string | null
  exitStatus: string | null
  exitReturnCode: number | null
  elapsedSeconds: number | null
  startTime: number | null
  endTime: number | null
  submitTime: number | null
  nodes: string | null
  nodeCount: number | null
  cpus: number | null
  gpus: number | null
  timeLimitMinutes: number | null
  qos: string | null
  /** 作业提交时的工作目录，用来定位日志 */
  workDir: string | null
  /** 状态说失败、退出码却是 0：sacct 看不出根因，得去看 .out 日志 */
  exitCodeMisleading: boolean
}

interface JobsHistoryResponse {
  ok: boolean
  jobs?: JobHistory[]
  durationMs?: number
  error?: PlainError
}

interface JobsListResponse {
  ok: boolean
  jobs?: Job[]
  durationMs?: number
  error?: PlainError
}

interface JobCancelResponse {
  ok: boolean
  error?: PlainError
}

interface HpcApi {
  /**
   * preload 接口版本。渲染层拿它和 `PRELOAD_API_VERSION` 比对，
   * 不一致说明窗口里的 preload 是旧的（改 preload 不会热更新），
   * 新加的方法会报 `is not a function`。
   *
   * 声明成可选是故意的：旧 preload 上这个字段根本不存在。
   */
  readonly apiVersion?: number
  appInfo(): Promise<AppInfo>
  /**
   * 在资源管理器里打开目录。`which` 只接受 `'current'`（当前生效的配置目录）
   * 或 `'appRoot'`（程序所在目录，便携模式往里放 config 用）。
   */
  openConfigDir(
    which?: 'current' | 'appRoot' | 'profileFile'
  ): Promise<{ ok: boolean; path: string; error?: string }>
  /** 备份 `profiles.json` 后重启，重新进入首次配置向导（凭据不动） */
  resetConfig(): Promise<{ ok: boolean; error?: string; backup?: string }>
  /**
   * 配置目录现状。
   *
   * `source` 是**必须显示**的：`portable`（程序目录）/ `custom`（自己选的）/
   * `default`（%APPDATA%）/ `env`（环境变量，此时按钮要禁用）。
   */
  configDir(): Promise<ConfigDirInfo>
  /** 选一个目录。取消时返回 `{ ok: false }` */
  pickConfigDir(): Promise<{ ok: boolean; path?: string }>
  /** 换配置目录。成功返回 `{ ok: true }` 后应用会**自动重启**，不是热切换 */
  setConfigDir(request: {
    mode: 'auto' | 'custom' | 'portable'
    dir?: string
  }): Promise<{ ok: boolean; error?: string }>
  /** 首次向导：生成 `profiles.json` 并存入凭据 */
  applyInitialSetup(request: {
    draft: SetupDraft
    /** 一起写入的其它主机（从 SSH 配置勾选进来的） */
    extras?: SetupDraft[]
    mode: 'auto' | 'custom' | 'portable'
    dir?: string
    /**
     * 隧道默认端口，和配置**同一次写盘**。
     *
     * 不能让渲染层事后再单独调 `setTunnelDefaults`：向导第一步可能已经换了
     * 配置目录，那时主进程的 store 还指着旧目录，端口会存进重启后读不到的地方。
     */
    tunnel?: { remotePort: number; localPort: number }
  }): Promise<SetupResult>
  /** 重启应用。`restartRequired` 为真时调它（会先松单实例锁） */
  relaunch(): Promise<{ ok: boolean }>
  /** 读 `~/.ssh/config`（可传目录或文件路径）并解析成可导入的主机列表 */
  readSshConfig(target?: string): Promise<SshImportResult>
  /** 选 SSH 配置文件或目录 */
  pickSshConfig(): Promise<{ ok: boolean; path?: string }>
  /** 读关窗策略；传 mode 则先写再读 */
  residency(mode?: 'quit' | 'when-busy' | 'always'): Promise<{
    ok: boolean
    mode: 'quit' | 'when-busy' | 'always'
  }>
  /** 有没有传输或隧道在跑（决定"关窗是否会驻留"） */
  activity(): Promise<{ ok: boolean; active: boolean }>
  /** 取一台主机的可编辑字段 */
  profileDetail(id: string): Promise<{
    ok: boolean
    profile?: {
      id: string
      label: string
      host: string
      port: number
      username: string
      auth: { method: 'key' | 'password'; privateKeyPath?: string }
      /** 钥匙串里有没有这个主机对应的密码 */
      hasPassword: boolean
    }
    error?: PlainError
  }>
  /** 改一台主机。`id` 不可改；`password` 不传表示不动钥匙串里的旧密码 */
  updateProfile(patch: {
    id: string
    label: string
    host: string
    port: number
    username: string
    auth: { method: 'key' | 'password'; privateKeyPath?: string }
    password?: string
  }): Promise<{
    ok: boolean
    changed?: boolean
    /** 改之前的连接参数，用来判断要不要提醒重连 */
    previous?: { label: string; host: string; port: number; username: string; method: string }
    error?: PlainError
  }>
  /** 导出诊断包（打开保存框）。`includeProbe` 才会顺便测一次连接 */
  exportDiagnostics(request?: { includeProbe?: boolean }): Promise<{
    ok: boolean
    path?: string
    /** 未压缩的内容字节数 */
    bytes?: number
    files?: string[]
    /** 超限导致没带完整输出 */
    truncated?: boolean
    /** 采集失败的小节（包仍然生成） */
    failed?: Array<{ name: string; error: string }>
    error?: PlainError
  }>
  /** 在文件管理器里定位到某个文件 */
  revealPath(target: string): Promise<{ ok: boolean }>
  /** 反向隧道默认端口。首次没配过时返回 21056 / 7897 */
  tunnelDefaults(): Promise<{ remotePort: number; localPort: number }>
  /**
   * 测一台跳板机的连接耗时。
   *
   * 默认走 5 分钟缓存；`force: true` 强制重测。同一时刻只允许测一台，
   * 另一台在测时会返回 `ok:false` + `error.kind === 'busy'`。
   */
  profileLatency(request?: {
    profileId?: string
    force?: boolean
  }): Promise<{ ok: boolean; latency?: ProfileLatency; cached?: boolean; error?: PlainError }>
  /** 保存隧道默认端口（主进程校验） */
  setTunnelDefaults(request: {
    remotePort: number
    localPort: number
  }): Promise<{ ok: boolean; error?: string; saved?: { remotePort: number; localPort: number } }>
  /**
   * 启动页的三步检查：配置文件 → 连接 → 队列。
   *
   * 失败时**停在出错那一步**，后面的不执行，并给出 `hint`。
   * 与 `probe()` 的区别：这个只发两条命令（毫秒级），探针要跑 9 条（秒级）。
   */
  bootStatus(request?: { profileId?: string }): Promise<BootStatus>
  /**
   * 从拖进来的 File 取真实磁盘路径。取不到返回空串。
   * Electron 32+ 已移除 `File.path`，必须用这个。
   */
  getPathForFile(file: File): string
  probe(request?: { profileId?: string }): Promise<ProbeResponse>
  /**
   * 跳板机切换。
   *
   * 这两条**不需要传 profileId**——主进程有唯一的当前 profile，
   * 切一次全部生效。只有诊断页想单独探另一台机器时才用 `probe({ profileId })`。
   */
  listProfiles(): Promise<ListProfilesResponse>
  getActiveProfile(): Promise<{ activeId: string | null }>
  setActiveProfile(request: { id: string }): Promise<SetActiveResponse>
  listDir(request: {
    side: 'local' | 'remote'
    path?: string
    /** 跳过缓存强制重读（刷新按钮 / 写操作之后用） */
    noCache?: boolean
    profileId?: string
  }): Promise<ListDirResponse>
  planTransfer(request: {
    direction: 'upload' | 'download'
    paths: string[]
    targetDir: string
    /** sync = 先比对再传（只接受单个目录，只增不删） */
    mode?: 'copy' | 'sync'
    sync?: { overwriteNewer?: boolean; force?: boolean }
  }): Promise<PlanTransferResponse>
  startTransfer(request: {
    planId: string
    onConflict?: 'fail' | 'skip' | 'overwrite' | 'rename'
  }): Promise<StartTransferResponse>
  /**
   * 取消传输。
   *
   * - `removed` → 排队中的任务，已从队列拿掉，**没有残留文件**
   * - `aborted` → 运行中的任务，已中断；`bytesDone` 是停下时的字节数，
   *   `partialPath` 是留在磁盘上的半截文件（`cleanup: true` 时会被删掉）
   * - `not-found` → 任务已经结束或不存在
   */
  cancelTransfer(request: { taskId: string; cleanup?: boolean }): Promise<
    | { result: 'removed' }
    | { result: 'aborted'; bytesDone: number; partialPath?: string }
    | { result: 'not-found' }
  >
  onTransferUpdate(listener: (snapshot: QueueSnapshot) => void): void
  /** 删除：本地走系统回收站，远端直接删（主进程有危险路径护栏） */
  deletePaths(request: {
    side: 'local' | 'remote'
    paths: string[]
    /** 仅本地：绕过回收站永久删除，只能在前一次失败后由用户二次确认触发 */
    permanent?: boolean
    profileId?: string
  }): Promise<DeleteResponse>
  renamePath(request: {
    side: 'local' | 'remote'
    path: string
    newName: string
    profileId?: string
  }): Promise<RenameResponse>
  makeDir(request: {
    side: 'local' | 'remote'
    parent: string
    name: string
    profileId?: string
  }): Promise<MkdirResponse>
  /** 把本地路径复制到某个目录 */
  copyLocal(request: {
    paths: string[]
    targetDir: string
  }): Promise<{ ok: boolean; copied: string[]; failed: Array<{ path: string; error: PlainError }> }>
  /**
   * 移动/剪切一批路径到某个目录（保留原名）。
   * 目标同名一律拒绝，不覆盖；批量时逐条报失败。
   */
  movePaths(request: {
    side: 'local' | 'remote'
    paths: string[]
    targetDir: string
    profileId?: string
  }): Promise<MoveResponse>
  /** 我的作业队列 */
  listJobs(request?: { profileId?: string }): Promise<JobsListResponse>
  /** 预估作业何时能开始（不占资源） */
  dryRunJob(request: SubmitJobRequest): Promise<DryRunResponse>
  /** 读作业输出日志（最后 200 行，一次性） */
  readJobLog(request: {
    jobId: string
    jobName?: string | null
    workDir?: string | null
    profileId?: string
  }): Promise<JobLogResponse>
  /** 作业详情；scontrol 查不到时退回 sacct 的历史记录 */
  readJobDetail(request: { jobId: string; profileId?: string }): Promise<JobDetailResponse>
  /** 开始跟随日志（tail -F）。返回 streamId 后靠 onJobLogChunk 收增量 */
  startJobLog(request: {
    jobId: string
    jobName?: string | null
    workDir?: string | null
    profileId?: string
  }): Promise<JobLogStreamStart>
  /** 停止跟随。远端 tail 会被 TERM 掉，不留孤儿进程 */
  stopJobLog(streamId: string): Promise<{ ok: boolean }>
  /** 跟随日志的增量文本（主进程已按 120ms 合并，不要在这里再做节流） */
  onJobLogChunk(listener: (payload: { streamId: string; text: string }) => void): void
  /** 跟随结束。`aborted` 为 true 表示是本地停的，不是远端自己结束 */
  onJobLogEnd(
    listener: (payload: { streamId: string; aborted: boolean; code: number | null; reason: string }) => void
  ): void
  /** 提交作业 */
  submitJob(request: SubmitJobRequest): Promise<SubmitJobResponse>
  /** 开一个交互式终端（登录节点上的 PTY） */
  openTerminal(request?: { cols?: number; rows?: number; profileId?: string }): Promise<TerminalOpenResponse>
  /** 键盘输入；用 send，不回执 */
  writeTerminal(sessionId: string, data: string): void
  /** 同步 PTY 的行列数 */
  resizeTerminal(sessionId: string, cols: number, rows: number): void
  closeTerminal(sessionId: string): Promise<{ ok: boolean }>
  /** 终端输出（主进程已按 16ms 合并） */
  onTerminalData(listener: (payload: { sessionId: string; text: string }) => void): void
  /** 终端会话结束 */
  onTerminalClosed(listener: (payload: TerminalClosedPayload) => void): void
  /** 开一条端口转发；返回时本地端口已在监听 */
  startTunnel(request: {
    remoteHost: string
    remotePort: number
    localPort?: number
    label?: string
    profileId?: string
  }): Promise<TunnelStartResponse>
  /**
   * 开一条**反向**隧道（集群监听 → 转发回本机）。
   * 集群侧只绑 127.0.0.1；绑定失败会立刻报错，不会假装成功。
   */
  startReverseTunnel(request: {
    remotePort: number
    localPort: number
    localHost?: string
    label?: string
    profileId?: string
  }): Promise<TunnelStartResponse>
  /** 关掉一条隧道，本地端口会被释放 */
  stopTunnel(id: string): Promise<{ ok: boolean }>
  /** 当前所有隧道 */
  listTunnels(): Promise<TunnelListResponse>
  /** 集群上 http_proxy 指向的端口；null = 读不到（没配置或连不上） */
  proxyPort(request?: { profileId?: string }): Promise<{ ok: boolean; port?: number | null; error?: PlainError }>
  /** 实测一条反向隧道通不通：集群经隧道取出口 IP，本机经 Clash 取一次，两边比对 */
  verifyTunnel(request: {
    port: number
    localPort?: number
    profileId?: string
    /** 传了才能用隧道计数器作为「流量确实回到本机」的硬证据 */
    tunnelId?: string
  }): Promise<TunnelVerifyResponse>
  /** 用系统浏览器打开本地地址（只放行 http(s)://127.0.0.1） */
  openLocalUrl(url: string): Promise<{ ok: boolean; reason?: string }>
  /** 弹系统通知；窗口在前台时主进程会跳过，返回 skipped */
  showNotification(request: { title: string; body?: string }): Promise<{
    ok: boolean
    skipped?: boolean
    reason?: string
  }>
  /** 点数余额（标题栏常驻） */
  getPoints(request?: { profileId?: string }): Promise<PointsResponse>
  /** 点数消耗明细（按作业逐条，来自 scir-account details -r） */
  getPointsUsage(request?: { profileId?: string }): Promise<PointsUsageResponse>
  /** 送点数。⚠️ 会真的扣点数；密码只用于这一次调用，不落盘 */
  transferPoints(request: PointsTransferRequest): Promise<PointsTransferResponse>
  /** 「让他人赠送点数」的说明文本，里面填的是自己的账号名 */
  getPointsGiftInstruction(request?: {
    points?: number
    month?: number
    profileId?: string
  }): Promise<{ ok: boolean; text?: string; error?: PlainError }>
  /** 显卡单价 */
  getPrices(request?: { profileId?: string }): Promise<GpuPriceResponse>
  /** 存储配额 */
  getQuota(request?: { profileId?: string }): Promise<QuotaResponse>

  /*
   * 登录凭据。
   *
   * 注意方向：`setCredential` 是渲染层 → 主进程送密码（加密后落盘）；
   * 主进程**永不**把密码回传，所以列表里只有 kind/scope/时间。
   */
  getCredentialsStatus(): Promise<CredentialsStatusResponse>
  listCredentials(): Promise<CredentialsListResponse>
  setCredential(request: CredentialsSetRequest): Promise<CredentialsSetResponse>
  removeCredential(request: { kind: CredentialKindName; scope: string }): Promise<{ ok: boolean; reason?: string }>
  /** 测密码对不对。platform-password 会真的发一次 0 点转账 */
  testCredential(request: CredentialsTestRequest): Promise<CredentialsTestResponse>
  /** 某台机器上正在跑谁的作业 */
  listNodeJobs(request: { nodeName: string; profileId?: string }): Promise<NodeJobsResponse>
  /** 节点库存 */
  listNodes(request?: { profileId?: string }): Promise<NodesListResponse>
  /** 历史作业（sacct） */
  listJobHistory(request?: { days?: number; profileId?: string }): Promise<JobsHistoryResponse>
  /** 取消作业 */
  cancelJob(jobId: string): Promise<JobCancelResponse>
  /** 拖拽镜像占用 */
  mirrorStats(): Promise<{ files: number; bytes: number }>
  /** 清空拖拽镜像，返回清掉了多少 */
  clearMirror(): Promise<{ files: number; bytes: number }>
  /** 本机栏默认目录；dir 为 null 表示用用户主目录 */
  getLocalStart(): Promise<{ dir: string | null }>
  /** 设置默认目录；传 null 恢复成用户主目录 */
  setLocalStart(dir: string | null): Promise<{ dir: string | null }>
  /** 弹系统目录选择框。用户取消时 ok 为 false */
  pickDirectory(): Promise<{ ok: boolean; path?: string }>
  /** 拖出第一步：把远端文件镜像到本地，返回可直接 startDrag 的路径 */
  prepareDrag(request: { path: string; profileId?: string }): Promise<PrepareDragResponse>
  /** 拖出第二步：系统接管拖拽 */
  startDrag(localPath: string): Promise<{ ok: boolean; error?: PlainError }>
  onDragProgress(listener: (progress: { bytes: number; total: number }) => void): void
  /** 命令记录：最近 N 条（只读） */
  traceList(): Promise<TraceListResponse>
  /** 某一条的完整输出；预览之外的部分只能靠它 */
  traceDetail(id: number): Promise<TraceDetailResponse>
  traceClear(): Promise<{ ok: true }>
  onTraceEntry(listener: (entry: TraceEntry) => void): void
  window: {
    minimize(): void
    toggleMaximize(): void
    close(): void
  }
}

interface TraceEntry {
  id: number
  at: number
  profileId: string
  host: string
  command: string
  code: number | null
  durationMs: number
  stdout: string
  stderr: string
  stdoutChars: number
  stderrChars: number
  truncated: boolean
  error: string | null
}

interface TraceRecord extends TraceEntry {
  fullStdout: string
  fullStderr: string
}

interface TraceListResponse {
  ok: true
  entries: TraceEntry[]
}

interface TraceDetailResponse {
  ok: boolean
  record?: TraceRecord
  error?: PlainError
}

interface Window {
  hpc: HpcApi
}

/** 启动页的状态（与 src/shared/boot.ts 同形，这里重声明是为了这份 d.ts 不依赖 import） */
type BootPhase = 'config' | 'connect' | 'queue'

interface BootStep {
  phase: BootPhase
  ok: boolean
  message: string
  hint?: string
  ms: number
}

interface BootStatus {
  ok: boolean
  steps: BootStep[]
  target?: string
  queue?: { total: number; running: number; pending: number }
  totalMs: number
  raw?: string
}
