/**
 * profile 配置：主机、端口、用户、密钥路径的唯一来源。
 *
 * 硬约束（见 docs/03 §1）：源码里不允许出现主机地址、用户名、集群路径。
 * 所有连接参数只能来自 config/profiles.json，该文件已被 .gitignore 排除。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'

export type AuthMethod = 'key' | 'password'

export interface ProfileAuth {
  method: AuthMethod
  /** method=key 时必填，支持 `~` 与相对 config 目录的相对路径 */
  privateKeyPath?: string
  /** 加密私钥的口令，可选 */
  passphrase?: string
  /** method=password 时必填 */
  password?: string
}

export interface Profile {
  id: string
  label?: string
  host: string
  port: number
  username: string
  auth: ProfileAuth
  /** 并发 exec 通道上限，默认 5，不得超过服务端 MaxSessions（OpenSSH 默认 10） */
  maxConcurrent?: number
  connectTimeoutMs?: number
  keepaliveIntervalMs?: number
  /** 首次连接的未知主机是否自动记录指纹（TOFU）。默认 true；指纹变更永远拒绝 */
  trustNewHostKey?: boolean
  /** 配额命令，不同平台不同，默认见 capabilities.ts */
  quotaCommand?: string
}

export interface ProfilesFile {
  version?: number
  defaultProfile?: string
  profiles: Profile[]
}

/** 补齐默认值后的 profile，连接层只吃这个类型 */
export interface ResolvedProfile {
  id: string
  label: string
  host: string
  port: number
  username: string
  auth: ProfileAuth
  maxConcurrent: number
  connectTimeoutMs: number
  keepaliveIntervalMs: number
  trustNewHostKey: boolean
  quotaCommand: string
  /**
   * 凭据没取到时的说明（`credentials/resolve.ts` 填的）。
   *
   * 为什么挂在 profile 上而不是抛异常：`ProfileState.current()` 也被
   * `list()` 调用（只为了拿 activeId），在那里抛会让跳板机切换器整个挂掉。
   * 真正要报错的时刻是"要连接了"，那时 `session.ts` 会读这个字段给出准确原因。
   */
  credentialIssue?: { kind: 'missing' | 'undecryptable'; message: string }
}

export interface LoadedProfiles {
  /** 配置文件绝对路径 */
  path: string
  /** 配置文件所在目录，用于解析相对密钥路径 */
  dir: string
  profiles: ResolvedProfile[]
  defaultProfile: string
  warnings: string[]
}

export const DEFAULT_QUOTA_COMMAND = '/usr/lpp/mmfs/bin/mmlsquota --block-size auto'

const DEFAULTS = {
  port: 22,
  maxConcurrent: 5,
  connectTimeoutMs: 15000,
  keepaliveIntervalMs: 10000
} as const

export class ConfigError extends Error {
  readonly issues: string[]
  readonly path: string

  constructor(path: string, message: string, issues: string[] = []) {
    super(message)
    this.name = 'ConfigError'
    this.path = path
    this.issues = issues
  }
}

export function defaultConfigPath(cwd: string = process.cwd()): string {
  return resolve(cwd, 'config', 'profiles.json')
}

/** 展开 `~`，并把相对路径按 baseDir 解析 */
export function expandPath(p: string, baseDir: string): string {
  let out = p.trim()
  if (out === '~') return homedir()
  if (out.startsWith('~/') || out.startsWith('~\\')) {
    out = resolve(homedir(), out.slice(2))
  }
  return isAbsolute(out) ? out : resolve(baseDir, out)
}

export function loadProfiles(path: string = defaultConfigPath()): LoadedProfiles {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      throw new ConfigError(path, `找不到配置文件：${path}`, [
        '复制仓库根目录的 profiles.example.json 到 config/profiles.json，再填入真实主机信息'
      ])
    }
    if (code === 'EACCES') {
      throw new ConfigError(path, `没有权限读取配置文件：${path}`, ['检查文件权限，或把文件放到可读目录'])
    }
    throw new ConfigError(path, `读取配置文件失败：${(e as Error).message}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (e) {
    throw new ConfigError(path, `配置文件不是合法 JSON：${(e as Error).message}`, [
      '注意 JSON 不允许注释、不允许尾随逗号'
    ])
  }

  return validateProfiles(parsed, path)
}

/** 纯函数式校验，方便单测直接喂对象 */
export function validateProfiles(parsed: unknown, path: string): LoadedProfiles {
  const issues: string[] = []
  const warnings: string[] = []

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(path, '配置文件顶层必须是一个 JSON 对象', ['最小可用内容见 profiles.example.json'])
  }

  const file = parsed as Partial<ProfilesFile>
  if (!Array.isArray(file.profiles) || file.profiles.length === 0) {
    throw new ConfigError(path, '配置文件缺少 profiles 数组，或数组为空', [
      '至少需要一个 profile，形如 { "id": "...", "host": "...", "username": "...", "auth": {...} }'
    ])
  }

  const seen = new Set<string>()
  const profiles: ResolvedProfile[] = file.profiles.map((raw, index) => {
    const at = `profiles[${index}]`
    if (typeof raw !== 'object' || raw === null) {
      issues.push(`${at}: 必须是对象`)
      return {} as ResolvedProfile
    }
    const p = raw as Partial<Profile>

    const id = typeof p.id === 'string' ? p.id.trim() : ''
    if (!id) issues.push(`${at}.id: 必填`)
    else if (!/^[A-Za-z0-9_-]+$/.test(id)) issues.push(`${at}.id: 只能包含字母、数字、下划线和短横线`)
    else if (seen.has(id)) issues.push(`${at}.id: 与前面的 profile 重复（${id}）`)
    else seen.add(id)

    const host = typeof p.host === 'string' ? p.host.trim() : ''
    if (!host) issues.push(`${at}.host: 必填`)
    else if (/^ssh:\/\//i.test(host) || host.includes('/')) {
      issues.push(`${at}.host: 只填主机名或 IP，不要带协议、路径（当前值 ${host}）`)
    }

    const username = typeof p.username === 'string' ? p.username.trim() : ''
    if (!username) issues.push(`${at}.username: 必填`)

    const port = p.port === undefined ? DEFAULTS.port : Number(p.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      issues.push(`${at}.port: 必须是 1-65535 的整数（当前值 ${String(p.port)}）`)
    }

    const auth = p.auth
    if (!auth || typeof auth !== 'object') {
      issues.push(`${at}.auth: 必填，形如 { "method": "key", "privateKeyPath": "~/.ssh/id_ed25519" }`)
    } else if (auth.method === 'key') {
      if (!auth.privateKeyPath || typeof auth.privateKeyPath !== 'string') {
        issues.push(`${at}.auth.privateKeyPath: method=key 时必填`)
      } else if (/\.ppk$/i.test(auth.privateKeyPath)) {
        issues.push(
          `${at}.auth.privateKeyPath: 不支持 PuTTY 的 .ppk 格式，请先转成 OpenSSH 私钥（puttygen → Conversions → Export OpenSSH key）`
        )
      }
    } else if (auth.method === 'password') {
      /*
       * 密码**允许不写**。
       *
       * 以前这里是必填，因为那时候密码只能写在配置文件里。现在密码由
       * 凭据库（设置 → 登录凭据，走系统钥匙串加密）提供，
       * 继续强制必填只会逼着用户把明文写进 profiles.json——
       * 那正是我们要消掉的东西。
       *
       * 真没配密码时的报错在 `session.ts`：那里能说清"去设置里存一下"，
       * 比在加载配置时拦下来有用得多（加载失败会让整个应用起不来）。
       */
      if (auth.password !== undefined && typeof auth.password !== 'string') {
        issues.push(`${at}.auth.password: 如果写，必须是字符串`)
      }
    } else {
      issues.push(`${at}.auth.method: 只能是 "key" 或 "password"（当前值 ${String(auth?.method)}）`)
    }

    const maxConcurrent = p.maxConcurrent === undefined ? DEFAULTS.maxConcurrent : Number(p.maxConcurrent)
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 10) {
      issues.push(`${at}.maxConcurrent: 必须是 1-10 的整数（服务端 MaxSessions 默认 10，本项默认 5）`)
    } else if (maxConcurrent > 6) {
      warnings.push(`${at}.maxConcurrent=${maxConcurrent}: 超过 6 通常不再有收益，且可能触发 channel open failure`)
    }

    return {
      id,
      label: typeof p.label === 'string' && p.label.trim() ? p.label.trim() : id,
      host,
      port: Number.isInteger(port) ? port : DEFAULTS.port,
      username,
      auth: (auth ?? { method: 'key' }) as ProfileAuth,
      maxConcurrent: Number.isInteger(maxConcurrent) ? maxConcurrent : DEFAULTS.maxConcurrent,
      connectTimeoutMs: positiveInt(p.connectTimeoutMs, DEFAULTS.connectTimeoutMs, `${at}.connectTimeoutMs`, issues),
      keepaliveIntervalMs: positiveInt(
        p.keepaliveIntervalMs,
        DEFAULTS.keepaliveIntervalMs,
        `${at}.keepaliveIntervalMs`,
        issues
      ),
      trustNewHostKey: p.trustNewHostKey !== false,
      quotaCommand:
        typeof p.quotaCommand === 'string' && p.quotaCommand.trim()
          ? p.quotaCommand.trim()
          : DEFAULT_QUOTA_COMMAND
    }
  })

  if (issues.length > 0) {
    throw new ConfigError(path, `配置文件有 ${issues.length} 处问题，已阻止连接`, issues)
  }

  // 密钥路径在这里一次性解析成绝对路径，下游（连接层、探针）不再关心 `~` 和相对路径
  const dir = dirname(path)
  const normalized = profiles.map((p) => ({
    ...p,
    auth:
      p.auth.method === 'key' && p.auth.privateKeyPath
        ? { ...p.auth, privateKeyPath: expandPath(p.auth.privateKeyPath, dir) }
        : p.auth
  }))

  const defaultProfile =
    typeof file.defaultProfile === 'string' && file.defaultProfile.trim()
      ? file.defaultProfile.trim()
      : profiles[0]!.id

  if (!profiles.some((p) => p.id === defaultProfile)) {
    throw new ConfigError(path, `defaultProfile 指向不存在的 profile：${defaultProfile}`, [
      `可用的 profile：${profiles.map((p) => p.id).join('、')}`
    ])
  }

  return { path, dir, profiles: normalized, defaultProfile, warnings }
}

function positiveInt(value: unknown, fallback: number, field: string, issues: string[]): number {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) {
    issues.push(`${field}: 必须是正整数（当前值 ${String(value)}）`)
    return fallback
  }
  return n
}

export function pickProfile(loaded: LoadedProfiles, id?: string): ResolvedProfile {
  const target = id?.trim() || loaded.defaultProfile
  const found = loaded.profiles.find((p) => p.id === target)
  if (!found) {
    throw new ConfigError(loaded.path, `找不到 profile：${target}`, [
      `可用的 profile：${loaded.profiles.map((p) => p.id).join('、')}`
    ])
  }
  return found
}

/** 把 profile 里的密钥路径解析成绝对路径 */
export function resolveKeyPath(loaded: LoadedProfiles, profile: ResolvedProfile): string {
  const raw = profile.auth.privateKeyPath
  if (!raw) {
    throw new ConfigError(loaded.path, `profile ${profile.id} 未配置 auth.privateKeyPath`)
  }
  return expandPath(raw, loaded.dir)
}
