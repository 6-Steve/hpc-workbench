/**
 * SSH / SFTP 错误归一化。
 *
 * 两条硬规则：
 * 1. 原始 message / stderr 必须保留，可在 UI 里展开查看——这是用户自救的唯一途径。
 * 2. 归一是"加一层人话"，不是"吞掉原始信息"。任何情况下 raw 都不能为空。
 */

export type SshErrorKind =
  | 'config' // 本地配置/密钥文件问题
  | 'dns' // 域名解析不了
  | 'network' // 拒绝连接 / 不可达 / 超时
  | 'reset' // 连接被重置（可重试）
  | 'handshake' // 握手阶段失败
  | 'auth' // 认证失败
  | 'key' // 私钥格式或口令问题
  | 'hostkey' // 主机指纹不匹配（中间人风险）
  | 'channel' // 通道层失败（并发超限等）
  | 'remote' // 远端命令非 0 退出
  | 'timeout' // 客户端侧主动超时
  | 'aborted' // 用户主动取消（不是故障，不许重试、不许标红）
  | 'unknown'

export interface SshErrorInit {
  kind: SshErrorKind
  /** 给用户看的一句话，不含主机名以外的技术细节 */
  message: string
  /** 下一步该做什么，没有就留空 */
  hint?: string
  /** 原始错误文本或 stderr，永远保留 */
  raw: string
  /** 系统错误码，如 ECONNREFUSED */
  code?: string
  /** 重连一次是否可能成功 */
  retryable?: boolean
}

export class SshError extends Error {
  readonly kind: SshErrorKind
  readonly hint?: string
  readonly raw: string
  readonly code?: string
  readonly retryable: boolean

  constructor(init: SshErrorInit) {
    super(init.message)
    this.name = 'SshError'
    this.kind = init.kind
    this.hint = init.hint
    this.raw = init.raw
    this.code = init.code
    this.retryable = init.retryable ?? false
  }

  /** 单行摘要，写日志用 */
  get summary(): string {
    return this.code ? `[${this.kind}/${this.code}] ${this.message}` : `[${this.kind}] ${this.message}`
  }
}

/**
 * 用户主动取消。
 *
 * 单独立一个类而不是 `kind: 'aborted'` 的 SshError 判断，是因为
 * 队列层要频繁问"这是不是用户取消的"——靠 `err.kind === 'aborted'` 也行，
 * 但调用方很容易在 catch 里先看到 `SshError` 就当成故障走重试。
 * 给一个专属类型，`instanceof` 一查就没有歧义。
 */
export class TransferAborted extends SshError {
  constructor(message = '传输已取消') {
    super({ kind: 'aborted', message, raw: message, retryable: false })
    this.name = 'TransferAborted'
  }
}

/** 任意错误 → 是否用户取消 */
export function isAbort(err: unknown): boolean {
  if (err instanceof TransferAborted) return true
  return err instanceof Error && err.name === 'AbortError'
}

export interface ErrorContext {
  host?: string
  port?: number
  username?: string
  phase?: 'config' | 'connect' | 'handshake' | 'auth' | 'hostkey' | 'exec' | 'tunnel'
}

interface RawError {
  message: string
  code?: string
  level?: string
  errno?: string | number
}

function asRaw(err: unknown): RawError {
  if (err instanceof Error) {
    const anyErr = err as Error & { code?: string; level?: string; errno?: string | number }
    return { message: err.message, code: anyErr.code, level: anyErr.level, errno: anyErr.errno }
  }
  if (typeof err === 'string') return { message: err }
  if (err && typeof err === 'object') {
    const anyErr = err as { message?: unknown; code?: unknown; level?: unknown }
    return {
      message: typeof anyErr.message === 'string' ? anyErr.message : JSON.stringify(err),
      code: typeof anyErr.code === 'string' ? anyErr.code : undefined,
      level: typeof anyErr.level === 'string' ? anyErr.level : undefined
    }
  }
  return { message: String(err) }
}

/** 已经是归一化错误就直接透传，避免二次包装 */
export function normalizeSshError(err: unknown, ctx: ErrorContext = {}): SshError {
  if (err instanceof SshError) return err

  const raw = asRaw(err)
  const msg = raw.message
  const lower = msg.toLowerCase()
  const code = raw.code
  const target = ctx.host ? `${ctx.host}:${ctx.port ?? 22}` : '目标主机'

  // —— 主机指纹：这类错误必须最优先，且绝不建议用户"忽略" ——
  if (lower.includes('host denied') || raw.code === 'HOSTKEY_MISMATCH') {
    return new SshError({
      kind: 'hostkey',
      message: `${target} 的主机指纹与本地记录不一致`,
      hint: '可能是服务器重装或换了机器，也可能是中间人攻击。确认无误后删除 config/known_hosts.json 里该主机的记录再重连。',
      raw: msg,
      code: raw.code
    })
  }

  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'EAI_NONAME':
      return new SshError({
        kind: 'dns',
        message: `解析不到主机名 ${ctx.host ?? ''}`.trim(),
        hint: '确认主机名拼写；如果集群只在内网可达，先连上校园网或 VPN 再试。',
        raw: msg,
        code
      })
    case 'ECONNREFUSED':
      return new SshError({
        kind: 'network',
        message: `${target} 拒绝连接`,
        hint: '端口可能不对，或 SSH 服务只对特定网段开放。先用命令行 `ssh -p <端口> <用户>@<主机>` 验证一下。',
        raw: msg,
        code
      })
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return new SshError({
        kind: 'network',
        message: `网络不可达：${target}`,
        hint: '检查是否已连校园网 / VPN，或对方是否在维护。',
        raw: msg,
        code
      })
    case 'ETIMEDOUT':
      return new SshError({
        kind: 'network',
        message: `连接 ${target} 超时`,
        hint: '常见原因是 VPN 未连、防火墙拦截，或主机名指向了不可达地址。',
        raw: msg,
        code,
        retryable: true
      })
    case 'ECONNRESET':
    case 'EPIPE':
      return new SshError({
        kind: 'reset',
        message: `与 ${target} 的连接被重置`,
        hint: '可能是网络抖动或服务端断开了空闲连接，重连一次通常就能恢复。',
        raw: msg,
        code,
        retryable: true
      })
  }

  // —— 认证类 ——
  if (lower.includes('all configured authentication methods failed')) {
    return new SshError({
      kind: 'auth',
      message: `认证失败：${ctx.username ?? '当前用户'}@${target}`,
      hint: '公私钥可能不匹配（用户名写错、公钥没装到服务端的 authorized_keys），或该账号只能用密码登录。',
      raw: msg,
      code: raw.code ?? 'AUTH_FAILED'
    })
  }
  if (lower.includes('cannot parse privatekey') || lower.includes('unsupported key format')) {
    return new SshError({
      kind: 'key',
      message: '私钥文件无法解析',
      hint: '不支持的格式最常见的原因是用了 PuTTY 的 .ppk。用 puttygen 转成 OpenSSH（Conversions → Export OpenSSH key），或直接用 ssh-keygen 重新生成。',
      raw: msg,
      code: raw.code ?? 'BAD_KEY'
    })
  }
  if (lower.includes('encrypted private openssh key') || lower.includes('bad passphrase')) {
    return new SshError({
      kind: 'key',
      message: '私钥已加密，但没有提供正确的口令',
      hint: '在 profile 的 auth.passphrase 里填上口令，或生成一把不带口令的密钥专供本应用使用。',
      raw: msg,
      code: raw.code ?? 'NEED_PASSPHRASE'
    })
  }
  if (lower.includes('permission denied')) {
    return new SshError({
      kind: 'auth',
      message: `认证失败：${ctx.username ?? '当前用户'}@${target}`,
      hint: '检查用户名、密钥是否对应。若服务端只允许特定来源登录，也会表现为 Permission denied。',
      raw: msg,
      code: raw.code ?? 'PERMISSION_DENIED'
    })
  }

  // —— 握手 / 通道 ——
  if (lower.includes('timed out while waiting for handshake') || lower.includes('handshake timeout')) {
    return new SshError({
      kind: 'handshake',
      message: `与 ${target} 握手超时`,
      hint: 'TCP 通了但 SSH 协商没完成，通常是链路太慢（试试连跳板机）或对方 sshd 负载过高。',
      raw: msg,
      retryable: true
    })
  }
  if (lower.includes('no matching') && lower.includes('algorithm')) {
    return new SshError({
      kind: 'handshake',
      message: '与服务端的加密算法没有交集',
      hint: '服务端可能只开了很老的算法。这属于集群侧配置，客户端改不了。',
      raw: msg
    })
  }
  if (lower.includes('channel open failure')) {
    return new SshError({
      kind: 'channel',
      message: '开不了新的 SSH 通道',
      hint: '并发数超过了服务端 MaxSessions（OpenSSH 默认 10）。把 profile 的 maxConcurrent 调小，或等当前操作结束。',
      raw: msg,
      code: raw.code ?? 'CHANNEL_OPEN_FAILURE',
      retryable: true
    })
  }
  if (lower.includes('not connected')) {
    return new SshError({
      kind: 'reset',
      message: `连接 ${target} 尚未建立或已断开`,
      raw: msg,
      code: raw.code ?? 'NOT_CONNECTED',
      retryable: true
    })
  }
  if (lower.includes('keepalive timeout')) {
    return new SshError({
      kind: 'reset',
      message: `与 ${target} 的连接被服务端断开（心跳超时）`,
      hint: '跳板机通常会清理长时间空闲的连接，重连即可。',
      raw: msg,
      code: raw.code ?? 'KEEPALIVE_TIMEOUT',
      retryable: true
    })
  }

  // —— 本地密钥文件 ——
  if (code === 'ENOENT' || lower.includes('no such file or directory')) {
    return new SshError({
      kind: 'config',
      message: '找不到本地文件',
      hint: '私钥路径写错了，或文件被移走了。路径支持 `~`，相对路径以 config 目录为基准。',
      raw: msg,
      code
    })
  }
  if (code === 'EACCES') {
    return new SshError({
      kind: 'config',
      message: '没有权限读取私钥文件',
      hint: '检查文件权限，Windows 上确认文件没有被其他进程独占。',
      raw: msg,
      code
    })
  }

  return new SshError({
    kind: 'unknown',
    message: msg || '未知错误',
    raw: msg || String(err),
    code: raw.code
  })
}

/** 远端命令非 0 退出时用：把 stderr 原样带出去，不做任何美化 */
export function remoteFailure(command: string, code: number | null, stderr: string): SshError {
  const trimmed = stderr.trim()
  return new SshError({
    kind: 'remote',
    message: `命令执行失败（退出码 ${code ?? 'null'}）`,
    hint: trimmed ? undefined : '命令没有输出错误信息，可能是权限或环境变量问题；试试在交互式登录里手动跑一遍。',
    raw: [`$ ${command}`, trimmed || '（stderr 为空）'].join('\n'),
    code: String(code)
  })
}

/** 终端里打印一个错误：人话在前，原文缩进在后 */
export function formatSshError(err: unknown, indent = '      '): string {
  const e = normalizeSshError(err)
  const lines = [`${indent}${e.message}`]
  if (e.hint) lines.push(`${indent}→ ${e.hint}`)
  if (e.raw && e.raw.trim() && e.raw.trim() !== e.message) {
    lines.push(`${indent}原始信息：`)
    for (const line of e.raw.trim().split(/\r?\n/)) lines.push(`${indent}  ${line}`)
  }
  return lines.join('\n')
}
