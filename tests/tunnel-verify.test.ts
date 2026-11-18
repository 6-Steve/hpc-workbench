/**
 * 「隧道能不能用」的结论怎么说。
 *
 * 五种组合各对应一种真实处境，而且它们的**处置方式完全不同**：
 * 一致 → 收工；不一致 → 端口上是别人的服务；只有集群侧通 → Clash 没开；
 * 只有本机通 → 隧道断了；两边都不通 → 先开代理。
 * 说错一种，用户就会朝错误的方向修半天。
 */
import { describe, expect, it } from 'vitest'
import { describeVerify } from '../src/shared/tunnel-verify'

describe('describeVerify', () => {
  it('两边通且出口相同：可用', () => {
    const verdict = describeVerify({ ip: '14.137.237.10', error: null }, { ip: '14.137.237.10', error: null })
    expect(verdict.tone).toBe('ok')
    expect(verdict.text).toContain('14.137.237.10')
    expect(verdict.text).toContain('一致')
  })

  it('通了但出口不同：那个端口上不是你的电脑', () => {
    // 实测踩过：55555 上蹲着另一位同学的代理，请求有响应但根本没到你这里
    const verdict = describeVerify({ ip: '38.190.176.202', error: null }, { ip: '14.137.237.10', error: null })
    expect(verdict.tone).toBe('bad')
    expect(verdict.text).toContain('38.190.176.202')
    expect(verdict.text).toContain('14.137.237.10')
    expect(verdict.text).toContain('没连到你的电脑')
  })

  it('只有集群侧通：本机代理没响应，无法比对', () => {
    const verdict = describeVerify({ ip: '1.2.3.4', error: null }, { ip: null, error: 'ECONNREFUSED' })
    expect(verdict.tone).toBe('warn')
    expect(verdict.text).toContain('没法比对')
  })

  it('提示里的端口跟着配置走，不是写死的 7897', () => {
    // 代理端口每个环境都不同（Clash 7897 / V2Ray 10809 / 自建 7890），
    // 说错端口会让人跑去查一个根本没在用的进程
    const verdict = describeVerify({ ip: '1.2.3.4', error: null }, { ip: null, error: 'ECONNREFUSED' }, null, 7890)
    expect(verdict.text).toContain('7890')
    expect(verdict.text).not.toContain('7897')
  })

  it('不知道端口时只说"在监听"，不编一个数字出来', () => {
    const verdict = describeVerify({ ip: '1.2.3.4', error: null }, { ip: null, error: 'ECONNREFUSED' })
    expect(verdict.text).toContain('在监听')
    expect(verdict.text).not.toMatch(/\d{4,5} 上监听/)
  })

  it('只有本机通：隧道这条链断了', () => {
    const verdict = describeVerify({ ip: null, error: 'curl: (7) Failed to connect' }, { ip: '1.2.3.4', error: null })
    expect(verdict.tone).toBe('bad')
    expect(verdict.text).toContain('隧道没生效')
    // 把 curl 的原话带出来，用户能自己搜
    expect(verdict.text).toContain('curl: (7)')
  })

  it('两边都不通：先解决代理，别急着怀疑隧道', () => {
    const verdict = describeVerify({ ip: null, error: 'timeout' }, { ip: null, error: 'ECONNREFUSED' })
    expect(verdict.tone).toBe('bad')
    expect(verdict.text).toContain('Clash')
  })

  it('错误信息缺失时也不能出现 "undefined"', () => {
    const verdict = describeVerify({ ip: null, error: null }, { ip: null, error: null })
    expect(verdict.text).not.toContain('undefined')
    expect(verdict.text).not.toContain('null')
  })
})

describe('自检 · 出口不一致但计数器动过', () => {
  /*
   * 这一组是真实的误报现场：用户 Clash 用 url-test 节点组，集群侧那次请求
   * 落到节点 A（52.x），本机那次落到节点 B（13.x），于是"出口不一致"。
   * 原来会报"这条隧道没连到你的电脑"，把正常配置说成坏的。
   */
  const cluster = { ip: '52.197.184.161', error: null }
  const local = { ip: '13.158.42.244', error: null }

  it('计数器涨了 → 只警告，不再判死', () => {
    const verdict = describeVerify(cluster, local, true)
    expect(verdict.tone).toBe('warn')
    expect(verdict.text).toContain('流量确实走了这条隧道')
    expect(verdict.text).not.toContain('没连到你的电脑')
  })

  it('计数器没动 → 仍然判死（端口上确实蹲着别人的服务）', () => {
    const verdict = describeVerify(cluster, local, false)
    expect(verdict.tone).toBe('bad')
    expect(verdict.text).toContain('没连到你的电脑')
  })

  it('没给 tunnelId（moved=null）时保持原来的严格判定', () => {
    expect(describeVerify(cluster, local, null).tone).toBe('bad')
    expect(describeVerify(cluster, local).tone).toBe('bad')
  })

  it('出口一致时 moved 不影响结论', () => {
    const same = { ip: '14.137.237.10', error: null }
    expect(describeVerify(same, same, false).tone).toBe('ok')
    expect(describeVerify(same, same, true).tone).toBe('ok')
  })
})
