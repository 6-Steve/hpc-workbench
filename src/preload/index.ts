/**
 * 窄接口桥：只暴露白名单方法，不给渲染层 Node 权限。
 * 需要加能力时，在 main/ipc.ts 里注册，再在这里显式列一条——
 * 不做"把 ipcRenderer 整个扔过去"那种图省事的写法。
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { PRELOAD_API_VERSION } from '../shared/api-version'

const api = {
  /**
   * preload 接口版本，渲染层用它判断"窗口里跑的是不是同一次编译的 preload"。
   * 不参与业务逻辑，见 `src/shared/api-version.ts`。
   */
  apiVersion: PRELOAD_API_VERSION,
  platform: process.platform,
  appInfo: (): Promise<unknown> => ipcRenderer.invoke('app:info'),
  /**
   * 在资源管理器里打开配置目录。
   * `which` 只接受 'current' | 'appRoot'，主进程不放行任意路径。
   */
  openConfigDir: (which?: 'current' | 'appRoot' | 'profileFile'): Promise<unknown> =>
    ipcRenderer.invoke('app:open-config-dir', which),
  /** 备份现有 profiles.json 并重启 → 重新进入首次配置向导 */
  resetConfig: (): Promise<unknown> => ipcRenderer.invoke('app:reset-config'),
  /** 配置目录现状：路径、来源（便携/自定义/默认/环境变量）、三个候选位置 */
  configDir: (): Promise<unknown> => ipcRenderer.invoke('app:config-dir'),
  /** 选一个目录（标题/按钮文案是"选配置目录"，别复用下载目录那个） */
  pickConfigDir: (): Promise<unknown> => ipcRenderer.invoke('app:pick-config-dir'),
  /** 换配置目录。成功后会**自动重启**应用（主进程负责） */
  setConfigDir: (request: { mode: 'auto' | 'custom' | 'portable'; dir?: string }): Promise<unknown> =>
    ipcRenderer.invoke('app:set-config-dir', request),
  /** 首次向导：写入 profiles.json + 凭据；`restartRequired` 为真时要调 `relaunch()` */
  applyInitialSetup: (request: unknown): Promise<unknown> => ipcRenderer.invoke('app:setup-apply', request),
  /** 读 `~/.ssh/config`（可传目录或文件路径），解析成可填入向导的主机列表 */
  readSshConfig: (target?: string): Promise<unknown> => ipcRenderer.invoke('app:ssh-config', target),
  /** 选 SSH 配置文件/目录 */
  pickSshConfig: (): Promise<unknown> => ipcRenderer.invoke('app:pick-ssh-config'),
  /** 反向隧道的默认端口（集群侧监听 / 本机代理） */
  tunnelDefaults: (): Promise<unknown> => ipcRenderer.invoke('app:tunnel-defaults'),
  /** 读/写关窗策略（托盘驻留） */
  residency: (mode?: string): Promise<unknown> => ipcRenderer.invoke('app:residency', mode),
  /** 有没有传输或隧道在跑 */
  activity: (): Promise<unknown> => ipcRenderer.invoke('app:activity'),
  /** 取一台主机的可编辑字段（编辑表单用；私钥内容永不出主进程） */
  profileDetail: (id: string): Promise<unknown> => ipcRenderer.invoke('profile:detail', id),
  /** 改一台主机；id 不可改，改完主进程会丢掉旧连接 */
  updateProfile: (patch: unknown): Promise<unknown> => ipcRenderer.invoke('profile:update', patch),
  /** 导出诊断包（会弹保存框）。任何一项采集失败都不影响整包 */
  exportDiagnostics: (request?: unknown): Promise<unknown> =>
    ipcRenderer.invoke('diag:export-bundle', request),
  /** 在文件管理器里定位到某个文件 */
  revealPath: (target: string): Promise<unknown> => ipcRenderer.invoke('diag:reveal', target),
  /** 测一台跳板机的连接耗时（四段拆分）。默认 5 分钟内复用上次结果 */
  profileLatency: (request?: unknown): Promise<unknown> => ipcRenderer.invoke('profile:latency', request),
  /** 保存隧道默认端口；校验在主进程做 */
  setTunnelDefaults: (request: { remotePort: number; localPort: number }): Promise<unknown> =>
    ipcRenderer.invoke('app:set-tunnel-defaults', request),
  /** 重启应用（先松单实例锁，不会出现"应用没了"） */
  relaunch: (): Promise<unknown> => ipcRenderer.invoke('app:relaunch'),
  /** 启动页三步检查：配置 → 连接 → 队列（见 src/shared/boot.ts） */
  bootStatus: (request?: { profileId?: string }): Promise<unknown> =>
    ipcRenderer.invoke('app:boot-status', request),
  probe: (request?: { profileId?: string }): Promise<unknown> => ipcRenderer.invoke('hpc:probe', request),
  /**
   * 跳板机切换（hpc 跳板机 01 / hpc-02）。
   *
   * 只有这三个方法涉及"当前用哪台"，其余方法**不需要也不应该**传 profileId：
   * 主进程那边有唯一的 `ProfileState`，切换一次全部生效。
   */
  listProfiles: (): Promise<unknown> => ipcRenderer.invoke('connection:list-profiles'),
  getActiveProfile: (): Promise<unknown> => ipcRenderer.invoke('connection:get-active'),
  /** 切换会断开终端与隧道；有传输在跑时主进程会拒绝并返回原因 */
  setActiveProfile: (request: { id: string }): Promise<unknown> =>
    ipcRenderer.invoke('connection:set-active', request),
  /**
   * 从拖进来的 `File` 对象取它的真实磁盘路径。
   *
   * Electron 32 起 `File.path` 被移除了（安全考虑），只能走 `webUtils.getPathForFile()`。
   * 这个 API **只能在预加载/渲染进程里调**，主进程拿不到 File 对象。
   * 取不到时返回空串而不是抛错——调用方要按空串处理，不要假设一定成功。
   */
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  listDir: (request: {
    side: 'local' | 'remote'
    path?: string
    noCache?: boolean
    profileId?: string
  }): Promise<unknown> => ipcRenderer.invoke('fs:list', request),
  /** 删除：本地进回收站，远端直接删（主进程有护栏） */
  deletePaths: (request: unknown): Promise<unknown> => ipcRenderer.invoke('fs:delete', request),
  renamePath: (request: unknown): Promise<unknown> => ipcRenderer.invoke('fs:rename', request),
  makeDir: (request: unknown): Promise<unknown> => ipcRenderer.invoke('fs:mkdir', request),
  /** 把本地路径复制到某个目录（集群拖到本机栏时用来落地） */
  copyLocal: (request: { paths: string[]; targetDir: string }): Promise<unknown> =>
    ipcRenderer.invoke('fs:copy-local', request),
  /** 移动/剪切一批路径到某个目录（保留原名，目标同名会拒绝） */
  movePaths: (request: unknown): Promise<unknown> => ipcRenderer.invoke('fs:move', request),
  /** 我的作业队列（squeue --me --json） */
  listJobs: (request?: { profileId?: string }): Promise<unknown> => ipcRenderer.invoke('jobs:list', request),
  /** 某台机器上正在跑谁的作业 */
  listNodeJobs: (request: { nodeName: string; profileId?: string }): Promise<unknown> =>
    ipcRenderer.invoke('nodes:jobs', request),
  /** 节点库存（scontrol show node --json 聚合后的结果） */
  listNodes: (request?: { profileId?: string }): Promise<unknown> => ipcRenderer.invoke('nodes:list', request),
  /** 预估作业何时能开始（--test-only，不占资源） */
  dryRunJob: (request: unknown): Promise<unknown> => ipcRenderer.invoke('jobs:dry-run', request),
  /** 读作业输出日志（最后 200 行，一次性） */
  readJobLog: (request: {
    jobId: string
    jobName?: string | null
    workDir?: string | null
    profileId?: string
  }): Promise<unknown> => ipcRenderer.invoke('jobs:log', request),
  /** 作业详情（scontrol show job --json，拿不到退回 sacct） */
  readJobDetail: (request: { jobId: string; profileId?: string }): Promise<unknown> =>
    ipcRenderer.invoke('jobs:detail', request),
  /** 开始跟随日志（tail -F），返回 streamId */
  startJobLog: (request: {
    jobId: string
    jobName?: string | null
    workDir?: string | null
    profileId?: string
  }): Promise<unknown> => ipcRenderer.invoke('jobs:log-start', request),
  /** 停止跟随；远端 tail 会被 TERM 掉 */
  stopJobLog: (streamId: string): Promise<unknown> => ipcRenderer.invoke('jobs:log-stop', streamId),
  /** 跟随日志的增量文本（主进程已按 120ms 合并） */
  onJobLogChunk: (listener: (payload: { streamId: string; text: string }) => void): void => {
    ipcRenderer.removeAllListeners('jobs:log-chunk')
    ipcRenderer.on('jobs:log-chunk', (_event, payload) => listener(payload))
  },
  /** 跟随结束（用户停止 / 远端退出 / 连接断开） */
  onJobLogEnd: (
    listener: (payload: { streamId: string; aborted: boolean; code: number | null; reason: string }) => void
  ): void => {
    ipcRenderer.removeAllListeners('jobs:log-end')
    ipcRenderer.on('jobs:log-end', (_event, payload) => listener(payload))
  },
  /** 提交作业（写脚本 + sbatch） */
  submitJob: (request: unknown): Promise<unknown> => ipcRenderer.invoke('jobs:submit', request),
  /** 开一个交互式终端（登录节点上的 PTY） */
  openTerminal: (request?: { cols?: number; rows?: number; profileId?: string }): Promise<unknown> =>
    ipcRenderer.invoke('terminal:open', request),
  /** 键盘输入。用 send 不用 invoke：输入要的是延迟，不要回执 */
  writeTerminal: (sessionId: string, data: string): void => {
    ipcRenderer.send('terminal:write', { sessionId, data })
  },
  /** 窗口尺寸变化时同步 PTY 的行列数 */
  resizeTerminal: (sessionId: string, cols: number, rows: number): void => {
    ipcRenderer.send('terminal:resize', { sessionId, cols, rows })
  },
  closeTerminal: (sessionId: string): Promise<unknown> => ipcRenderer.invoke('terminal:close', sessionId),
  /** 终端输出（主进程已按 16ms 合并） */
  onTerminalData: (listener: (payload: { sessionId: string; text: string }) => void): void => {
    ipcRenderer.removeAllListeners('terminal:data')
    ipcRenderer.on('terminal:data', (_event, payload) => listener(payload))
  },
  /** 终端会话结束 */
  onTerminalClosed: (
    listener: (payload: { sessionId: string; code: number | null; signal: string | null; reason: string }) => void
  ): void => {
    ipcRenderer.removeAllListeners('terminal:closed')
    ipcRenderer.on('terminal:closed', (_event, payload) => listener(payload))
  },
  /** 开一条端口转发（SSH 隧道），返回本地地址 */
  startTunnel: (request: {
    remoteHost: string
    remotePort: number
    localPort?: number
    label?: string
    profileId?: string
  }): Promise<unknown> => ipcRenderer.invoke('forward:start', request),
  /**
   * 开一条**反向**隧道（集群监听 → 转发回本机）。
   * 对应手敲的 `ssh -R 127.0.0.1:55555:127.0.0.1:7897 hpc`。
   */
  startReverseTunnel: (request: {
    remotePort: number
    localPort: number
    localHost?: string
    label?: string
    profileId?: string
  }): Promise<unknown> => ipcRenderer.invoke('forward:start-reverse', request),
  /** 关掉一条隧道，本地端口会被释放 */
  stopTunnel: (id: string): Promise<unknown> => ipcRenderer.invoke('forward:stop', id),
  /** 当前所有隧道 */
  listTunnels: (): Promise<unknown> => ipcRenderer.invoke('forward:list'),
  /** 集群上 http_proxy 指向的端口（读 ~/.profile）；反向隧道的监听端口要和它一致 */
  proxyPort: (request?: { profileId?: string }): Promise<unknown> =>
    ipcRenderer.invoke('forward:proxy-port', request),
  /** 实测一条反向隧道通不通：两边各取一次出口 IP 再比对 */
  verifyTunnel: (request: { port: number; localPort?: number; profileId?: string }): Promise<unknown> =>
    ipcRenderer.invoke('forward:verify', request),
  /** 用系统浏览器打开本地地址（主进程只放行 http(s)://127.0.0.1） */
  openLocalUrl: (url: string): Promise<unknown> => ipcRenderer.invoke('app:open-local-url', url),
  /**
   * 弹系统通知。窗口在前台时主进程会直接跳过（返回 skipped），
   * 所以调用方不用自己判断焦点。
   */
  showNotification: (request: { title: string; body?: string }): Promise<unknown> =>
    ipcRenderer.invoke('notify:show', request),
  /** 点数余额（scir-account -d）；标题栏常驻显示 */
  getPoints: (request?: { profileId?: string }): Promise<unknown> => ipcRenderer.invoke('points:get', request),
  /** 点数消耗明细（scir-account details -r）；按作业逐条 */
  getPointsUsage: (request?: { profileId?: string }): Promise<unknown> =>
    ipcRenderer.invoke('points:usage', request),
  /** 送点数（scir-account transfer）。⚠️ 会真的扣点数，且需要集群密码 */
  transferPoints: (request: unknown): Promise<unknown> => ipcRenderer.invoke('points:transfer', request),
  /** 生成「让他人赠送点数」的说明文本（填的是自己的账号名） */
  getPointsGiftInstruction: (request?: { points?: number; month?: number; profileId?: string }): Promise<unknown> =>
    ipcRenderer.invoke('points:gift-instruction', request),
  /** 显卡单价（scir-watch -s），只取价不当库存真值 */
  getPrices: (request?: { profileId?: string }): Promise<unknown> => ipcRenderer.invoke('price:get', request),

  /*
   * 登录凭据。
   *
   * `setCredential` 的 `secret` 是**唯一**会带着明文密码跨进程的一处：
   * 主进程负责加密后落盘，渲染层拿不到任何回显。
   * 反过来（主进程 → 渲染层）永远不传密码——这正是我们要的方向。
   */
  getCredentialsStatus: (): Promise<unknown> => ipcRenderer.invoke('credentials:status'),
  listCredentials: (): Promise<unknown> => ipcRenderer.invoke('credentials:list'),
  setCredential: (request: unknown): Promise<unknown> => ipcRenderer.invoke('credentials:set', request),
  removeCredential: (request: { kind: string; scope: string }): Promise<unknown> =>
    ipcRenderer.invoke('credentials:remove', request),
  /** 测密码对不对。platform-password 会真的发一次 0 点转账，界面上要先告知 */
  testCredential: (request: unknown): Promise<unknown> => ipcRenderer.invoke('credentials:test', request),
  /** 存储配额（GPFS mmlsquota） */
  getQuota: (request?: { profileId?: string }): Promise<unknown> => ipcRenderer.invoke('quota:get', request),
  /** 历史作业（sacct），days 默认 7 */
  listJobHistory: (request?: { days?: number; profileId?: string }): Promise<unknown> =>
    ipcRenderer.invoke('jobs:history', request),
  /** 取消作业 */
  cancelJob: (jobId: string): Promise<unknown> => ipcRenderer.invoke('jobs:cancel', { jobId }),
  /** 拖拽镜像占用；清空后下次拖文件会重新下载 */
  mirrorStats: (): Promise<unknown> => ipcRenderer.invoke('fs:mirror-stats'),
  clearMirror: (): Promise<unknown> => ipcRenderer.invoke('fs:clear-mirror'),
  /** 本机栏默认目录；dir 为 null 表示用用户主目录 */
  getLocalStart: (): Promise<unknown> => ipcRenderer.invoke('fs:get-local-start'),
  /** 设置默认目录；传 null 恢复成用户主目录 */
  setLocalStart: (dir: string | null): Promise<unknown> => ipcRenderer.invoke('fs:set-local-start', dir),
  /** 弹系统目录选择框；用户取消时返回 { ok: false } */
  pickDirectory: (): Promise<unknown> => ipcRenderer.invoke('fs:pick-directory'),
  /** 拖出第一步：把远端文件镜像到本地临时目录，返回本地路径 */
  prepareDrag: (request: { path: string; profileId?: string }): Promise<unknown> =>
    ipcRenderer.invoke('fs:prepare-drag', request),
  /** 拖出第二步：让系统接管拖拽。必须在上一步拿到 localPath 之后调 */
  startDrag: (localPath: string): Promise<unknown> => ipcRenderer.invoke('fs:start-drag', localPath),
  /** 拖出时的下载进度（只在第一次拖、需要下载时才有） */
  onDragProgress: (listener: (progress: { bytes: number; total: number }) => void): void => {
    ipcRenderer.removeAllListeners('fs:drag-progress')
    ipcRenderer.on('fs:drag-progress', (_event, progress) => listener(progress))
  },
  planTransfer: (request: unknown): Promise<unknown> => ipcRenderer.invoke('transfer:plan', request),
  startTransfer: (request: { planId: string; onConflict?: string }): Promise<unknown> =>
    ipcRenderer.invoke('transfer:start', request),
  /**
   * 取消传输。
   * `cleanup: true` 会连已经传上去的半截文件一起删掉（`.part`）。
   */
  cancelTransfer: (request: { taskId: string; cleanup?: boolean }): Promise<unknown> =>
    ipcRenderer.invoke('transfer:cancel', request),
  /** 传输进度推送；渲染层只读，无法反向控制 */
  onTransferUpdate: (listener: (snapshot: unknown) => void): void => {
    ipcRenderer.removeAllListeners('transfer:update')
    ipcRenderer.on('transfer:update', (_event, snapshot) => listener(snapshot))
  },
  /**
   * 命令记录（只读）。
   *
   * 三个方法都只能"看"——没有 `traceExec` 之类的东西。加它的人要清楚：
   * 这个面板一旦能被用来发命令，它就从"可观测性"变成了"绕过业务校验的后门"。
   */
  traceList: (): Promise<unknown> => ipcRenderer.invoke('trace:list'),
  /** 某一条的完整输出（列表里给的是预览） */
  traceDetail: (id: number): Promise<unknown> => ipcRenderer.invoke('trace:detail', id),
  traceClear: (): Promise<unknown> => ipcRenderer.invoke('trace:clear'),
  /** 每条命令执行完的实时推送 */
  onTraceEntry: (listener: (entry: unknown) => void): void => {
    ipcRenderer.removeAllListeners('trace:entry')
    ipcRenderer.on('trace:entry', (_event, entry) => listener(entry))
  },
  window: {
    minimize: (): void => ipcRenderer.send('window:minimize'),
    toggleMaximize: (): void => ipcRenderer.send('window:toggle-maximize'),
    close: (): void => ipcRenderer.send('window:close')
  }
}

try {
  contextBridge.exposeInMainWorld('hpc', api)
} catch (err) {
  // 只有在 contextIsolation 被关掉时才会走到这里，属于配置错误，直接吼出来
  console.error('preload 暴露失败', err)
}
