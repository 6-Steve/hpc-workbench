/**
 * 隧道端口规则。
 *
 * 这两个数字的坑全在"看起来能存、用起来不通"上：
 * 21056 与集群 `http_proxy` 不一致 → 代理连不上但报错只说"连接被拒绝"；
 * 落在 32768–60999 → 被别人的出站连接随机抢走，表现成"时好时坏"。
 * 所以这里断言的重点不是"能不能过"，而是**该警告的必须警告**。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EPHEMERAL_RANGE,
  formatReverseFlow,
  readTunnelDefaults,
  TUNNEL_DEFAULTS,
  TUNNEL_PREF_KEYS,
  validateTunnelPorts,
  writeTunnelDefaults
} from '../src/shared/tunnel-defaults'
import { FileKVStore } from '../src/main/store/file-kv'

const ok = { remotePort: String(TUNNEL_DEFAULTS.remotePort), localPort: String(TUNNEL_DEFAULTS.localPort) }

describe('隧道端口 · 默认值', () => {
  it('21056 / 7897 既不报错也不警告', () => {
    const result = validateTunnelPorts(ok)
    expect(result.errors).toEqual({})
    expect(result.warnings).toEqual([])
  })

  it('默认值低于临时端口段（这正是当初选 21056 的原因）', () => {
    expect(TUNNEL_DEFAULTS.remotePort).toBeLessThan(EPHEMERAL_RANGE.min)
  })
})

describe('隧道端口 · 非法值要拦住', () => {
  it('空值、非数字、越界都不行', () => {
    for (const bad of ['', 'abc', '0', '65536', '22.5']) {
      expect(validateTunnelPorts({ ...ok, remotePort: bad }).errors.remotePort, bad).toBeTruthy()
      expect(validateTunnelPorts({ ...ok, localPort: bad }).errors.localPort, bad).toBeTruthy()
    }
  })

  it('一个是合法一个是空，只报空的那个', () => {
    const result = validateTunnelPorts({ remotePort: '21056', localPort: '' })
    expect(result.errors.remotePort).toBeUndefined()
    expect(result.errors.localPort).toBeTruthy()
  })
})

describe('隧道端口 · 该警告的必须警告', () => {
  it('落在系统临时端口段 → 警告（但不阻止，用户可能确实有分配）', () => {
    const result = validateTunnelPorts({ ...ok, remotePort: '55556' })
    expect(result.errors).toEqual({})
    expect(result.warnings.join()).toContain('临时端口段')
  })

  it('正好 32768 就要警告（边界包含）', () => {
    expect(validateTunnelPorts({ ...ok, remotePort: '32768' }).warnings.length).toBe(1)
    expect(validateTunnelPorts({ ...ok, remotePort: '32767' }).warnings.length).toBe(0)
  })

  it('本机端口低于 1024 → 警告（特权端口绑不上）', () => {
    expect(validateTunnelPorts({ ...ok, localPort: '80' }).warnings.join()).toContain('特权端口')
  })

  it('两边填成同一个 → 提醒（不是错误，它们在不同机器上）', () => {
    const result = validateTunnelPorts({ remotePort: '9000', localPort: '9000' })
    expect(result.errors).toEqual({})
    expect(result.warnings.join()).toContain('看混')
  })
})

/* ────────────────────────────────────────────────────────────────────────
 * 存下来的端口必须读得回来。
 *
 * 这一组守的是一个真实 bug：**向导里改了端口，隧道页仍然显示 21056 / 7897**。
 * 根因有两个，一个在写、一个在读：
 *   1. 写：端口是在 `applyInitialSetup` 之后单独存的，而向导第一步可能已经
 *      换了配置目录——于是写进了旧目录，重启后读的是新目录，等于没存；
 *   2. 读：界面里那句"集群程序 → 127.0.0.1:21056"直接渲染了常量。
 * 所以下面既测往返，也测文案吃不吃当前值。
 * ──────────────────────────────────────────────────────────────────────── */

function withStore<T>(run: (file: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'hpc-tunnel-'))
  try {
    return run(join(dir, '.cache', 'capabilities.json'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('隧道端口 · 存下来的值得读得回来', () => {
  it('空 store 回默认值', () => {
    withStore((file) => {
      expect(readTunnelDefaults(new FileKVStore(file))).toEqual(TUNNEL_DEFAULTS)
    })
  })

  it('写进去再读出来，是用户填的值而不是默认值', () => {
    withStore((file) => {
      const store = new FileKVStore(file)
      writeTunnelDefaults(store, { remotePort: 21057, localPort: 7890 })
      expect(readTunnelDefaults(store)).toEqual({ remotePort: 21057, localPort: 7890 })
    })
  })

  it('换一个实例（≈重启应用）也读得到，否则就是"改完重启又回去了"', () => {
    withStore((file) => {
      writeTunnelDefaults(new FileKVStore(file), { remotePort: 21057, localPort: 7890 })
      expect(readTunnelDefaults(new FileKVStore(file))).toEqual({ remotePort: 21057, localPort: 7890 })
    })
  })

  it('和能力探测缓存共用一个文件也不会互相踩', () => {
    withStore((file) => {
      const store = new FileKVStore(file)
      writeTunnelDefaults(store, { remotePort: 21057, localPort: 7890 })
      store.set('capabilities.alice', { json: true })
      expect(readTunnelDefaults(store)).toEqual({ remotePort: 21057, localPort: 7890 })
      expect(store.get('capabilities.alice')).toEqual({ json: true })
      expect(TUNNEL_PREF_KEYS.remotePort.startsWith('tunnel.')).toBe(true)
    })
  })
})

describe('隧道端口 · 脏值当没存过', () => {
  function fakeStore(data: Record<string, unknown>): {
    get<T>(key: string): T | undefined
    set<T>(key: string, value: T): void
  } {
    return {
      get<T>(key: string): T | undefined {
        return data[key] as T | undefined
      },
      set<T>(key: string, value: T): void {
        data[key] = value
      }
    }
  }

  it('非数字、越界、小数都不采用，退回默认值', () => {
    for (const bad of ['abc', '0', '65536', '22.5', -1, null] as unknown[]) {
      const store = fakeStore({
        [TUNNEL_PREF_KEYS.remotePort]: bad,
        [TUNNEL_PREF_KEYS.localPort]: bad
      })
      expect(readTunnelDefaults(store), String(bad)).toEqual(TUNNEL_DEFAULTS)
    }
  })

  it('字符串形式的合法数字要认（老版本存成字符串也读得回来）', () => {
    const store = fakeStore({
      [TUNNEL_PREF_KEYS.remotePort]: '21057',
      [TUNNEL_PREF_KEYS.localPort]: '7890'
    })
    expect(readTunnelDefaults(store)).toEqual({ remotePort: 21057, localPort: 7890 })
  })
})

describe('隧道端口 · 示意句要吃当前值', () => {
  it('用传进来的端口，不是写死的 21056 / 7897', () => {
    const text = formatReverseFlow('21057', '7890')
    expect(text).toContain('21057')
    expect(text).toContain('7890')
    expect(text).not.toContain('21056')
    expect(text).not.toContain('7897')
  })

  it('空值才退回默认，避免出现 "127.0.0.1: →" 这种半截话', () => {
    expect(formatReverseFlow('', '')).toContain(String(TUNNEL_DEFAULTS.remotePort))
    expect(formatReverseFlow('  ', '  ')).toContain(String(TUNNEL_DEFAULTS.localPort))
  })
})
