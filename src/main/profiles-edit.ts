/**
 * 改一台已有的跳板机（不重建整份配置）。
 *
 * ## 为什么值得单独一层
 *
 * 现在改端口只有两条路：手改 JSON，或者「重新配置」把**所有**主机重写一遍。
 * 后者在多主机时是不可接受的——只想动一台，凭什么重写全部。
 *
 * ## 三条不能破的规矩
 *
 * 1. **`id` 不可改**。它是连接池的键（`entries.get(profile.id)`），
 *    改了之后旧会话就成了孤儿：隧道、终端、传输都挂在上面继续跑，
 *    界面上却再也找不到它。
 * 2. **写入前重新读文件，只 patch 目标项**。设置页和切换器可能同时开着，
 *    整文件覆盖会把对方刚改的另一台吃掉。
 * 3. **密码不进 JSON**。它只走 `vault.set`；这里只负责把 `auth.method` 改对。
 */
import { ConfigError, validateProfiles, type ProfilesFile } from './profiles'

export interface ProfilePatch {
  /** 定位用，**不允许改** */
  id: string
  label: string
  host: string
  port: number
  username: string
  auth: { method: 'key' | 'password'; privateKeyPath?: string }
}

export interface PatchResult {
  /** 新的文件内容（已格式化，带结尾换行） */
  text: string
  /** 内容是否真的变了；false 时调用方可以跳过写盘 */
  changed: boolean
  /** 改之前的连接参数，用来判断"要不要提醒重连" */
  previous: { label: string; host: string; port: number; username: string; method: string }
}

/**
 * 把补丁合进现有配置文本。
 *
 * 抛 `ConfigError` 的情况：JSON 坏、找不到这个 id、改完通不过 `validateProfiles`。
 * 一律**不返回半成品**——调用方拿到异常就该原样显示，不要写盘。
 */
export function patchProfile(fileText: string, patch: ProfilePatch, path: string): PatchResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(fileText)
  } catch (err) {
    throw new ConfigError(path, `配置文件不是合法 JSON：${err instanceof Error ? err.message : String(err)}`, [
      '先修好 JSON 再改。这一版不会替你猜哪里少了逗号。'
    ])
  }

  const file = parsed as ProfilesFile & Record<string, unknown>
  if (!Array.isArray(file.profiles)) {
    throw new ConfigError(path, '配置文件里没有 profiles 数组', [])
  }

  const index = file.profiles.findIndex((item) => item.id === patch.id)
  if (index < 0) {
    throw new ConfigError(path, `找不到 id 为 ${patch.id} 的主机`, [
      '可能在别处刚被删掉了。刷新一下列表再试。'
    ])
  }

  const before = file.profiles[index]!
  const previous = {
    label: before.label ?? before.id,
    host: before.host,
    port: before.port,
    username: before.username,
    method: String(before.auth.method)
  }

  const next: ProfilesFile['profiles'][number] = {
    ...before,
    // id 原样保留：即使 patch 里带了别的值也不采纳
    id: before.id,
    label: patch.label.trim() || before.label,
    host: patch.host.trim(),
    port: Math.floor(patch.port),
    username: patch.username.trim(),
    auth:
      patch.auth.method === 'key'
        ? { method: 'key', privateKeyPath: (patch.auth.privateKeyPath ?? '').trim() }
        : { method: 'password' }
  }

  const profiles = [...file.profiles]
  profiles[index] = next
  const merged = { ...file, profiles }

  // 用**启动时那套校验器**再走一遍：两边规则必须完全一致
  validateProfiles(merged, path)

  const changed =
    previous.label !== next.label ||
    previous.host !== next.host ||
    previous.port !== next.port ||
    previous.username !== next.username ||
    previous.method !== next.auth.method ||
    (next.auth.method === 'key' && (before.auth.privateKeyPath ?? '') !== next.auth.privateKeyPath)

  return {
    text: `${JSON.stringify(merged, null, 2)}\n`,
    changed,
    previous
  }
}
