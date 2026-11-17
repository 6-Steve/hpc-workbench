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
