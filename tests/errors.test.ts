import { describe, expect, it } from 'vitest'
import { SshError, formatSshError, normalizeSshError } from '../src/main/ssh/errors'

describe('normalizeSshError', () => {
  it('按 errno 分辨网络类错误', () => {
    expect(normalizeSshError(Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:22'), { code: 'ECONNREFUSED' })).kind).toBe('network')
    expect(normalizeSshError(Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' })).kind).toBe('dns')
    expect(normalizeSshError(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })).kind).toBe('network')
    expect(normalizeSshError(Object.assign(new Error('reset'), { code: 'ECONNRESET' })).kind).toBe('reset')
  })

  it('把认证失败翻译成人话，并保留原始信息', () => {
    const raw = 'All configured authentication methods failed'
    const err = normalizeSshError(new Error(raw), { host: 'h', port: 22, username: 'user01' })

    expect(err.kind).toBe('auth')
    expect(err.message).toContain('认证失败')
    expect(err.message).toContain('user01')
    expect(err.raw).toBe(raw)
    expect(err.hint).toContain('authorized_keys')
  })

  it('私钥格式错误要指向 .ppk 这个最常见的坑', () => {
    const err = normalizeSshError(new Error('Cannot parse privateKey: Unsupported key format'))
    expect(err.kind).toBe('key')
    expect(err.hint).toContain('ppk')
  })

  it('加密私钥缺口令单独成一类', () => {
    const err = normalizeSshError(new Error('Encrypted private OpenSSH key detected, but no passphrase given'))
    expect(err.kind).toBe('key')
    expect(err.hint).toContain('passphrase')
  })

  it('channel open failure 提示并发上限', () => {
    const err = normalizeSshError(new Error('channel open failure: open failed'))
    expect(err.kind).toBe('channel')
    expect(err.retryable).toBe(true)
    expect(err.hint).toContain('MaxSessions')
  })

  it('主机指纹不匹配时不做"忽略即可"的引导', () => {
    const err = normalizeSshError(new Error('Host denied (verification failed)'))
    expect(err.kind).toBe('hostkey')
    expect(err.hint).toContain('known_hosts.json')
  })

  it('已经是 SshError 时原样返回，不二次包装', () => {
    const original = new SshError({ kind: 'timeout', message: 'x', raw: 'y' })
    expect(normalizeSshError(original)).toBe(original)
  })

  it('未知错误也要带上 raw，不能吞掉', () => {
    const err = normalizeSshError(new Error('something odd happened'))
    expect(err.kind).toBe('unknown')
    expect(err.raw).toBe('something odd happened')
  })

  it('非 Error 的输入也能归一（字符串、对象、null）', () => {
    expect(normalizeSshError('boom').raw).toBe('boom')
    expect(normalizeSshError({ message: 'obj', code: 'ECONNRESET' }).kind).toBe('reset')
    expect(normalizeSshError(null).kind).toBe('unknown')
  })
})

describe('formatSshError', () => {
  it('人话在前，原文缩进在后', () => {
    const text = formatSshError(new Error('All configured authentication methods failed'), '  ')
    const lines = text.split('\n')

    expect(lines[0]).toContain('认证失败')
    expect(text).toContain('原始信息')
    expect(text).toContain('All configured authentication methods failed')
  })
})
