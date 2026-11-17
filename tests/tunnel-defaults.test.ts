/**
 * 隧道端口规则。
 *
 * 这两个数字的坑全在"看起来能存、用起来不通"上：
 * 21056 与集群 `http_proxy` 不一致 → 代理连不上但报错只说"连接被拒绝"；
 * 落在 32768–60999 → 被别人的出站连接随机抢走，表现成"时好时坏"。
 * 所以这里断言的重点不是"能不能过"，而是**该警告的必须警告**。
 */
import { describe, expect, it } from 'vitest'
import { EPHEMERAL_RANGE, TUNNEL_DEFAULTS, validateTunnelPorts } from '../src/shared/tunnel-defaults'

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
