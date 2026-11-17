/**
 * 首次配置向导的**输入规则**（纯函数，界面和主进程共用）。
 *
 * ## 为什么规则要和 `profiles.ts` 保持一致
 *
 * 这里做的是"输入框旁边的即时提示"，最终写盘前主进程还会用
 * `validateProfiles()` 再验一遍——**两套规则就有两个真相**，迟早给出
 * "都填对了却存不进去"或"存进去了却连不上"这种自相矛盾的体验。
 *
 * 所以分工是：
 * - 这里只做**格式**（必填、范围、明显错误），措辞面向"正在填表的人"
 * - `profiles.ts` 做**语义**（id 唯一、defaultProfile 存在、auth 结构），
 *   那是整份文件才看得出来的问题
 *
 * 两边都不许放宽：这里放过、那边拦下，用户会在最后一步看到一堆看不懂的错误。
 */
export type SetupMethod = 'key' | 'password'

export interface SetupDraft {
  /** 显示名，可空（默认"我的集群"） */
  label: string
  host: string
  /** 表单里是字符串，解析在 `validateSetupDraft` 里做 */
  port: string
  username: string
  method: SetupMethod
  privateKeyPath: string
  /** 私钥口令（可选，只进钥匙串） */
  passphrase: string
  /** 登录密码（method=password 时必填，只进钥匙串，**永不写进 JSON**） */
  password: string
}

export type SetupField =
  | 'label'
  | 'host'
  | 'port'
  | 'username'
  | 'privateKeyPath'
  | 'passphrase'
  | 'password'
  | 'general'

export interface SetupIssue {
  field: SetupField
  message: string
}

export const SETUP_DEFAULTS = {
  label: '我的集群',
  port: '22'
} as const

export function emptyDraft(): SetupDraft {
  return {
    label: SETUP_DEFAULTS.label,
    host: '',
    port: SETUP_DEFAULTS.port,
    username: '',
    method: 'key',
    privateKeyPath: '',
    passphrase: '',
    password: ''
  }
}

export function validateSetupDraft(draft: SetupDraft): SetupIssue[] {
  const issues: SetupIssue[] = []

  if (draft.label.trim().length > 40) {
    issues.push({ field: 'label', message: '名称最长 40 个字符（只是显示用）' })
  }

  const host = draft.host.trim()
  if (!host) {
    issues.push({ field: 'host', message: '必填：集群的登录地址，例如 login.example.edu.cn' })
  } else if (/^ssh:\/\//i.test(host) || host.includes('/')) {
    issues.push({ field: 'host', message: '只填主机名或 IP，不要带 ssh:// 或路径' })
  } else if (/\s/.test(host)) {
    issues.push({ field: 'host', message: '主机名里不能有空格' })
  }

  const rawPort = draft.port.trim()
  const port = Number(rawPort)
  if (!rawPort) {
    issues.push({ field: 'port', message: '必填，默认 22' })
  } else if (!Number.isInteger(port) || port < 1 || port > 65535) {
    issues.push({ field: 'port', message: '必须是 1–65535 的整数' })
  }

  const username = draft.username.trim()
  if (!username) {
    issues.push({ field: 'username', message: '必填：你在集群上的用户名' })
  } else if (/\s/.test(username)) {
    issues.push({ field: 'username', message: '用户名里不能有空格' })
  }

  if (draft.method === 'key') {
    const keyPath = draft.privateKeyPath.trim()
    if (!keyPath) {
      issues.push({ field: 'privateKeyPath', message: '必填：私钥文件路径，支持 ~ 开头' })
    } else if (/\.ppk$/i.test(keyPath)) {
      issues.push({
        field: 'privateKeyPath',
        message: '不支持 PuTTY 的 .ppk，请先转成 OpenSSH 私钥（puttygen → Conversions → Export OpenSSH key）'
      })
    }
  } else if (!draft.password) {
    /*
     * 密码在向导里**必填**（虽然 `profiles.json` 允许留空）。
     *
     * 那个"允许留空"是给老用户 + 钥匙串设计的；首次配置如果也放过，
     * 用户会得到一个"看起来配好了但一连就报没密码"的环境——
     * 第一次用就踩坑，比多填一个框糟得多。
     */
    issues.push({ field: 'password', message: '必填：登录密码。只存进系统钥匙串，不会写进配置文件' })
  }

  return issues
}

/** 把界面上的问题按字段收成一张表，方便 `issuesFor('host')` 这种取法 */
export function groupIssues(issues: SetupIssue[]): Partial<Record<SetupField, string>> {
  const out: Partial<Record<SetupField, string>> = {}
  for (const issue of issues) {
    if (!out[issue.field]) out[issue.field] = issue.message
  }
  return out
}

/**
 * 由显示名推 profile id。
 *
 * 必须是 `[A-Za-z0-9_-]`（`profiles.ts` 会拦），而名称通常是中文——
 * 中文全部丢掉后如果是空的，退回 `cluster`。id 只用于凭据的 scope 和日志，
 * 用户看不到也不需要唯一化：向导只建一个 profile。
 */
export function setupProfileId(label: string): string {
  const ascii = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return ascii || 'cluster'
}
