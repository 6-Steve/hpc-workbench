/**
 * 诊断包的脱敏（纯函数）。
 *
 * ## 为什么单独一层
 *
 * 诊断包**是会被发出去的**（发给同学、发给帮你排障的人）。脱敏出错不是"显示不好看"，
 * 是泄露。所以这段逻辑必须与打包流程分开、可单测，并且测试里有一条"全文搜不到密码"的硬断言。
 *
 * ## 两层策略
 *
 * | 对象 | 策略 |
 * |---|---|
 * | 结构化配置（`profiles.json`） | **白名单**：只输出认识的那几个字段，绝不"读进来再替换" |
 * | 自由文本（命令原文、输出） | **黑名单扫描**：命令里可能嵌任何东西，只能靠模式抓 |
 *
 * 配置走白名单的理由：正则替换的失败方式是"多一个字段就多一个漏点"，
 * 而白名单的失败方式是"新字段没显示"——前者是事故，后者只是信息不全。
 */

/** IPv4 留前两段；IPv6 留前两组；域名留首尾两位 */
export function maskHost(host: string): string {
  const value = (host ?? '').trim()
  if (!value) return ''

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    const parts = value.split('.')
    return `${parts[0]}.${parts[1]}.*.*`
  }

  if (value.includes(':')) {
    const groups = value.split(':')
    return `${groups[0]}:${groups[1] ?? ''}:*`
  }

  if (value.length <= 4) return '***'

  /*
   * 域名：留开头两位 + 顶级域。
   * TLD（edu.cn / com）对判断"这在校园网内还是公网"有用，而中间那几段是真正的标识。
   */
  const labels = value.split('.')
  if (labels.length >= 2) {
    return `${value.slice(0, 2)}***.${labels[labels.length - 1]}`
  }
  return `${value.slice(0, 2)}***${value.slice(-2)}`
}

/** 首字符 + 末字符 + 长度：`alice` → `a***e(5)` */
export function maskUsername(user: string): string {
  const value = (user ?? '').trim()
  if (!value) return ''
  if (value.length <= 2) return `***(${value.length})`
  return `${value[0]}***${value[value.length - 1]}(${value.length})`
}

/**
 * 私钥路径只留文件名，目录一律收成 `~/.ssh/` 或 `…/`。
 *
 * 路径里通常带用户名（`C:\Users\alice\...`），而"用户的私钥放在哪"对诊断没有价值。
 */
export function maskKeyPath(input: string): string {
  const value = (input ?? '').trim()
  if (!value) return ''
  const normalized = value.replace(/\\/g, '/')
  const name = normalized.split('/').filter(Boolean).pop() ?? 'key'
  return normalized.includes('/.ssh/') ? `~/.ssh/${name}` : `…/${name}`
}

/** 把路径里的用户名段换成 `<user>`（配置目录、日志路径都用它） */
export function maskHomePath(text: string): string {
  return (text ?? '')
    .replace(/([A-Za-z]:[\\/]Users[\\/])[^\\/]+/gi, '$1<user>')
    .replace(/([\\/]home[\\/])[^\\/\s]+/g, '$1<user>')
    .replace(/([\\/]Users[\\/])[^\\/\s]+/g, '$1<user>')
}

/**
 * 扫自由文本里的秘密。
 *
 * **宁可多遮**：遮错了只是少一条线索，漏遮是事故。
 * 所以连 `-pXXXX` 这种"可能是密码也可能是分区名"的写法也一并遮掉。
 */
export function scrubSecrets(text: string): string {
  return (text ?? '')
    .replace(
      /((?:password|passwd|passphrase|token|secret|api[_-]?key|auth)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1***'
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
    .replace(/(^|\s)-p([^\s-]{6,})/g, '$1-p***')
}

export interface RedactedProfileEntry {
  id: string
  label: string
  host: string
  port: number
  username: string
  /** 只留认证方式和脱敏后的路径；**密码永远不出现** */
  auth: { method: string; privateKeyPath?: string }
  maxConcurrent?: number
  connectTimeoutMs?: number
  keepaliveIntervalMs?: number
  trustNewHostKey?: boolean
}

export interface RedactedProfiles {
  defaultProfile?: string
  profiles: RedactedProfileEntry[]
}

/**
 * 白名单式地重建 `profiles.json`。
 *
 * 注意这里是"挑字段"，不是"删字段"：文件里将来多一个 `proxy`、`jumpHost` 之类，
 * 默认不会出现在包里——这正是我们要的。
 */
export function redactProfilesFile(raw: unknown): RedactedProfiles {
  const file = (raw ?? {}) as {
    defaultProfile?: unknown
    profiles?: unknown
  }
  const list = Array.isArray(file.profiles) ? file.profiles : []

  const profiles = list.map((item): RedactedProfileEntry => {
    const p = (item ?? {}) as Record<string, unknown>
    const auth = (p.auth ?? {}) as Record<string, unknown>
    const method = typeof auth.method === 'string' ? auth.method : 'unknown'

    const entry: RedactedProfileEntry = {
      id: String(p.id ?? ''),
      label: String(p.label ?? ''),
      host: maskHost(String(p.host ?? '')),
      port: Number(p.port ?? 0),
      username: maskUsername(String(p.username ?? '')),
      auth: { method }
    }
    if (method === 'key' && typeof auth.privateKeyPath === 'string') {
      entry.auth.privateKeyPath = maskKeyPath(auth.privateKeyPath)
    }
    if (typeof p.maxConcurrent === 'number') entry.maxConcurrent = p.maxConcurrent
    if (typeof p.connectTimeoutMs === 'number') entry.connectTimeoutMs = p.connectTimeoutMs
    if (typeof p.keepaliveIntervalMs === 'number') entry.keepaliveIntervalMs = p.keepaliveIntervalMs
    if (typeof p.trustNewHostKey === 'boolean') entry.trustNewHostKey = p.trustNewHostKey
    return entry
  })

  return {
    defaultProfile: typeof file.defaultProfile === 'string' ? file.defaultProfile : undefined,
    profiles
  }
}

/** 已知主机指纹：host 键脱敏，算法与指纹保留（诊断需要，且指纹不是秘密） */
export function redactKnownHosts(raw: unknown): { version: number; hosts: Record<string, unknown> } {
  const file = (raw ?? {}) as { version?: unknown; hosts?: Record<string, unknown> }
  const hosts: Record<string, unknown> = {}

  for (const [key, records] of Object.entries(file.hosts ?? {})) {
    // 键是 `host:port`
    const sep = key.lastIndexOf(':')
    const host = sep > 0 ? key.slice(0, sep) : key
    const port = sep > 0 ? key.slice(sep + 1) : ''
    hosts[`${maskHost(host)}${port ? `:${port}` : ''}`] = records
  }

  return { version: Number(file.version ?? 1), hosts }
}
