/**
 * 凭据的种类与作用域。
 *
 * ## 为什么不用"一个密码"
 *
 * 这三类凭据的**作用域完全不同**，混成一个字段一定会取错：
 *
 * | 种类 | scope 是什么 | 为什么 |
 * |---|---|---|
 * | `ssh-password` | **profileId** | 每台跳板机可能是不同的本地账号 |
 * | `key-passphrase` | **私钥文件的绝对路径** | 同一把 key 会被多条 profile 复用；反过来同一个 profile 也可能换 key |
 * | `platform-password` | **账号名** | 转账走的是 LDAP，跨 profile 是同一个账号 |
 *
 * 举一个真实的错法：把 `ssh-password` 按"账号名"存。你在 cluster 和 jump
 * 两台机器上都叫 `user01`，但密码不同——存成一条之后，切到 jump 会用 cluster
 * 的密码去连，报"密码错误"，而你会以为是自己记错了。
 *
 * ## scope 必须规范化
 *
 * `key-passphrase` 的 scope 是文件路径。同一个文件用 `~/.ssh/id_ed25519`、
 * `C:\Users\x\.ssh\id_ed25519`、`c:/users/x/.ssh/id_ed25519` 三种写法指的都是同一个，
 * 不规范化就会存成三条互不相认的记录，用户设了密码却还是被问。
 */
import { resolve, sep } from 'node:path'

export type CredentialKind = 'ssh-password' | 'key-passphrase' | 'platform-password'

export interface CredentialKindMeta {
  kind: CredentialKind
  /** 界面上给用户看的名字 */
  label: string
  /** scope 是什么，用来生成提示文案 */
  scopeLabel: string
  hint: string
}

export const CREDENTIAL_KINDS: CredentialKindMeta[] = [
  {
    kind: 'ssh-password',
    label: 'SSH 登录密码',
    scopeLabel: '跳板机',
    hint: 'profile 里 auth.method 是 password 时用。每个跳板机单独一份。'
  },
  {
    kind: 'key-passphrase',
    label: '私钥口令',
    scopeLabel: '私钥文件',
    hint: '私钥本身带口令（生成时输了 passphrase）时才需要，按文件路径区分。'
  },
  {
    kind: 'platform-password',
    label: '平台账号密码',
    scopeLabel: '账号',
    hint: '赠送点数这类操作要的 LDAP 密码。跨跳板机是同一个账号。'
  }
]

const KIND_SET = new Set<string>(CREDENTIAL_KINDS.map((meta) => meta.kind))

export function isCredentialKind(value: unknown): value is CredentialKind {
  return typeof value === 'string' && KIND_SET.has(value)
}

/**
 * 把 scope 归一成"同一个东西只有一种写法"。
 *
 * - `key-passphrase`：转成绝对路径，分隔符统一成 `/`（Windows 的 `\` 和 `/` 是同一个文件）
 * - 其它：只 trim。profileId 和账号名都是用户自己填的标识，不猜别名
 *
 * 空 scope 直接抛：一条 scope 为空的凭据永远取不回来，是被写坏的数据。
 * 在这里抛比存进去之后表现成"密码莫名其妙没了"要好。
 */
export function normalizeScope(kind: CredentialKind, scope: string): string {
  const trimmed = scope.trim()
  if (trimmed.length === 0) {
    throw new Error('scope 不能为空')
  }
  if (kind === 'key-passphrase') {
    // resolve 会处理 `~` 吗？不会——`~` 由调用方先展开（profiles.ts 已经有那套逻辑），
    // 这里只做"同义写法归一"，不做家庭目录猜测
    return resolve(trimmed).split(sep).join('/')
  }
  return trimmed
}

/**
 * 存储键。
 *
 * 用 `::` 分隔而不是对象，是因为底层 KV 只有字符串键。`::` 在
 * profileId（`[A-Za-z0-9._-]`）和路径里都不可能自然出现，不会撞车。
 */
export function credentialKey(kind: CredentialKind, scope: string): string {
  return `${kind}::${normalizeScope(kind, scope)}`
}

/**
 * 界面上的"这条凭据属于谁"。
 *
 * 路径取最后两段就够了（`id_ed25519` + 上一级目录名），
 * 完整路径太长会把设置页撑破，而且前面几段对用户没有信息量。
 */
export function describeScope(kind: CredentialKind, scope: string): string {
  if (kind !== 'key-passphrase') return scope
  const parts = normalizeScope(kind, scope).split('/').filter((part) => part.length > 0)
  if (parts.length <= 2) return parts.join('/')
  return `…/${parts.slice(-2).join('/')}`
}
