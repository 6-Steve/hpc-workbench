/**
 * 应用入口：创建窗口、初始化服务、生命周期。
 *
 * 起步阶段的目标是"打通链路"，所以窗口只做到能自己用起来：
 * 一个无边框窗口 + 一个"连接探针"按钮，把主进程里真实的 SSH 探测结果打在界面上。
 * 界面骨架、Dock、任务栏是后来才加的，不在这里提前造。
 */
import { BrowserWindow, Menu, Tray, app, ipcMain, nativeImage, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { registerIpcHandlers } from './ipc'
import { resolveConfigDir, type ConfigDirResolution, type ConfigLocation } from './config-dir'
import { applySetup, type ApplySetupResult } from './setup'
import type { SetupDraft } from '../shared/setup'
import {
  LOCATION_FILENAME,
  canCreateAt,
  copyConfigFiles,
  isDirWritable,
  readConfigLocation,
  writeConfigLocation
} from './config-location'
import { ProfileState } from './profile-state'
import { KnownHostsStore } from './ssh/known-hosts'
import { ConnectionPool } from './ssh/pool'
import { FileKVStore } from './store/file-kv'
import { clearMirror } from './transfer/mirror'
import { TransferService } from './transfer/service'
import { TunnelManager } from './forward/tunnel'
import { ReverseTunnelManager } from './forward/reverse'
import { TerminalService } from './terminal/service'
import { TraceStore } from './trace/store'
import { CredentialVault } from './credentials/vault'
import { createSafeStorageCipher } from './credentials/safe-storage-cipher'
import { TRACE_LIMIT } from '../shared/trace'
import { writeTunnelDefaults, type TunnelDefaults } from '../shared/tunnel-defaults'

const isDev = !app.isPackaged
const devServerUrl = process.env['ELECTRON_RENDERER_URL']

/**
 * "程序目录"：便携模式相对的就是它。
 *
 * 打包后是 **exe 所在目录**（不是 `app.getAppPath()`，那指向 asar 内部）；
 * 开发时是仓库根。用户把 `config/` 放这儿，就等于"绿色版"。
 */
function appRoot(): string {
  return app.isPackaged ? dirname(process.execPath) : app.getAppPath()
}

/** 指针文件永远在 userData 下——它不能跟着配置目录跑，否则就是循环依赖 */
function locationFile(): string {
  return join(app.getPath('userData'), LOCATION_FILENAME)
}

let resolution: ConfigDirResolution | null = null

/**
 * 解析一次，全程复用。
 *
 * **刻意不每次重算**：`known_hosts` / 凭据库 / 各种缓存都在启动时用这个路径
 * 构造好了。运行中换目录会让"一半服务写旧目录、一半读新目录"——
 * 那比不支持热切换糟得多。所以改目录后是**自动重启**（见 `app:set-config`）。
 */
function configResolution(): ConfigDirResolution {
  if (resolution) return resolution

  const root = appRoot()
  const portableDir = join(root, 'config')
  const portableExists = existsSync(portableDir)
  const location = readConfigLocation(locationFile())

  resolution = resolveConfigDir({
    envDir: process.env['HPC_WORKBENCH_CONFIG_DIR'],
    location,
    appRoot: root,
    userData: app.getPath('userData'),
    portableExists,
    // 只在真的会用到时才探测：探测本身要写文件，没必要每次启动都试
    portableWritable:
      portableExists || location.mode === 'portable'
        ? portableExists
          ? isDirWritable(portableDir)
          : canCreateAt(portableDir)
        : false
  })
  return resolution
}

function configDir(): string {
  return configResolution().dir
}

function configPath(): string {
  return join(configDir(), 'profiles.json')
}

let pool: ConnectionPool | undefined
let mainWindow: BrowserWindow | null = null

/* ── 托盘驻留 ───────────────────────────────────────────────────────────
 *
 * 关窗不退出，是为了"挂着隧道/传着文件时别手滑关掉"。
 *
 * ⚠️ 这里有个和轮询的**硬冲突**：`use-poll` 在窗口隐藏时会完全停发，
 * 而托盘驻留 = 窗口隐藏 → 作业跑完就没人通知了，正好和驻留的目的相反。
 * 所以渲染层的可见性条件放宽成 `!document.hidden || trayResident`，
 * 由 `app:residency` 把这里的模式下发过去。
 */
type ResidencyMode = 'quit' | 'when-busy' | 'always'
let residency: ResidencyMode = 'quit'
/** 真正退出时置 true：否则 `close` 里的"隐藏到托盘"会把退出也拦住 */
let isQuitting = false
let tray: Tray | null = null
/** 关窗策略的持久化（和 profiles.json 分开：这是界面偏好，不是集群配置） */
let uiStore: FileKVStore | null = null
/** 端口转发管理器：在 whenReady 里创建，退出时统一关闭 */
let tunnels: TunnelManager | null = null
/** 传输服务；`hasActiveWork()` 要用它判断"有没有在传东西" */
let transfer: TransferService | null = null
/** 反向隧道（集群借本机网络出去） */
let reverseTunnels: ReverseTunnelManager | null = null
/** 交互式终端会话；退出时要把远端的 shell 进程收掉 */
let terminals: TerminalService | null = null

/**
 * 有没有"关掉会心疼"的活。
 *
 * 只算传输和隧道：
 * - 传输中断 = 数据要重传，明显该拦；
 * - 隧道断 = 集群上那个代理立刻失效，Codex 直接报网络错误；
 * - **终端不算**：关窗本来就会丢 scrollback，把它算进"活动"只会让用户永远关不掉窗口。
 */
function hasActiveWork(): boolean {
  if (transfer?.hasActive()) return true
  if ((tunnels?.list().length ?? 0) > 0) return true
  if ((reverseTunnels?.list().length ?? 0) > 0) return true
  return false
}

function shouldStayResident(): boolean {
  if (residency === 'always') return true
  if (residency === 'when-busy') return hasActiveWork()
  return false
}

function showMainWindow(): void {
  if (!mainWindow) {
    mainWindow = createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function refreshTrayMenu(): void {
  if (!tray) return
  const busy = hasActiveWork()
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => showMainWindow() },
      { label: busy ? '有任务在跑（传输 / 隧道）' : '当前没有任务', enabled: false },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true
          app.quit()
        }
      }
    ])
  )
}

/**
 * 建托盘。
 *
 * 图标找不到也**不能崩**：托盘是"关窗不退出"的唯一出口，
 * 没有托盘还驻留的话，用户就再也打不开窗口了（只能任务管理器杀进程）。
 */
function ensureTray(): void {
  if (tray) {
    refreshTrayMenu()
    return
  }

  /*
   * 图标在 asar 里（打包后），所以**先读 buffer 再建图**。
   * `createFromPath` 对 asar 路径的支持在不同 Electron 版本上不一致，
   * 而 `readFileSync` 走的是 Electron 打过补丁的 fs，asar 里也能读。
   */
  const iconPath = join(app.getAppPath(), 'build', 'icon.ico')
  let image = nativeImage.createEmpty()
  try {
    const loaded = nativeImage.createFromBuffer(readFileSync(iconPath))
    if (!loaded.isEmpty()) image = loaded
  } catch {
    // 图标读不到也要能建托盘：否则"关窗驻留"就没有出口了
  }

  tray = new Tray(image)
  tray.setToolTip('HPC 工作台')
  tray.on('click', () => showMainWindow())
  refreshTrayMenu()
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    frame: false,
    backgroundColor: '#f6f7f9',
    title: 'HPC 工作台',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  window.once('ready-to-show', () => window.show())

  // 外链一律走系统浏览器，不在应用内开新窗口
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 应用菜单被整个关掉了，Ctrl+Shift+I 也就没了。开发时给 F12 手动兜一条，
  // 调界面（尤其是虚拟滚动的 DOM 行数）时随手能开。
  if (isDev) {
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        window.webContents.toggleDevTools()
        event.preventDefault()
      }
    })
  }

  if (isDev && devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  /*
   * 关窗 → 按策略决定"真退出"还是"藏到托盘"。
   *
   * `isQuitting` 是这里的关键：托盘菜单点「退出」时先置位，
   * 否则 `close` 会把这次退出也拦成"隐藏"，进程永远退不掉。
   */
  window.on('close', (event) => {
    if (isQuitting) return
    if (!shouldStayResident()) return
    event.preventDefault()
    window.hide()
    ensureTray()
  })

  window.on('closed', () => {
    mainWindow = null
  })

  return window
}

function registerWindowControls(): void {  ipcMain.on('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })
  ipcMain.on('window:toggle-maximize', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })
  ipcMain.on('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void app.whenReady().then(() => {
    app.setAppUserModelId('com.hpc.workbench')
    Menu.setApplicationMenu(null)

    /*
     * 先把配置目录建出来。
     *
     * 打包后默认是 `%APPDATA%/HPC Workbench/config`，**首次运行时并不存在**；
     * 便携模式下是 exe 旁边的 `config/`，同样可能不存在（用户刚选了"用程序目录"）。
     * 不建的话，后面第一次写凭据 / known_hosts 会因为没有父目录而失败，
     * 而失败点在一个异步流程里，界面上只会看到"保存失败"。
     */
    try {
      mkdirSync(configDir(), { recursive: true })
    } catch (err) {
      // 建不出来不阻止启动：读还是能读（如果用户自己放了文件），
      // 只是写会失败，那时由具体功能报错，比整个应用起不来好
      console.error('[config] 配置目录建不出来', configDir(), err)
    }
    if (isDev) {
      const info = configResolution()
      console.log(`[config] dir=${info.dir} source=${info.source}`)
    }

    // 拖拽镜像只是临时缓存，每次启动从干净状态开始。
    // 不阻塞启动，也不因为个别文件被占用就报错。
    void clearMirror()
      .then((result) => {
        if (isDev && result.files > 0) {
          console.log(`[drag] 清掉了上次的拖拽缓存：${result.files} 个文件 / ${(result.bytes / 1048576).toFixed(1)} MB`)
        }
      })
      .catch(() => undefined)

    // 命令记录：内存里有界，订阅者直接推给所有窗口。
    // 它挂在连接池的 onTrace 上，所以**所有** exec 都会被记到，不依赖各页面自觉上报。
    const trace = new TraceStore({ limit: TRACE_LIMIT })
    trace.subscribe((entry) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.webContents.isDestroyed()) window.webContents.send('trace:entry', entry)
      }
    })

    /*
     * 主机指纹库**只建一个实例**：连接池用它验证、测速也用它验证。
     * 两个实例各持一份内存快照，新记住的指纹在另一份里看不到，
     * 会表现成"明明连过，测速还说没见过这台主机"。
     */
    const knownHosts = new KnownHostsStore(join(configDir(), 'known_hosts.json'))

    pool = new ConnectionPool({
      knownHosts,
      onLog: (message) => {
        if (isDev) console.log(`[ssh] ${message}`)
      },
      onTrace: (input) => {
        trace.push(input)
      }
    })

    /*
     * 凭据保险库。
     *
     * 单独一个文件（`config/credentials.json`），不混进 `state.json`：
     * 里面全是密文，用户可能会想整个删掉重来，而 `state.json` 里还有
     * 当前选的是哪台跳板机这种"删了会烦"的东西。
     *
     * 密钥不在这里——由操作系统的钥匙串保管（Windows DPAPI / macOS Keychain）。
     * 所以这个文件被拷到别人机器上也解不开。
     */
    const credentials = new CredentialVault({
      store: new FileKVStore(join(configDir(), 'credentials.json')),
      cipher: createSafeStorageCipher()
    })

    /*
     * 「当前用哪台跳板机」。整个应用只有这一个持有者。
     *
     * 存盘的位置和 y 轴能力缓存分开：用 `.state` 是因为它属于"用户偏好"，
     * 丢了最多回到默认机，不该和能力缓存混在一个文件里互相拖累。
     *
     * 保险库注在这里，`current()` 出来的 profile 就自带密码——
     * 终端、隧道、传输、转账全都自动用上，不需要各自去问。
     */
    const profileState = new ProfileState({
      configPath,
      cache: new FileKVStore(join(configDir(), '.cache', 'state.json')),
      credentials
    })

    // 传输服务：惰性取连接，进度直接推给所有窗口
    const connection = pool
    transfer = new TransferService({
      // 走 profileState 而不是 pickProfile(loaded)：切了跳板机之后，
      // 新排进队列的任务要落到新机器上，不能还咬着默认机
      getSession: async () => connection.acquire(profileState.current()),
      onUpdate: (snapshot) => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed()) window.webContents.send('transfer:update', snapshot)
        }
      }
    })

    // 端口转发：本地监听的端口必须在退出时全部释放，否则下次启动会报"端口被占用"
    tunnels = new TunnelManager({ onLog: (message) => isDev && console.log(`[tunnel] ${message}`) })

    reverseTunnels = new ReverseTunnelManager({
      onLog: (message) => isDev && console.log(`[reverse] ${message}`)
    })

    // 终端：输出直接推给所有窗口（和传输进度同一个模式）
    terminals = new TerminalService({
      onData: (sessionId, text) => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.webContents.isDestroyed()) window.webContents.send('terminal:data', { sessionId, text })
        }
      },
      onClose: (info) => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.webContents.isDestroyed()) window.webContents.send('terminal:closed', info)
        }
      }
    })

    /*
     * 界面偏好的存储：和 profiles.json 分开。
     * 关窗策略是"这台电脑上的习惯"，跟集群配置没有关系。
     */
    uiStore = new FileKVStore(join(configDir(), 'ui.json'))
    /*
     * 能力探测缓存，同时是"用户偏好"的落脚点（隧道默认端口、上次选的本地目录）。
     * 抽成变量是因为 `applyInitialSetup` 也要往里写——见那里的注释。
     */
    const capabilityStore = new FileKVStore(join(configDir(), '.cache', 'capabilities.json'))
    const savedResidency = uiStore.get<string>('residency')
    if (savedResidency === 'quit' || savedResidency === 'when-busy' || savedResidency === 'always') {
      residency = savedResidency
    }

    registerIpcHandlers({
      pool,
      profileState,
      credentials,
      knownHosts,
      /* 关窗策略：主进程持有 Tray 和窗口，所以读写都由它实现，IPC 只做转发 */
      getResidency: () => residency,
      setResidency: (mode: ResidencyMode) => {
        residency = mode
        uiStore?.set('residency', mode)
        refreshTrayMenu()
      },
      hasActiveWork,
      configPath,
      cache: capabilityStore,
      transfer,
      tunnels,
      reverseTunnels,
      terminals,
      trace,
      /*
       * 配置目录的"现在是哪儿"和"换到哪儿"。
       *
       * 换目录必须**重启**：上面这些服务在启动时就把路径定死了
       * （known_hosts / 凭据库 / 能力缓存），运行中换会让一半服务写旧目录、
       * 一半读新目录，那比"不支持热切换"糟得多。所以这里只负责写指针 + 重启。
       */
      configInfo: () => {
        const info = configResolution()
        const location = readConfigLocation(locationFile())
        return {
          dir: info.dir,
          source: info.source,
          portableDir: info.portableDir,
          defaultDir: info.defaultDir,
          appRoot: appRoot(),
          mode: location.mode,
          customDir: location.dir,
          fallback: info.fallback,
          readonly: info.source === 'env'
        }
      },
      setConfigLocation: (location: ConfigLocation): { ok: boolean; error?: string } => {
        try {
          const info = configResolution()
          /*
           * 目标目录按"要切到哪一档"算出来。
           * `auto` 是特例：它不好预先决定（要看程序目录下有没有 config），
           * 所以按**当前**的判断走——反正重启后它也会得出同样结论。
           */
          const target =
            location.mode === 'custom' && location.dir
              ? location.dir
              : location.mode === 'portable'
                ? info.portableDir
                : existsSync(info.portableDir)
                  ? info.portableDir
                  : info.defaultDir

          mkdirSync(target, { recursive: true })
          // 先把现有文件搬过去再改指针：反过来一旦搬到一半失败，
          // 应用已经指向新目录而文件还在旧目录，就真的"配置丢了"
          const copied = copyConfigFiles(info.dir, target)
          writeConfigLocation(locationFile(), location)
          if (isDev) {
            console.log(`[config] 切到 ${target}（${location.mode}），搬过去 ${copied.length} 个文件`)
          }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
        /*
         * 让它先把回复送回渲染层，再重启。
         * 直接 `app.exit()` 会让 invoke 永远没有 resolve，界面卡在"保存中"。
         *
         * ⚠️ **必须先 `releaseSingleInstanceLock()`**：新进程拿不到单实例锁时
         * 会走 `app.quit()` 那条分支——用户看到的不是"重启失败"，而是
         * "点了按钮应用就没了"。这个窗口只有几十毫秒，但它是确定存在的。
         */
        setTimeout(() => {
          app.releaseSingleInstanceLock()
          app.relaunch()
          app.exit(0)
        }, 400)
        return { ok: true }
      },
      /**
       * 首次向导：把填表结果写成 `profiles.json`（+ 凭据）。
       *
       * 和 `setConfigLocation` 的区别：那条只写指针，这条**还要生成配置**。
       * 两者都可能需要重启（换了目录才有意义），但这里允许"目录没变"——
       * 那是最常见的情况（用默认目录），写完当场就能用，不必重启。
       */
      applyInitialSetup: (request: {
        draft: SetupDraft
        extras?: SetupDraft[]
        mode: ConfigLocation['mode']
        dir?: string
        tunnel?: TunnelDefaults
      }): ApplySetupResult & { restartRequired: boolean } => {
        const info = configResolution()
        const mode = request.mode ?? 'auto'
        const target =
          mode === 'custom' && request.dir
            ? request.dir
            : mode === 'portable'
              ? info.portableDir
              : existsSync(info.portableDir)
                ? info.portableDir
                : info.defaultDir

        if (mode !== 'auto' && !canCreateAt(target) && !isDirWritable(target)) {
          return {
            ok: false,
            restartRequired: false,
            issues: [{ field: 'general', message: `这个目录写不进去：${target}` }]
          }
        }

        const result = applySetup({ draft: request.draft, extras: request.extras, dir: target }, { credentials })
        if (!result.ok) return { ...result, restartRequired: false }

        /*
         * 隧道端口**写进 target 目录**，而不是当前进程的 `capabilityStore`。
         *
         * 向导第一步就能换配置目录。那时进程里的 store 还指着旧目录，端口会存进
         * 一个重启后再也读不到的文件里——用户重新进隧道页，看到的还是 21056 / 7897，
         * 而设置里明明改过。目录没变时才复用活着的那个实例，免得两份内存状态互相覆盖。
         */
        const tunneling = request.tunnel
        if (tunneling) {
          try {
            writeTunnelDefaults(
              target === info.dir ? capabilityStore : new FileKVStore(join(target, '.cache', 'capabilities.json')),
              tunneling
            )
          } catch {
            result.warnings = [
              ...(result.warnings ?? []),
              '隧道默认端口没存上，下次开隧道时手动填一下。'
            ]
          }
        }

        try {
          writeConfigLocation(locationFile(), mode === 'custom' ? { mode, dir: target } : { mode })
        } catch {
          // 指针写不进去不影响本次使用（配置文件已经到位），下次启动会退回默认
        }

        return { ...result, restartRequired: target !== info.dir }
      }
    })
    registerWindowControls()

    mainWindow = createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
    })
  })

  app.on('window-all-closed', () => {
    /*
     * 走到这里说明窗口被真正销毁了（不是 hide）。驻留模式下窗口只是隐藏，
     * 不会触发这个事件；所以这里保持"退到底"的语义即可。
     */
    app.quit()
  })

  app.on('before-quit', () => {
    // 任何退出路径（菜单、快捷键、app.quit）都要置位，否则会被 close 拦住
    isQuitting = true
    // 先收终端和隧道：它们各自占着一条 SSH 通道，连接断了再关会报"通道已关闭"
    terminals?.closeAll()
    // 反向隧道必须先释放集群上的端口，这一步还依赖 SSH 连接活着
    reverseTunnels?.closeAll()
    tunnels?.closeAll()
    void pool?.closeAll()
  })
}
