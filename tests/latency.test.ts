/**
 * 测速的判读规则。
 *
 * 这里守的核心只有一条：**"网慢"和"节点忙"必须说成两件事**。
 * 只报一个总耗时，用户会去查宽带，而真正该做的是换一台登录节点。
 */
import { describe, expect, it } from 'vitest'
import {
  LATENCY_THRESHOLDS,
  formatMs,
  judgeLatency,
  type LatencyProbe
} from '../src/shared/latency'

function probe(patch: Partial<LatencyProbe> = {}): LatencyProbe {
  return {
    tcpMs: 12,
    sshdMs: 8,
    authMs: 120,
    execMs: 40,
    totalMs: 140,
    failure: null,
    ...patch
  }
}

describe('latency · 全通时的判读', () => {
  it('都正常 → ok，并且把四段数字写进说明', () => {
    const result = judgeLatency(probe())
    expect(result.verdict).toBe('ok')
    expect(result.detail).toContain('网络 12ms')
    expect(result.detail).toContain('认证 120ms')
  })

  it('网络慢 → network-slow，并明确指出和服务端无关', () => {
    const result = judgeLatency(probe({ tcpMs: 300, totalMs: 500 }))
    expect(result.verdict).toBe('network-slow')
    expect(result.detail).toContain('和服务端无关')
  })

  it('认证慢 → sshd-busy，文案要带上"网络只花了多少"', () => {
    const result = judgeLatency(probe({ authMs: 2400, totalMs: 2600 }))
    expect(result.verdict).toBe('sshd-busy')
    expect(result.headline).toContain('跳板机忙')
    expect(result.detail).toContain('认证 2.4s')
    expect(result.detail).toContain('网络只有 12ms')
  })

  /*
   * 两台同 IP 的跳板机就是这个形态：tcp 必然接近，差异全在 auth。
   * 所以 auth 的优先级必须高于 tcp——否则永远只报"网络慢"。
   */
  it('网络和认证都慢时，优先报节点忙（更可操作）', () => {
    const result = judgeLatency(probe({ tcpMs: 200, authMs: 2000, totalMs: 2300 }))
    expect(result.verdict).toBe('sshd-busy')
  })

  it('sshd 应答慢（还没到认证）→ 也是 sshd-busy', () => {
    const result = judgeLatency(probe({ sshdMs: 800, authMs: 100, totalMs: 920 }))
    expect(result.verdict).toBe('sshd-busy')
    expect(result.detail).toContain('SSH 版本串')
  })

  it('命令往返慢 → exec-slow（能用但会顿）', () => {
    const result = judgeLatency(probe({ execMs: 900 }))
    expect(result.verdict).toBe('exec-slow')
  })

  it('阈值边界：正好等于阈值不算慢', () => {
    expect(judgeLatency(probe({ tcpMs: LATENCY_THRESHOLDS.tcpWarnMs })).verdict).toBe('ok')
    expect(judgeLatency(probe({ authMs: LATENCY_THRESHOLDS.authWarnMs })).verdict).toBe('ok')
    expect(judgeLatency(probe({ authMs: LATENCY_THRESHOLDS.authWarnMs + 1 })).verdict).toBe('sshd-busy')
  })
})

describe('latency · 失败要分类', () => {
  it('TCP 超时 → timeout，并说"和 sshd 忙不忙无关"', () => {
    const result = judgeLatency(
      probe({ tcpMs: null, sshdMs: null, authMs: null, execMs: null, totalMs: null, timedOutAt: 'tcp' })
    )
    expect(result.verdict).toBe('timeout')
    expect(result.headline).toContain('连接超时')
    expect(result.detail).toContain('和 sshd 忙不忙无关')
  })

  /*
   * 这条最要紧：认证段超时时，tcp 的数字**仍然有效**，
   * 必须说出来"网络是好的"，否则用户会以为是网络问题。
   */
  it('认证超时 → 仍报出网络耗时，结论指向节点', () => {
    const result = judgeLatency(
      probe({ tcpMs: 12, sshdMs: 8, authMs: null, execMs: null, totalMs: null, timedOutAt: 'auth' })
    )
    expect(result.verdict).toBe('timeout')
    expect(result.detail).toContain('网络 12ms')
    expect(result.detail).toContain('卡在登录')
    expect(result.detail).toContain('登录节点过载')
  })

  it('认证失败 → 明确"网络是通的"，并带上平台原话', () => {
    const result = judgeLatency(
      probe({ authMs: null, execMs: null, totalMs: null, failure: 'auth-failed', error: 'Permission denied (publickey)' })
    )
    expect(result.verdict).toBe('auth-failed')
    expect(result.headline).toContain('认证失败')
    expect(result.detail).toContain('Permission denied')
    expect(result.detail).toContain('网络 12ms 正常到达')
  })

  it('没见过的指纹 → 让用户先去正常连一次（测速不替人做信任决定）', () => {
    const result = judgeLatency(probe({ failure: 'unknown-host', error: 'ssh-ed25519 SHA256:abc' }))
    expect(result.verdict).toBe('unknown-host')
    expect(result.detail).toContain('正常连一次')
  })

  it('指纹变了 → 单独一条，不说成测速问题', () => {
    const result = judgeLatency(probe({ failure: 'hostkey-mismatch', error: 'ssh-ed25519 SHA256:abc' }))
    expect(result.verdict).toBe('hostkey-mismatch')
    expect(result.detail).toContain('主机密钥')
  })

  it('登录成功但执行不了命令 → exec-failed，提示 .bashrc', () => {
    const result = judgeLatency(probe({ execMs: null, failure: 'exec-failed', error: 'exit 1' }))
    expect(result.verdict).toBe('exec-failed')
    expect(result.detail).toContain('.bashrc')
  })
})

describe('latency · 格式化', () => {
  it('小于 1 秒用 ms，大于等于 1 秒用 s', () => {
    expect(formatMs(12)).toBe('12ms')
    expect(formatMs(999)).toBe('999ms')
    expect(formatMs(1000)).toBe('1.0s')
    expect(formatMs(1240)).toBe('1.2s')
  })

  it('null 显示成破折号，不显示 "0ms"（没测出来 ≠ 很快）', () => {
    expect(formatMs(null)).toBe('—')
    expect(formatMs(undefined)).toBe('—')
  })
})
