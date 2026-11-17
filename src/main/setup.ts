/**
 * 把首次向导收集到的输入变成 `profiles.json`（+ 凭据）。
 *
 * ## 为什么写盘这一步必须放在主进程
 *
 * 三个理由，每个都是硬约束：
 * 1. 渲染层**没有 Node**，写不了文件（这是架构，不是偏好）。
 * 2. 私钥存不存在只有主进程查得到——在界面上填一个不存在的路径，
 *    要到连的时候才发现，属于"配好了但连不上"的典型。
 * 3. 密码绝不能出现在渲染层与磁盘之间的任何中间态。这里只做
 *    `vault.set()`，**明文一次都不落盘**。
 *
 * ## 顺序
 *
 * 先校验 → 再写配置 → 最后存凭据。凭据失败只降级成警告：
 * 配置文件已经写好了，用户重开就能用，密码可以稍后在设置里补。
 * 反过来（先存凭据再写配置失败）会留下一条孤儿凭据，更糟。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setupProfileId, validateSetupDraft, type SetupDraft, type SetupIssue } from '../shared/setup'
import type { CredentialVault } from './credentials/vault'
import { ConfigError, expandPath, validateProfiles, type Profile, type ProfilesFile } from './profiles'

export interface ApplySetupInput {
  draft: SetupDraft
  /**
   * 一起写入的**其它主机**（向导里从 `~/.ssh/config` 勾选进来的）。
   *
   * 为什么要支持多个：`profiles` 本来就是数组，标题栏的跳板机切换器列的就是它。
   * 只写一台的话，用户明明 `ssh config` 里配了两台登录节点，装完却只能连一台——
   * 那是功能退化，不是简化。
   *
   * 这些是"附带的"：校验不过就**跳过并警告**，不影响主配置写盘。
   */
  extras?: SetupDraft[]
  /** 目标配置目录（调用方已确认可写、已建好） */
  dir: string
}

export interface ApplySetupResult {
  ok: boolean
  issues?: SetupIssue[]
  /** 写成功的配置文件绝对路径——界面上要原样显示，用户得知道文件在哪 */
  configPath?: string
  /** 非致命问题：配置写好了，但密码没进钥匙串 / 某台附带主机没加进来 */
  warnings?: string[]
}

/** 写进文件顶部的一段说明。JSON 允许额外键，`validateProfiles` 会忽略它 */
const FILE_COMMENT =
  '由首次运行向导生成。密码不在这里——它在系统钥匙串里（设置 → 登录凭据）。' +
  '手工编辑也可以，改完重启应用即可生效。'

export function applySetup(input: ApplySetupInput, deps: { credentials: CredentialVault }): ApplySetupResult {
  const { dir } = input
  const warnings: string[] = []

  const primaryIssues = validateSetupDraft(input.draft)
  if (primaryIssues.length > 0) return { ok: false, issues: primaryIssues }

  interface Accepted {
    draft: SetupDraft
    id: string
    keyAbsolute?: string
  }
  const accepted: Accepted[] = []
  const seen = new Set<string>()

  /** 返回 null 表示已接受；否则返回阻止它的原因 */
  const consider = (draft: SetupDraft, primary: boolean): SetupIssue | null => {
    const name = draft.label.trim() || draft.host.trim()
    const issues = validateSetupDraft(draft)
    if (issues.length > 0) {
      if (primary) return issues[0]!
      warnings.push(`${name} 没加进来：${issues[0]!.message}`)
      return null
    }

    const id = setupProfileId(draft.label)
    if (seen.has(id)) {
      const issue: SetupIssue = { field: 'label', message: `和已添加的主机重名（id=${id}），改一下名称再试` }
      if (primary) return issue
      warnings.push(`${name} 没加进来：${issue.message}`)
      return null
    }

    /*
     * 私钥存在性检查。
     *
     * 只查"文件在不在"，**不尝试解析私钥**——解析要读文件、要判格式，
     * 而且加密私钥没口令时必然失败，那样会把"有口令的正确配置"误判成错误。
     * 真正的可用性判断交给连接，那里报错更准。
     */
    let keyAbsolute: string | undefined
    if (draft.method === 'key') {
      keyAbsolute = expandPath(draft.privateKeyPath.trim(), dir)
      if (!existsSync(keyAbsolute)) {
        const message = `找不到这个文件：${keyAbsolute}`
        const issue: SetupIssue = { field: 'privateKeyPath', message }
        if (primary) return issue
        warnings.push(`${name} 没加进来：${message}`)
        return null
      }
    }

    seen.add(id)
    accepted.push({ draft, id, keyAbsolute })
    return null
  }

  const primaryError = consider(input.draft, true)
  if (primaryError) return { ok: false, issues: [primaryError] }
  for (const extra of input.extras ?? []) consider(extra, false)

  const profiles: Profile[] = accepted.map(({ draft, id }) => ({
    id,
    label: draft.label.trim() || id,
    host: draft.host.trim(),
    port: Number(draft.port.trim()),
    username: draft.username.trim(),
    auth: draft.method === 'key' ? { method: 'key', privateKeyPath: draft.privateKeyPath.trim() } : { method: 'password' }
  }))

  const file: ProfilesFile & { $comment: string } = {
    $comment: FILE_COMMENT,
    version: 2,
    defaultProfile: profiles[0]!.id,
    profiles
  }
  const configPath = join(dir, 'profiles.json')

  /*
   * 用**同一套**校验器把生成的文件再走一遍。
   *
   * 不是"多此一举"：这里是唯一能保证"向导写出来的文件"和
   * "启动时读进来的文件"用同一条尺子的地方。少了这一步，
   * 两边的规则漂移就只能靠用户报"配好了却连不上"才发现。
   */
  try {
    validateProfiles(file, configPath)
  } catch (err) {
    if (err instanceof ConfigError) {
      return { ok: false, issues: err.issues.map((message) => ({ field: 'general' as const, message })) }
    }
    throw err
  }

  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(configPath, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
  } catch (err) {
    return {
      ok: false,
      issues: [{ field: 'general', message: `配置写不进去：${err instanceof Error ? err.message : String(err)}` }]
    }
  }

  try {
    for (const { draft, id, keyAbsolute } of accepted) {
      if (draft.method === 'password' && draft.password) {
        deps.credentials.set('ssh-password', id, draft.password)
      }
      if (draft.method === 'key' && draft.passphrase && keyAbsolute) {
        deps.credentials.set('key-passphrase', keyAbsolute, draft.passphrase)
      }
    }
  } catch (err) {
    warnings.push(
      `配置已写好，但密码没能存进系统钥匙串：${err instanceof Error ? err.message : String(err)}。` +
        '可以稍后在「设置 → 登录凭据」里补。'
    )
  }

  return { ok: true, configPath, warnings: warnings.length > 0 ? warnings : undefined }
}
