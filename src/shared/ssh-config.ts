/**
 * `~/.ssh/config` 解析（纯函数）。
 *
 * ## 只做"能填进向导"的那部分
 *
 * 完整的 ssh_config 支持几十个关键字、通配符、`Include`、`Match`、`%d/%h` 展开。
 * 这里只取四个能填进表单的：`HostName` / `User` / `Port` / `IdentityFile`，
 * 再加一条 `ProxyJump`（只为**给出警告**，不实现）。
 *
 * 宁可少解析，也不要猜错一个字段——填错端口的表现是"一直超时"，
 * 用户根本不会想到是导入功能给的错值。
 *
 * ## 三条必须照抄的语义
 *
 * 1. **先到先得**：同一个关键字在多个匹配块里出现时，**第一次**出现的生效
 *    （ssh 是 first-obtained-wins，不是后者覆盖）。`Host *` 写在文件最后还能
 *    当默认值，正是因为"先到先得"——前面没给过的才轮到它。
 * 2. **`Host` 一行可以写多个模式**，空格分隔，支持 `*` `?` 和 `!` 取反。
 * 3. **`Host *` 之类的通配块本身不是主机**，只提供默认值，不能出现在列表里。
 */
export interface SshConfigHost {
  /** `Host` 后面的具体名字，也就是 `ssh <alias>` 里那个 */
  alias: string
  /** 实际地址；没写 `HostName` 时等于 alias */
  hostName: string
  user?: string
  port?: number
  /** 可能带 `~` 或相对 `~/.ssh` 的写法，原样返回，由调用方展开 */
  identityFile?: string
  proxyJump?: string
}

export interface SshConfigParseResult {
  hosts: SshConfigHost[]
  /** 解析时遇到的问题。**必须显示给用户**——静默丢配置比报错更坏 */
  warnings: string[]
}

interface Block {
  patterns: string[]
  /** 关键字 → 第一次出现的值（小写键） */
  values: Map<string, string>
  /** `Match` 块整块跳过 */
  skip: boolean
}

const KEYWORDS = new Set(['hostname', 'user', 'port', 'identityfile', 'proxyjump', 'proxycommand', 'match'])

export function parseSshConfig(text: string): SshConfigParseResult {
  const warnings: string[] = []
  const blocks: Block[] = []
  let current: Block | null = null
  let includes = 0

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim()
    if (!line) continue

    const { key, value } = splitDirective(line)
    if (!key) continue
    const lower = key.toLowerCase()

    if (lower === 'host') {
      current = { patterns: splitPatterns(value), values: new Map(), skip: false }
      if (current.patterns.length === 0) {
        warnings.push(`有一行 "Host" 没写主机名，已跳过：${rawLine.trim()}`)
        current.skip = true
      }
      blocks.push(current)
      continue
    }

    if (lower === 'match') {
      // `Match` 之后的条件块，语义（条件匹配）超出这里的范围，整块跳过
      current = { patterns: [], values: new Map(), skip: true }
      blocks.push(current)
      continue
    }

    if (lower === 'include') {
      // 不展开：展开要递归读文件，而且导入结果里"这段是哪来的"会变得说不清
      includes += 1
      continue
    }

    if (!current) {
      // 文件开头、任何 `Host` 之前的指令：ssh 里属于全局段，等价于 `Host *`
      current = { patterns: ['*'], values: new Map(), skip: false }
      blocks.push(current)
    }
    if (current.skip) continue

    if (!KEYWORDS.has(lower)) continue
    // ssh 允许把值写成 "带 空格 的路径"，存进去之前去掉外层引号
    if (!current.values.has(lower)) current.values.set(lower, unquote(value))
  }

  if (includes > 0) {
    warnings.push(`配置里有 ${includes} 处 Include，没有展开——它引入的主机不会出现在下面的列表里`)
  }

  const aliases: string[] = []
  for (const block of blocks) {
    if (block.skip) continue
    for (const pattern of block.patterns) {
      // 通配模式不是具体主机，只当默认值用
      if (isPattern(pattern)) continue
      if (!aliases.includes(pattern)) aliases.push(pattern)
    }
  }

  const hosts: SshConfigHost[] = aliases.map((alias) => {
    const merged = new Map<string, string>()
    for (const block of blocks) {
      if (block.skip) continue
      if (!blockMatches(block, alias)) continue
      // 先到先得：已经有的键不再覆盖
      for (const [key, value] of block.values) {
        if (!merged.has(key)) merged.set(key, value)
      }
    }

    const portText = merged.get('port')
    let port: number | undefined
    if (portText !== undefined) {
      const parsed = Number(portText)
      if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) port = parsed
      else warnings.push(`${alias}: Port "${portText}" 不是有效端口，已忽略`)
    }

    const identityFile = merged.get('identityfile')
    const proxyJump = merged.get('proxyjump')
    if (proxyJump) {
      warnings.push(`${alias}: 配了 ProxyJump（经 ${proxyJump} 跳转），本应用是直连的，导入后可能连不上`)
    }

    return {
      alias,
      hostName: merged.get('hostname') ?? alias,
      user: merged.get('user'),
      port,
      identityFile,
      proxyJump
    }
  })

  return { hosts, warnings }
}

/** 去掉成对的外层引号 */
function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** 去掉 `#` 注释。引号里的 `#` 不算注释 */
function stripComment(line: string): string {
  let inQuote = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === '"') inQuote = !inQuote
    else if (ch === '#' && !inQuote) return line.slice(0, i)
  }
  return line
}

/** `Key Value` 或 `Key=Value` 两种写法都出现过 */
function splitDirective(line: string): { key: string; value: string } {
  const eq = line.indexOf('=')
  const space = line.search(/\s/)
  if (eq > 0 && (space === -1 || eq < space)) {
    return { key: line.slice(0, eq).trim(), value: line.slice(eq + 1).trim() }
  }
  if (space === -1) return { key: line.trim(), value: '' }
  return { key: line.slice(0, space).trim(), value: line.slice(space + 1).trim() }
}

function splitPatterns(value: string): string[] {
  return value
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function isPattern(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?')
}

/** `*` 和 `?` 够用了；`!` 取反按 ssh 语义：任一条命中就排除整块 */
function blockMatches(block: Block, alias: string): boolean {
  let matched = false
  for (const pattern of block.patterns) {
    const negated = pattern.startsWith('!')
    const body = negated ? pattern.slice(1) : pattern
    if (globMatch(body, alias)) {
      if (negated) return false
      matched = true
    }
  }
  return matched
}

function globMatch(pattern: string, text: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i')
  return regex.test(text)
}

/**
 * 把解析到的 Host 条目变成向导的表单值。
 *
 * 只覆盖"能确定的"：名称、主机、端口、用户名、私钥路径。
 * 私钥口令、密码一律不猜——那两样不在 `ssh config` 里。
 */
export interface ImportedDraft {
  label: string
  host: string
  port: string
  username: string
  privateKeyPath: string
}

export function draftFromSshHost(host: SshConfigHost): ImportedDraft {
  return {
    label: host.alias,
    host: host.hostName,
    port: host.port ? String(host.port) : '22',
    username: host.user ?? '',
    privateKeyPath: host.identityFile ?? ''
  }
}
