/**
 * 把保险库里的凭据填进 profile。
 *
 * 调用点在 `ProfileState.current()`——所有要连网络的地方都从那里拿 profile
 * （MEMORY 第 25 条：不要在每个调用点各传一次）。所以只要这一处接上，
 * 终端、隧道、传输、诊断、转账全都自动用上已保存的密码，不会漏。
 *
 * ## 三条规则
 *
 * 1. **配置文件里的明文优先**。老用户手写的 `auth.password` 仍然生效，
 *    不会被"库里没有"打断。但界面会提示他迁走（见 `findPlaintextAuth`）。
 * 2. **取不到就留空，不抛异常**。`current()` 也被 `list()` 调用（只为了拿
 *    activeId），在那里抛异常会让整个跳板机切换器挂掉。
 *    真正的报错点在 `session.ts`，那时才说明"密码还没配"。
 * 3. **解不开要留痕**。`undecryptable` 和"没存过"对用户来说是两件事：
 *    前者是"换了电脑/账户"，后者是"还没填"。留一条 `credentialIssue`
 *    让 `session.ts` 能说出具体原因。
 */
import type { ResolvedProfile } from '../profiles'
import type { CredentialVault } from './vault'

export interface CredentialIssue {
  kind: 'missing' | 'undecryptable'
  /** 直接可以显示给用户的一句话 */
  message: string
}

/**
 * 给 profile 补上密码/口令。返回**新对象**，不改入参。
 */
export function applyCredentials(
  profile: ResolvedProfile,
  vault: CredentialVault
): ResolvedProfile {
  const { auth } = profile

  if (auth.method === 'password') {
    // 配置文件里写了就照用——迁移期不能让老配置失效
    if (auth.password && auth.password.length > 0) {
      return profile
    }

    const found = vault.get('ssh-password', profile.id)
    if (found.ok) {
      return { ...profile, auth: { ...auth, password: found.secret } }
    }

    return {
      ...profile,
      credentialIssue: {
        kind: found.reason,
        message:
          found.reason === 'undecryptable'
            ? `${profile.label} 的密码存过但解不开（多半是换了 Windows 账户或重装了系统），重新输一次就好。`
            : `${profile.label} 用密码登录，但还没保存密码。`
      }
    }
  }

  // method === 'key'
  if (auth.passphrase && auth.passphrase.length > 0) return profile

  const keyPath = auth.privateKeyPath
  // 没有路径是另一种配置错误，交给 session.ts 去报（那里有更准的提示）
  if (!keyPath) return profile

  const found = vault.get('key-passphrase', keyPath)
  if (found.ok) {
    return { ...profile, auth: { ...auth, passphrase: found.secret } }
  }
  // 私钥**不一定**带口令，所以"没找到"是正常状态，不能记成 issue。
  // 只有"存过但解不开"才值得提醒——否则每个不用口令的用户都会看到警告。
  if (found.reason === 'undecryptable') {
    return {
      ...profile,
      credentialIssue: {
        kind: 'undecryptable',
        message: `私钥 ${keyPath} 的口令存过但解不开，重新输一次就好。`
      }
    }
  }
  return profile
}

/**
 * 找出配置文件里还写着明文的凭据。
 *
 * 用于启动时提示"要不要迁到加密存储"。**只报告，不自动改**——
 * `profiles.json` 是用户自己手写的文件，程序擅自改写会让人不敢再用。
 *
 * 返回的是"哪条 profile 的哪个字段"，不含密码本身（别把明文读出来放进内存里
 * 多传一圈，没必要）。
 */
export function findPlaintextAuth(
  profiles: ResolvedProfile[],
  options: {
    /** 加密存储能不能用。false 时界面只能提供"清掉"，不能提供"迁移" */
    canEncrypt: boolean
  }
): {
  profileId: string
  label: string
  field: 'password' | 'passphrase'
  canEncrypt: boolean
}[] {
  const out: {
    profileId: string
    label: string
    field: 'password' | 'passphrase'
    canEncrypt: boolean
  }[] = []

  for (const profile of profiles) {
    const { auth } = profile
    if (auth.method === 'password' && auth.password && auth.password.length > 0) {
      out.push({
        profileId: profile.id,
        label: profile.label,
        field: 'password',
        canEncrypt: options.canEncrypt
      })
    }
    if (auth.method === 'key' && auth.passphrase && auth.passphrase.length > 0) {
      out.push({
        profileId: profile.id,
        label: profile.label,
        field: 'passphrase',
        canEncrypt: options.canEncrypt
      })
    }
  }
  return out
}
