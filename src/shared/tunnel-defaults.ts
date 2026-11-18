/**
 * 反向隧道端口的默认值与校验。
 *
 * ## 为什么这两个端口要进向导
 *
 * 21056 不是"随便挑的一个好看的数字"，它**必须**和集群上 `~/.profile` 里的
 * `http_proxy` 一致——否则集群上 `pip` / `conda` / 各种 CLI 走代理会连不上，
 * 而报错是"连接被拒绝"，完全指不到端口不匹配。这种一致性要求，
 * 应该在被问到的时候就说清楚，而不是等用户自己撞。
 *
 * 7897 是本机代理（Clash）的端口，别人可能是 7890 / 1080 / 10809，也一样要能改。
 *
 * ## 为什么默认 21056 而不是 55555
 *
 * - 55555 在共享登录节点上被别的账号长期占着，绑不上；
 * - 55556 这类落在内核临时端口段（`ip_local_port_range` = 32768–60999）里，
 *   别人的出站连接会临时征用它，表现为"时好时坏、`ss` 又查不到"。
 *
 * 所以默认值取 32768 以下，同时**对用户自己填的值给出同样的提醒**。
 */
export interface TunnelDefaults {
  /** 集群侧监听端口，要等于集群 `http_proxy` 的端口 */
  remotePort: number
  /** 本机代理端口（Clash 默认 7897） */
  localPort: number
}

export const TUNNEL_DEFAULTS: TunnelDefaults = { remotePort: 21056, localPort: 7897 }

/**
 * 存进 KVStore 的两个键。
 *
 * 带 `tunnel.` 前缀是必需的：这个 store 同时放着能力探测缓存（`capabilities.<id>`），
 * 扁平命名空间撞了名，表现会是"设置莫名回退"，而不是报错。
 */
export const TUNNEL_PREF_KEYS = {
  remotePort: 'tunnel.reverseRemotePort',
  localPort: 'tunnel.reverseLocalPort'
} as const

/**
 * 只依赖读写的结构类型。
 *
 * `shared/` 里不能 import `main/store`（那是 Node 侧），所以这里只要形状对得上就行。
 */
export interface TunnelPrefStore {
  get<T>(key: string): T | undefined
  set<T>(key: string, value: T): void
}

/**
 * 读用户存过的端口，读不到才回默认。
 *
 * 对脏值（字符串、越界、小数）一律当"没存过"处理，而不是把脏值原样吐给界面——
 * 一个 `"21056"` 字符串送进 `listen()` 会在绑定时才炸，离"端口填错了"很远。
 */
export function readTunnelDefaults(store: TunnelPrefStore | null | undefined): TunnelDefaults {
  if (!store) return { ...TUNNEL_DEFAULTS }
  return {
    remotePort: coercePort(store.get(TUNNEL_PREF_KEYS.remotePort)) ?? TUNNEL_DEFAULTS.remotePort,
    localPort: coercePort(store.get(TUNNEL_PREF_KEYS.localPort)) ?? TUNNEL_DEFAULTS.localPort
  }
}

/** 写端口偏好。返回真正落进去的值（已取整），调用方拿它回填界面 */
export function writeTunnelDefaults(store: TunnelPrefStore, ports: TunnelDefaults): TunnelDefaults {
  const clean: TunnelDefaults = {
    remotePort: Math.trunc(ports.remotePort),
    localPort: Math.trunc(ports.localPort)
  }
  store.set(TUNNEL_PREF_KEYS.remotePort, clean.remotePort)
  store.set(TUNNEL_PREF_KEYS.localPort, clean.localPort)
  return clean
}

function coercePort(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN
  if (!Number.isInteger(number) || number < 1 || number > 65535) return null
  return number
}

/**
 * 反向隧道那条"数据往哪走"的示意句。
 *
 * **必须吃当前值**。写死常量的话，用户把端口改成 21057 / 7890 之后，
 * 输入框是对的、这句话还在说 21056 / 7897，等于界面自己打自己的脸。
 */
export function formatReverseFlow(remotePort: number | string, localPort: number | string): string {
  const remote = String(remotePort).trim() || String(TUNNEL_DEFAULTS.remotePort)
  const local = String(localPort).trim() || String(TUNNEL_DEFAULTS.localPort)
  return `集群程序 → 127.0.0.1:${remote} → 你的电脑 ${local}（代理）`
}

/** 内核临时端口段。落在这一段里的固定端口会被随机抢走 */
export const EPHEMERAL_RANGE = { min: 32768, max: 60999 } as const

export interface TunnelPortsDraft {
  remotePort: string
  localPort: string
}

export type TunnelPortField = 'remotePort' | 'localPort'

export interface TunnelPortsValidation {
  /** 非法值：**阻止**继续（存进去只会在绑定时炸） */
  errors: Partial<Record<TunnelPortField, string>>
  /** 能用但建议改：**不阻止**，但要在界面上说出来 */
  warnings: string[]
}

export function validateTunnelPorts(draft: TunnelPortsDraft): TunnelPortsValidation {
  const errors: TunnelPortsValidation['errors'] = {}
  const warnings: string[] = []

  const remote = readPort(draft.remotePort)
  const local = readPort(draft.localPort)

  if (remote === null) {
    errors.remotePort = '必须是 1–65535 的整数'
  } else if (remote > EPHEMERAL_RANGE.min - 1) {
    /*
     * 只警告不拦：用户可能确实知道自己在干什么（比如集群管理员给他分了一段）。
     * 但默认值必须避开这个区间，所以提示里要把原因讲清楚。
     */
    warnings.push(
      `集群侧 ${remote} 落在系统临时端口段（${EPHEMERAL_RANGE.min}–${EPHEMERAL_RANGE.max}）内，` +
        '可能被别的连接临时占用，表现为"时好时坏"。建议用 32768 以下的端口。'
    )
  }

  if (local === null) {
    errors.localPort = '必须是 1–65535 的整数'
  } else if (local < 1024) {
    warnings.push(`本机 ${local} 是特权端口（1024 以下），普通用户一般绑不上。`)
  }

  if (remote !== null && local !== null && remote === local) {
    warnings.push(
      `两边都是 ${remote}：它们在不同的机器上，语法上没问题，但日志里容易看混——建议区分开。`
    )
  }

  return { errors, warnings }
}

function readPort(text: string): number | null {
  const raw = text.trim()
  if (!raw) return null
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 65535) return null
  return value
}
