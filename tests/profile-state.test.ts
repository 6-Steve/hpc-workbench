/**
 * 跳板机切换（`ProfileState`）。
 *
 * 这些测试守的是**状态流转**，不是界面：切完谁在读、旧值会不会被写坏、
 * 配置被改坏时会不会把应用连不上的问题。
 *
 * 刻意不碰真实 SSH：把"切"这件事做成纯状态操作（关连接在 ipc 层），
 * 正是为了能这样测。
 */
import { describe, expect, it } from 'vitest'
import { ProfileState, switchBlocker } from '../src/main/profile-state'
import { validateProfiles, type LoadedProfiles } from '../src/main/profiles'
import type { KVStore } from '../src/main/store/kv'

/** 内存 KV，和 `FileKVStore` 同语义，不给测试留磁盘痕迹 */
function memoryKV(initial: Record<string, unknown> = {}): KVStore & { dump(): Record<string, unknown> } {
  const map = new Map<string, unknown>(Object.entries(initial))
  return {
    get<T>(key: string): T | undefined {
      return map.get(key) as T | undefined
    },
    set<T>(key: string, value: T): void {
      map.set(key, value)
    },
    delete(key: string): void {
      map.delete(key)
    },
    keys(): string[] {
      return [...map.keys()]
    },
    dump(): Record<string, unknown> {
      return Object.fromEntries(map)
    }
  }
}

const CONFIG_PATH = 'C:/work/config/profiles.json'

/** 两条 profile：跳板机 01 / 02，同一台机器不同端口——和真实配置同构 */
function twoProfiles(): LoadedProfiles {
  return validateProfiles(
    {
      version: 1,
      defaultProfile: 'hpc',
      profiles: [
        {
          id: 'hpc',
          label: 'SCIR 跳板机 01',
          host: '192.0.2.46',
          port: 2223,
          username: 'user01',
          auth: { method: 'key', privateKeyPath: '~/.ssh/id_rsa' }
        },
        {
          id: 'hpc-02',
          label: 'SCIR 跳板机 02',
          host: '192.0.2.46',
          port: 2222,
          username: 'user01',
          auth: { method: 'key', privateKeyPath: '~/.ssh/id_rsa' }
        }
      ]
    },
    CONFIG_PATH
  )
}

function makeState(kv: KVStore, loaded: LoadedProfiles = twoProfiles()): ProfileState {
  return new ProfileState({
    configPath: () => CONFIG_PATH,
    cache: kv,
    load: () => loaded
  })
}

describe('ProfileState · 当前跳板机', () => {
  it('没存过时用 defaultProfile', () => {
    const state = makeState(memoryKV())
    expect(state.activeId()).toBe('hpc')
  })

  it('切过去之后 activeId 变了，而且落盘了', () => {
    const kv = memoryKV()
    const state = makeState(kv)

    const { previous, next } = state.set('hpc-02')
    expect(previous.id).toBe('hpc')
    expect(next.id).toBe('hpc-02')
    expect(state.activeId()).toBe('hpc-02')
    // 落盘是必须的：用户切到 02 通常是因为 01 卡了，重启不该又回到 01
    expect(kv.get('connection.activeProfileId')).toBe('hpc-02')
  })

  it('切换返回的是补齐默认值后的 ResolvedProfile（端口等字段可用）', () => {
    const state = makeState(memoryKV())
    const { next } = state.set('hpc-02')
    expect(next.port).toBe(2222)
    expect(next.username).toBe('user01')
    expect(next.maxConcurrent).toBeGreaterThan(0)
  })

  it('切到不存在的 id 会抛错，并且**原选择不变**', () => {
    const kv = memoryKV()
    const state = makeState(kv)
    state.set('hpc-02')

    expect(() => state.set('hpc-09')).toThrow()
    // 这是最关键的一条：切失败了不能把用户留在"没有机器"的状态
    expect(state.activeId()).toBe('hpc-02')
    expect(kv.get('connection.activeProfileId')).toBe('hpc-02')
  })

  it('存着的 id 被从配置里删掉时，静默回落到 defaultProfile 而不是抛错', () => {
    // 启动路径（transfer.getSession）会走到这里，抛错 = 整个应用连不上
    const kv = memoryKV({ 'connection.activeProfileId': 'hpc-02' })
    const loaded = validateProfiles(
      {
        version: 1,
        defaultProfile: 'hpc',
        profiles: [
          {
            id: 'hpc',
            host: '192.0.2.46',
            port: 2223,
            username: 'user01',
            auth: { method: 'key', privateKeyPath: '~/.ssh/id_rsa' }
          }
        ]
      },
      CONFIG_PATH
    )
    const state = makeState(kv, loaded)
    expect(state.activeId()).toBe('hpc')
  })
})

describe('ProfileState · 列表', () => {
  it('列出全部 profile，标出默认那条，且**不带 auth**', () => {
    const state = makeState(memoryKV())
    const result = state.list()

    expect(result.activeId).toBe('hpc')
    expect(result.profiles.map((p) => p.id)).toEqual(['hpc', 'hpc-02'])
    expect(result.profiles[0]!.isDefault).toBe(true)
    expect(result.profiles[1]!.isDefault).toBe(false)

    // 私钥路径不该出主进程——这条断言防的是"顺手把整个 profile 传出去"
    for (const profile of result.profiles) {
      expect(profile).not.toHaveProperty('auth')
      expect(JSON.stringify(profile)).not.toContain('id_rsa')
    }
  })

  it('顺序跟着配置文件走，不排序', () => {
    const state = makeState(memoryKV())
    // 配置文件里 hpc 在前；如果实现里做了按字母排序，hpc-02 会跑到前面
    expect(state.list().profiles[0]!.id).toBe('hpc')
  })
})

describe('ProfileState · 诊断页的显式覆盖', () => {
  it('传 overrideId 时按它取，且不改动全局状态', () => {
    const state = makeState(memoryKV())
    const other = state.current(undefined, 'hpc-02')

    expect(other.id).toBe('hpc-02')
    // 探一下另一台机器不该把全局切过去——否则会顺带断掉用户的终端
    expect(state.activeId()).toBe('hpc')
  })

  it('显式覆盖指向不存在的 id 时抛错（比静默回落安全）', () => {
    const state = makeState(memoryKV())
    expect(() => state.current(undefined, 'hpc-09')).toThrow()
  })
})

/**
 * 切换前的准入判断。
 *
 * 单独测它而不是测整个 IPC handler：handler 要启动 Electron、要造六个服务，
 * 而这个函数就是"能不能切"的全部逻辑。**把它抽成纯函数正是为了这一刻。**
 */
describe('switchBlocker · 什么时候不许切', () => {
  it('有传输在跑时拒绝，并且理由是能直接显示给用户的一句话', () => {
    const reason = switchBlocker({ targetId: 'hpc-02', sameAsCurrent: false, transferActive: true })
    expect(reason).not.toBeNull()
    // 只返回 false 会让界面变成"点了没反应"，所以必须有文案
    expect(reason).toContain('传输')
    expect(reason).toContain('取消')
  })

  it('没传 id 时拒绝', () => {
    const reason = switchBlocker({ targetId: '', sameAsCurrent: false, transferActive: false })
    expect(reason).not.toBeNull()
    expect(reason).toContain('跳板机')
  })

  it('切到自己那台不算切换，不拦（哪怕正在传）', () => {
    // 用户点了当前那台：什么都不该发生，更不该报"传输中不能切"
    const reason = switchBlocker({ targetId: 'hpc', sameAsCurrent: true, transferActive: true })
    expect(reason).toBeNull()
  })

  it('空闲时可以切', () => {
    expect(switchBlocker({ targetId: 'hpc-02', sameAsCurrent: false, transferActive: false })).toBeNull()
  })
})
