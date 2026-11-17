import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigError, expandPath, pickProfile, validateProfiles } from '../src/main/profiles'

const CONFIG_PATH = 'C:/work/config/profiles.json'

function minimal(overrides: Record<string, unknown> = {}): unknown {
  return {
    version: 1,
    defaultProfile: 'cluster',
    profiles: [
      {
        id: 'cluster',
        host: 'login.example.edu.cn',
        username: 'user01',
        auth: { method: 'key', privateKeyPath: '~/.ssh/id_ed25519' },
        ...overrides
      }
    ]
  }
}

/** 校验必然失败，把逐条问题取出来看——顶层 message 只讲"有几处问题" */
function issuesOf(config: unknown): string {
  try {
    validateProfiles(config, CONFIG_PATH)
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError)
    return (err as ConfigError).issues.join('\n')
  }
  throw new Error('应当抛出 ConfigError，但没有')
}

describe('validateProfiles', () => {
  it('补齐默认值', () => {
    const loaded = validateProfiles(minimal(), CONFIG_PATH)
    const profile = loaded.profiles[0]!

    expect(profile.port).toBe(22)
    expect(profile.maxConcurrent).toBe(5)
    expect(profile.connectTimeoutMs).toBe(15000)
    expect(profile.keepaliveIntervalMs).toBe(10000)
    expect(profile.trustNewHostKey).toBe(true)
    expect(profile.label).toBe('cluster')
    expect(loaded.defaultProfile).toBe('cluster')
    expect(loaded.warnings).toEqual([])
  })

  it('把 ~ 展开成用户目录，把相对路径按 config 目录解析', () => {
    const withTilde = validateProfiles(minimal(), CONFIG_PATH).profiles[0]!
    expect(withTilde.auth.privateKeyPath).toBe(resolve(homedir(), '.ssh/id_ed25519'))
    expect(withTilde.auth.privateKeyPath!.startsWith('~')).toBe(false)

    const relative = validateProfiles(
      minimal({ auth: { method: 'key', privateKeyPath: 'keys/id_rsa' } }),
      CONFIG_PATH
    ).profiles[0]!
    expect(relative.auth.privateKeyPath).toBe(resolve('C:/work/config', 'keys/id_rsa'))
  })

  it('缺 host 时拒绝，并把问题说清楚', () => {
    const config = minimal() as { profiles: Array<Record<string, unknown>> }
    delete config.profiles[0]!.host

    expect(() => validateProfiles(config, CONFIG_PATH)).toThrowError(ConfigError)
    expect(issuesOf(config)).toContain('host')
  })

  it('id 重复时拒绝', () => {
    const config = {
      profiles: [
        { id: 'a', host: 'h1', username: 'u', auth: { method: 'key', privateKeyPath: 'k' } },
        { id: 'a', host: 'h2', username: 'u', auth: { method: 'key', privateKeyPath: 'k' } }
      ]
    }
    expect(issuesOf(config)).toMatch(/重复/)
  })

  it('拒绝 PuTTY 的 .ppk，并给出转换办法', () => {
    const config = minimal({ auth: { method: 'key', privateKeyPath: 'C:/keys/id.ppk' } })
    expect(issuesOf(config)).toContain('puttygen')
  })

  it('password 方式允许不写密码（改由凭据库补），但写了必须是字符串', () => {
    /*
     * 这条规则在 2026-11 **放开**了，原因值得写下来：
     *
     * 原来是必填，因为那时密码只能写在配置文件里。现在密码由系统钥匙串
     * 加密保存（设置 → 登录凭据），再强制必填就等于逼用户把明文写进
     * profiles.json —— 正好是要消掉的东西。
     *
     * 「真没配密码」的提示移到了 session.ts：那里能说"去设置里存一下"，
     * 而在加载配置时拦下来会让整个应用起不来。
     */
    expect(() => validateProfiles(minimal({ auth: { method: 'password' } }), CONFIG_PATH)).not.toThrow()

    // 但类型写错仍然要拦——那不是"没配"，是配坏了
    const wrongType = minimal({ auth: { method: 'password', password: 123 } })
    expect(issuesOf(wrongType)).toContain('auth.password')
  })

  it('host 带协议前缀时拒绝（容易贴错）', () => {
    const config = minimal({ host: 'ssh://login.example.edu.cn' })
    expect(issuesOf(config)).toContain('不要带协议')
  })

  it('maxConcurrent 超过 10 拒绝，超过 6 只警告', () => {
    expect(issuesOf(minimal({ maxConcurrent: 12 }))).toContain('maxConcurrent')

    const loaded = validateProfiles(minimal({ maxConcurrent: 8 }), CONFIG_PATH)
    expect(loaded.profiles[0]!.maxConcurrent).toBe(8)
    expect(loaded.warnings.join('\n')).toContain('maxConcurrent')
  })

  it('defaultProfile 指向不存在的 id 时拒绝', () => {
    const config = minimal() as { defaultProfile: string }
    config.defaultProfile = 'nope'
    expect(() => validateProfiles(config, CONFIG_PATH)).toThrowError(/defaultProfile/)
  })

  it('profiles 为空时拒绝', () => {
    expect(() => validateProfiles({ profiles: [] }, CONFIG_PATH)).toThrowError(/profiles/)
  })
})

describe('pickProfile', () => {
  it('默认取 defaultProfile，显式传 id 时覆盖', () => {
    const loaded = validateProfiles(
      {
        defaultProfile: 'b',
        profiles: [
          { id: 'a', host: 'h1', username: 'u', auth: { method: 'key', privateKeyPath: 'k' } },
          { id: 'b', host: 'h2', username: 'u', auth: { method: 'key', privateKeyPath: 'k' } }
        ]
      },
      CONFIG_PATH
    )

    expect(pickProfile(loaded).id).toBe('b')
    expect(pickProfile(loaded, 'a').id).toBe('a')
    expect(() => pickProfile(loaded, 'c')).toThrowError(ConfigError)
  })
})

describe('expandPath', () => {
  it('不碰已经绝对的路径', () => {
    const absolute = 'C:/Users/user01/.ssh/id_rsa'
    expect(expandPath(absolute, 'C:/work/config')).toBe(absolute)
  })
})
