/**
 * 「密码对不对」的判定。
 *
 * 这三组判定的共同点是：**判错的代价不对称**。
 * - 把"网络不通"判成"密码错" → 用户反复去改一个本来正确的密码，永远改不对
 * - 把"业务报错"判成"密码错" → 同上（而它其实说明认证已经过了）
 *
 * 所以这里的核心规则是：**只认一个明确的失败信号，其余一律算通过**。
 */
import { describe, expect, it } from 'vitest'
import { judgeLdapProbe, judgeSshProbe, testPassphrase } from '../src/main/credentials/test'
import { makeTestKey } from './helpers/test-key'

describe('judgeSshProbe · SSH 认证', () => {
  it('连上了就是密码对', () => {
    expect(judgeSshProbe(null).status).toBe('ok')
  })

  it('kind=auth 才是密码错', () => {
    const outcome = judgeSshProbe({ kind: 'auth', message: 'All configured authentication methods failed' })
    expect(outcome.status).toBe('wrong')
    expect(outcome.message).toContain('密码不对')
  })

  it('连不上**不能**判成密码错', () => {
    /*
     * 这是最容易写错的一条。网络不通、DNS 解析失败、握手失败、指纹不匹配
     * 都发生在认证之前——这时候说"密码错"，用户会去改一个正确的密码。
     */
    for (const kind of ['dns', 'network', 'reset', 'handshake', 'hostkey', 'timeout']) {
      const outcome = judgeSshProbe({ kind, message: 'boom' })
      expect(outcome.status, kind).toBe('unreachable')
      expect(outcome.message, kind).toContain('连不上')
    }
  })

  it('原始错误进 detail，方便用户贴出来', () => {
    const outcome = judgeSshProbe({ kind: 'network', message: 'connect ECONNREFUSED' })
    expect(outcome.detail).toContain('ECONNREFUSED')
    expect(outcome.detail).toContain('network')
  })

  it('不是对象的异常也不会崩', () => {
    expect(judgeSshProbe('string error').status).toBe('unreachable')
    expect(judgeSshProbe(undefined).status).toBe('ok')
  })
})

describe('judgeLdapProbe · 平台密码', () => {
  const base = { finished: true, timedOut: false, code: 1, output: '' }

  it('rc: 49 是密码错（LDAP 的 invalidCredentials）', () => {
    const outcome = judgeLdapProbe({
      ...base,
      output: 'Error: LdapError(LdapResult { rc: 49, matched: "" })'
    })
    expect(outcome.status).toBe('wrong')
    expect(outcome.message).toContain('49')
  })

  it('AuthFailed 也算密码错（平台自己的简写）', () => {
    expect(judgeLdapProbe({ ...base, output: 'Error: AuthFailed' }).status).toBe('wrong')
  })

  it('**业务报错说明认证已经过了**，算密码对', () => {
    /*
     * 探针用的是 0 点转账，平台很可能在认证之后报"点数必须大于 0"。
     * 如果把这个判成密码错，用户会一直改密码改不明白——
     * 而实际上密码是对的，只是我们不接受 0 点。
     */
    const outcome = judgeLdapProbe({
      ...base,
      output: 'error: invalid value for --points: must be positive'
    })
    expect(outcome.status).toBe('ok')
  })

  it('完全成功当然也是密码对', () => {
    expect(judgeLdapProbe({ ...base, code: 0, output: 'Transfer 0 points to you01' }).status).toBe('ok')
  })

  it('超时判 unreachable，不判密码错', () => {
    const outcome = judgeLdapProbe({ finished: false, timedOut: true, code: null, output: 'Your Password: ' })
    expect(outcome.status).toBe('unreachable')
    expect(outcome.message).toContain('25')
  })

  it('没正常结束（连接断了）判 unreachable', () => {
    const outcome = judgeLdapProbe({ finished: false, timedOut: false, code: null, output: 'x' })
    expect(outcome.status).toBe('unreachable')
  })

  it('非 49 的 LdapError 判 unsupported——密码这关过了，但环境有问题', () => {
    const outcome = judgeLdapProbe({
      ...base,
      output: 'Error: LdapError(LdapResult { rc: 53, matched: "" })'
    })
    expect(outcome.status).toBe('unsupported')
    expect(outcome.message).toContain('账号被锁')
  })

  it('原文进 detail，但里面不该有密码', () => {
    const outcome = judgeLdapProbe({ ...base, output: 'Error: LdapError(rc: 49)' })
    expect(outcome.detail).toBe('Error: LdapError(rc: 49)')
  })
})

describe('testPassphrase · 私钥口令', () => {
  it('不带口令的私钥 + 空口令 → 能解开', () => {
    const outcome = testPassphrase(Buffer.from(makeTestKey(), 'utf8'), '')
    expect(outcome.status).toBe('ok')
  })

  it('私钥内容坏了 → 说清是"私钥本身有问题"，别让用户反复改口令', () => {
    const outcome = testPassphrase(Buffer.from('not a key at all', 'utf8'), 'whatever')
    expect(outcome.status).toBe('wrong')
    expect(outcome.message).toContain('私钥本身')
  })

  it('空 Buffer 也不会崩', () => {
    expect(() => testPassphrase(Buffer.alloc(0), 'x')).not.toThrow()
  })
})
