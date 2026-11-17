/**
 * 「当前用哪台跳板机」的唯一持有者。
 *
 * ## 为什么要有这个模块
 * `config/profiles.json` 里可以有多条 profile（hpc 跳板机 01、hpc-02 跳板机 02），
 * 后端早就支持按 id 取连接：`pickProfile(loaded, id)`、连接池按 `profile.id` 分槽、
 * 能力缓存 key 带 profileId。**但渲染层从来没传过 id**，全部走 `defaultProfile`，
 * 于是第二条 profile 是死配置。
 *
 * 最直接的修法是"在 14 个调用点各传一个 profileId"。那是错的：
 * 等于把"现在在哪台机器"这份状态复制 14 份，漏一处就静默连回默认机，
 * 而且没法单测（要构造 14 个组件的渲染）。
 *
 * 正确做法是把状态收到主进程的**一个**地方，渲染层只负责"切"，
 * 所有读写网络的地方问这里要 id。这个文件就是那个"一个地方"。
 *
 * ## 持久化
 * 存 `KVStore` 的 `connection.activeProfileId`。存在磁盘上而不是内存里，
 * 是因为用户切到 02 通常是因为 01 卡了，重启后不应该又回到 01。
 */
import { loadProfiles, pickProfile, type LoadedProfiles, type ResolvedProfile } from './profiles'
import { applyCredentials } from './credentials/resolve'
import type { CredentialVault } from './credentials/vault'
import type { KVStore } from './store/kv'

/** 存当前 profile id 的键。改名会让所有人的选择恢复到默认机 */
export const ACTIVE_PROFILE_KEY = 'connection.activeProfileId'

/** 给渲染层的 profile 摘要。**刻意不含** auth：私钥路径不该出主进程 */
export interface ProfileSummary {
  id: string
  label: string
  host: string
  port: number
  username: string
  /** 配置文件里 defaultProfile 指的那条——界面标"默认"用 */
  isDefault: boolean
}

export interface ProfileStateOptions {
  /** profiles.json 的绝对路径（每次都重新读，改文件不用重启） */
  configPath: () => string
  cache: KVStore
  /**
   * 凭据保险库。**可选**：不传时行为和以前完全一样（只用配置文件里的明文），
   * 单测里不必为了测"切一下"去构造一个保险库。
   *
   * 传了之后，`current()` 出来的 profile 会自动带上已保存的密码/口令。
   * 这是**唯一**的注入点——所有要连网络的地方都从这里拿 profile，
   * 所以终端/隧道/传输/转账全都自动用上，不需要各自去问保险库。
   */
  credentials?: CredentialVault
  /**
   * 读配置的方式。默认就是 `loadProfiles(path)`。
   *
   * 留这个口子只有一个理由：单测里不想为了测"切一下"去写临时 JSON 文件
   * （要处理编码、清理、并行测试抢同一个路径）。注入一个返回固定
   * `LoadedProfiles` 的函数，测试就只测状态流转本身。
   */
  load?: (path: string) => LoadedProfiles
}

export class ProfileState {
  private readonly options: ProfileStateOptions

  constructor(options: ProfileStateOptions) {
    this.options = options
  }

  private load(): LoadedProfiles {
    return (this.options.load ?? loadProfiles)(this.options.configPath())
  }

  /**
   * 当前应该用哪一条。
   *
   * 每次都重新读配置文件：用户在编辑器里加了条 profile 不该要求重启。
   * 代价是一次同步读小 JSON，只在真正要连的时候发生，可以接受。
   *
   * `overrideId` 是给**诊断页**留的口子：想探一下"另一台跳板机通不通"时，
   * 不该先把全局切过去再切回来（那会顺带断掉用户的终端和隧道）。
   * 渲染层的日常调用**一律不传**——传了就等于把状态又复制到调用点去了。
   *
   * ⚠️ 存着的 id 在配置里被删掉了怎么办：**静默回落到 defaultProfile，不报错**。
   * 因为这是启动路径（`transfer.getSession` 就会走到这里），抛异常等于整个应用连不上。
   * 界面上会显示当前实际生效的是哪条，用户能看见。
   */
  current(loaded?: LoadedProfiles, overrideId?: string | null): ResolvedProfile {
    const config = loaded ?? this.load()
    if (overrideId && overrideId.length > 0) {
      // 显式点名就照办；id 不存在时让 pickProfile 抛 ConfigError（比静默回落安全）
      return this.withCredentials(pickProfile(config, overrideId))
    }
    const saved = this.options.cache.get<string>(ACTIVE_PROFILE_KEY)
    const wanted = saved && config.profiles.some((p) => p.id === saved) ? saved : undefined
    return this.withCredentials(pickProfile(config, wanted))
  }

  /**
   * 补上已保存的密码/口令。
   *
   * 放在 `current()` 里而不是各调用点，是这个模块存在的意义的延续：
   * "现在用哪台机器"只有一份状态，那"这台机器的密码"也该只有一处注入。
   * 在 14 个调用点各取一次凭据，漏掉一处就是"某个功能莫名其妙还在要密码"。
   *
   * 没注入保险库时是空操作——老行为和单测都不受影响。
   */
  private withCredentials(profile: ResolvedProfile): ResolvedProfile {
    const vault = this.options.credentials
    return vault ? applyCredentials(profile, vault) : profile
  }

  /** 当前 id（不回落到默认值之前的值，用于"用户选的是哪条"） */
  activeId(): string {
    return this.current().id
  }

  /**
   * 列出所有可切换的 profile + 当前是哪条。
   *
   * 顺序跟着配置文件走，不排序——用户自己排的顺序就是他心里的顺序。
   */
  list(): { profiles: ProfileSummary[]; activeId: string } {
    const loaded = this.load()
    const active = this.current(loaded)

    return {
      activeId: active.id,
      profiles: loaded.profiles.map((profile) => ({
        id: profile.id,
        label: profile.label,
        host: profile.host,
        port: profile.port,
        username: profile.username,
        isDefault: profile.id === loaded.defaultProfile
      }))
    }
  }

  /**
   * 切到另一条 profile。
   *
   * **只写状态，不负责清理**。关连接、断隧道、收终端是调用方（`ipc.ts` 的
   * `connection:set-active`）的事，因为那些动作要等"确认可以切"之后才能做，
   * 而这个函数会被单测直接调用，不该顺带把整个应用的服务停掉。
   *
   * 返回切换前后的 profile——调用方要拿旧 id 去 invalidate 连接池。
   */
  set(id: string): { previous: ResolvedProfile; next: ResolvedProfile } {
    const loaded = this.load()
    const previous = this.current(loaded)
    // pickProfile 在 id 不存在时抛 ConfigError，且**不会写坏已有选择**——
    // 这正是我们要的：切失败了，还留在原来那台
    const next = pickProfile(loaded, id)

    this.options.cache.set(ACTIVE_PROFILE_KEY, next.id)
    return { previous, next }
  }
}

/**
 * 切换前的"能不能切"判断。**纯函数**，单独拿出来是为了能测。
 *
 * 只有一条硬规则：传输队列不空就不许切。理由不是"怕出错"，是
 * **那 187 MB 是挂在旧机器的连接上的**，换机器等于把它们全部作废。
 * 用户没有要求"传一半就丢掉"，静默丢掉是数据损失。
 *
 * 返回值是 `string | null`（null = 可以切），而不是 boolean：
 * 拒绝时必须带一句能直接显示给用户的话。只返回 false 而不给理由，
 * 界面上就只剩一个"点了没反应"的按钮。
 */
export function switchBlocker(input: {
  /** 队列里有没有在跑或排队的任务 */
  transferActive: boolean
  /** 目标 id；空表示没传 */
  targetId: string
  /** 目标是不是当前那条 */
  sameAsCurrent: boolean
}): string | null {
  if (input.targetId.length === 0) return '没有指定要切到哪台跳板机'
  if (input.sameAsCurrent) return null
  if (input.transferActive) {
    return '还有传输任务在进行，先等它们传完或取消再切换（切换会换掉整条连接，正在传的文件会全部中断）'
  }
  return null
}
