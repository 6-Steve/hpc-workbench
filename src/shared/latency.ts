/**
 * 跳板机延迟的四段拆解 + 判读（纯函数，主进程和界面共用）。
 *
 * ## 为什么不能只给一个"延迟 xx ms"
 *
 * 用户看到"1.2 秒"的第一反应是查自己的宽带，而实际原因往往是**登录节点在忙**：
 * 网络只花了 12ms，剩下 1.1s 全耗在密钥交换和认证上。这两个原因的处理方式完全不同
 * （一个换网络、一个换节点），所以必须在文案里分开说。
 *
 * 四段：
 *
 * ```
 * t0 ── tcp ── sshd ── auth ── exec
 *        握手   版本串   KEX+认证  echo 往返
 * ```
 *
 * - `tcpMs`：纯网络往返，和服务端负载无关
 * - `sshdMs`：连上之后到收到 `SSH-2.0-...` 的时间，反映 sshd 接受连接的速度
 * - `authMs`：密钥交换 + 认证，**登录节点忙不忙主要看这段**
 * - `execMs`：一条 `echo` 的往返，最接近"用起来卡不卡"
 */
export type LatencyStage = 'tcp' | 'sshd' | 'auth' | 'exec'

/**
 * 失败类型。**必须分类**：一句"连接失败"分不清是网线掉了、密码错了、还是节点挂了。
 */
export type LatencyFailure =
  | 'unreachable'
  | 'auth-failed'
  | 'exec-failed'
  | 'unknown-host'
  | 'hostkey-mismatch'

export interface LatencyProbe {
  tcpMs: number | null
  sshdMs: number | null
  authMs: number | null
  execMs: number | null
  /** `ready` 时刻 − 开始 */
  totalMs: number | null
  /** 卡在哪一段（超时才有）；有值时前面几段的数字仍然有效 */
  timedOutAt?: LatencyStage
  /** 失败类型；成功为 null */
  failure?: LatencyFailure | null
  /** 平台原话（认证失败时尤其重要：能区分密码错、账号被锁、权限不足） */
  error?: string
}

export type LatencyVerdict =
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

export interface LatencyJudgement {
  verdict: LatencyVerdict
  /** 一句话结论，界面上加粗显示 */
  headline: string
  /** 补充说明：数字分解 + 该往哪儿查 */
  detail: string
}

/** 一次完整的测速结果（探测数据 + 判读 + 归属） */
export type ProfileLatency = LatencyProbe & {
  profileId: string
  /** 测量完成时刻（毫秒时间戳） */
  at: number
} & LatencyJudgement

/**
 * 超时预算。
 *
 * 用户定的上限是 **25 秒**：校园网/VPN/首次登录确实可能很慢，5 秒会误杀正常连接。
 * 但**总闸不等于每段都等 25 秒**——分段限量才能让"卡住了"尽早、尽量具体地暴露：
 * 网络不通通常 1–2 秒就能确定，不该陪着认证那 15 秒一起等。
 *
 * 三段之和正好 25000，等于总预算；`totalMs` 仍然单独判，防止某段复用了剩余额度后超支。
 */
export const LATENCY_TIMEOUTS = {
  tcpMs: 5000,
  authMs: 15000,
  execMs: 5000,
  totalMs: 25000
} as const

/** 判读阈值。集中在这里，界面上不写死数字 */
export const LATENCY_THRESHOLDS = {
  tcpWarnMs: 150,
  sshdWarnMs: 300,
  authWarnMs: 1200,
  execWarnMs: 400
} as const

export function judgeLatency(probe: LatencyProbe): LatencyJudgement {
  const parts = breakdown(probe)

  if (probe.failure === 'unknown-host') {
    return {
      verdict: 'unknown-host',
      headline: '这台主机的指纹还没记录',
      detail: '测速不会替你信任一台新主机。先在主界面正常连一次（会记录指纹），再来测。'
    }
  }

  if (probe.failure === 'hostkey-mismatch') {
    return {
      verdict: 'hostkey-mismatch',
      headline: '主机指纹和记录的不一致',
      detail: '这不是测速能处理的情况。' + (probe.error ?? '') + ' 先确认集群是否换过主机密钥。'
    }
  }

  if (probe.failure === 'unreachable' || probe.timedOutAt === 'tcp') {
    return {
      verdict: probe.failure === 'unreachable' ? 'unreachable' : 'timeout',
      headline: probe.timedOutAt === 'tcp' ? '连接超时（网络这一关就没过）' : '连不上',
      detail:
        (probe.error ? `${probe.error}。` : '') +
        'TCP 握手没完成——可能是内网/VPN 没连上、防火墙丢包，或者主机地址、端口填错了。和 sshd 忙不忙无关。'
    }
  }

  if (probe.failure === 'auth-failed') {
    return {
      verdict: 'auth-failed',
      headline: '认证失败（网络是通的）',
      detail:
        (probe.error ? `平台原话：${probe.error}。` : '') +
        `网络 ${fmt(probe.tcpMs)} 正常到达，是登录这一步被拒了——检查用户名、私钥/密码，或者账号是否被锁。`
    }
  }

  // 卡在认证：这时 tcp/sshd 的数字仍然有效，必须给出来
  if (probe.timedOutAt === 'auth' || probe.timedOutAt === 'sshd') {
    const tcpOk = probe.tcpMs !== null && probe.tcpMs <= LATENCY_THRESHOLDS.tcpWarnMs
    return {
      verdict: 'timeout',
      headline: probe.timedOutAt === 'sshd' ? '登录超时（sshd 一直没应答）' : '认证超时',
      detail: tcpOk
        ? `网络 ${fmt(probe.tcpMs)} 是正常的，卡在登录这一步 —— 多半是这台登录节点过载，换一台试试。`
        : `网络 ${fmt(probe.tcpMs)} 也不快，卡在登录这一步；网络和节点两边都值得查。`
    }
  }

  if (probe.failure === 'exec-failed') {
    return {
      verdict: 'exec-failed',
      headline: '连上了，但执行不了命令',
      detail:
        (probe.error ? `${probe.error}。` : '') +
        '登录本身成功，说明认证没问题；卡在 shell 初始化（`.bashrc` 里有慢命令）或权限配置上。'
    }
  }

  if (probe.timedOutAt === 'exec') {
    return {
      verdict: 'timeout',
      headline: '命令超时',
      detail: `登录用了 ${fmt(probe.totalMs)}，但一条 echo 迟迟不返回——检查 \`.bashrc\`/\`.profile\` 里有没有会阻塞的命令。`
    }
  }

  // 全通：按阈值判断慢在哪一段
  const { tcpMs, sshdMs, authMs, execMs } = probe

  if (authMs !== null && authMs > LATENCY_THRESHOLDS.authWarnMs) {
    return {
      verdict: 'sshd-busy',
      headline: '跳板机忙',
      detail:
        `登录用了 ${fmt(probe.totalMs)}，其中认证 ${fmt(authMs)}、网络只有 ${fmt(tcpMs)} —— ` +
        '不是网速问题，是这台登录节点在忙。换另一台跳板机往往立刻就好。'
    }
  }

  if (sshdMs !== null && sshdMs > LATENCY_THRESHOLDS.sshdWarnMs) {
    return {
      verdict: 'sshd-busy',
      headline: 'sshd 应答慢',
      detail: `连上之后等了 ${fmt(sshdMs)} 才收到 SSH 版本串，通常说明这台节点的 sshd 排着队。`
    }
  }

  if (tcpMs !== null && tcpMs > LATENCY_THRESHOLDS.tcpWarnMs) {
    return {
      verdict: 'network-slow',
      headline: '网络慢',
      detail: `TCP 握手就花了 ${fmt(tcpMs)}，和服务端无关——检查 VPN/代理、或者换个网络环境。`
    }
  }

  if (execMs !== null && execMs > LATENCY_THRESHOLDS.execWarnMs) {
    return {
      verdict: 'exec-slow',
      headline: '能用，但交互会顿',
      detail: `一条 echo 往返 ${fmt(execMs)}。终端里敲命令会明显有延迟，做交互式操作会难受。`
    }
  }

  if (probe.totalMs === null) {
    return { verdict: 'unknown', headline: '没测出结果', detail: parts || '探测没有返回任何数据。' }
  }

  return {
    verdict: 'ok',
    headline: '正常',
    detail: parts
  }
}

/** `12ms` / `1.2s`。界面上到处用它，保持一致 */
export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function fmt(ms: number | null): string {
  return formatMs(ms)
}

function breakdown(probe: LatencyProbe): string {
  const items: string[] = []
  if (probe.tcpMs !== null) items.push(`网络 ${formatMs(probe.tcpMs)}`)
  if (probe.sshdMs !== null) items.push(`sshd ${formatMs(probe.sshdMs)}`)
  if (probe.authMs !== null) items.push(`认证 ${formatMs(probe.authMs)}`)
  if (probe.execMs !== null) items.push(`命令 ${formatMs(probe.execMs)}`)
  return items.join(' · ')
}
