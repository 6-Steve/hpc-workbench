/**
 * 凭据 → profile 的填充规则。
 *
 * 这里的每一条都对应一个"用户会觉得莫名其妙"的失败：
 * - 老配置里的明文密码突然不生效了
 * - 私钥本来就没口令，却一直弹"没配置口令"的警告
 * - 存了密码但解不开，界面只说"没密码"，用户不知道该重输还是该查配置
 */
import { describe, expect, it } from 'vitest'
import { applyCredentials, findPlaintextAuth } from '../src/main/credentials/resolve'
import { CredentialVault, type Cipher } from '../src/main/credentials/vault'
import type { ResolvedProfile } from '../src/main/profiles'
import type { KVStore } from '../src/main/store/kv'

function memoryStore(): KVStore {
  const raw = new Map<string, unknown>()
  return {
    get: <T,>(key: string) => raw.get(key) as T | undefined,
    set: <T,>(key: string, value: T) => void raw.set(key, value),
    delete: (key: string) => void raw.delete(key),
    keys: () => [...raw.keys()]
  }
}

function cipher(options: { failDecrypt?: boolean } = {}): Cipher {
  return {
    available: true,
    backend: '测试',
    encrypt: (plain) => `enc:${Buffer.from(plain, 'utf8').toString('base64')}`,
    decrypt: (value) => {
      if (options.failDecrypt) throw new Error('解不开')
      return Buffer.from(value.slice(4), 'base64').toString('utf8')
    }
  }
}

function vault(options: { failDecrypt?: boolean } = {}): CredentialVault {
  return new CredentialVault({ store: memoryStore(), cipher: cipher(options) })
}

function profile(overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
  return {
    id: 'cluster',
    label: '实验室集群',
    host: 'login.example.edu.cn',
    port: 22,
    username: 'user01',
    auth: { method: 'password' },
    maxConcurrent: 5,
    connectTimeoutMs: 15000,
    keepaliveIntervalMs: 10000,
    trustNewHostKey: true,
    quotaCommand: 'mmlsquota',
    ...overrides
  }
}

describe('applyCredentials · 密码型', () => {
  it('配置文件里写了明文就照用（老配置不能失效）', () => {
    const v = vault()
    const p = profile({ auth: { method: 'password', password: 'from-file' } })
    expect(applyCredentials(p, v).auth.password).toBe('from-file')
  })

  it('配置文件没写就从库里补', () => {
    const v = vault()
    v.set('ssh-password', 'cluster', 'from-vault')
    const p = applyCredentials(profile(), v)
    expect(p.auth.password).toBe('from-vault')
    expect(p.credentialIssue).toBeUndefined()
  })

  it('配置文件和库里都有时，配置文件的赢', () => {
    const v = vault()
    v.set('ssh-password', 'cluster', 'from-vault')
    const p = profile({ auth: { method: 'password', password: 'from-file' } })
    expect(applyCredentials(p, v).auth.password).toBe('from-file')
  })

  it('都没有时留空并记一条 missing，但**不抛异常**', () => {
    // current() 也被 list() 调用，在那里抛会让跳板机切换器整个挂掉
    const v = vault()
    let result: ResolvedProfile | null = null
    expect(() => {
      result = applyCredentials(profile(), v)
    }).not.toThrow()

    expect(result!.auth.password).toBeUndefined()
    expect(result!.credentialIssue?.kind).toBe('missing')
    expect(result!.credentialIssue?.message).toContain('还没保存密码')
  })

  it('存过但解不开时，kind 是 undecryptable 且文案不同', () => {
    const v = vault({ failDecrypt: true })
    v.set('ssh-password', 'cluster', 'pw')
    const p = applyCredentials(profile(), v)
    expect(p.credentialIssue?.kind).toBe('undecryptable')
    // 这两种情况用户要做的事不一样：一个是"去填"，一个是"重填一次"
    expect(p.credentialIssue?.message).toContain('解不开')
  })

  it('不改入参对象', () => {
    const v = vault()
    v.set('ssh-password', 'cluster', 'pw')
    const original = profile()
    applyCredentials(original, v)
    expect(original.auth.password).toBeUndefined()
  })
})

describe('applyCredentials · 私钥型', () => {
  it('没有口令是**正常状态**，不记 issue', () => {
    /*
     * 这条很容易写错：`missing` 就记 issue 的话，所有不用口令的用户
     * 每次都会看到一条警告，然后这条警告就变成噪音，真出问题时没人看。
     */
    const v = vault()
    const p = applyCredentials(
      profile({ auth: { method: 'key', privateKeyPath: 'C:/k/id_ed25519' } }),
      v
    )
    expect(p.credentialIssue).toBeUndefined()
    expect(p.auth.passphrase).toBeUndefined()
  })

  it('库里有口令就填上（scope 用绝对路径）', () => {
    const v = vault()
    v.set('key-passphrase', 'C:/k/id_ed25519', 'pp')
    const p = applyCredentials(
      profile({ auth: { method: 'key', privateKeyPath: 'C:/k/id_ed25519' } }),
      v
    )
    expect(p.auth.passphrase).toBe('pp')
  })

  it('口令存过但解不开时要记 issue（这不是"没用口令"，是"坏了"）', () => {
    const v = vault({ failDecrypt: true })
    v.set('key-passphrase', 'C:/k/id_ed25519', 'pp')
    const p = applyCredentials(
      profile({ auth: { method: 'key', privateKeyPath: 'C:/k/id_ed25519' } }),
      v
    )
    expect(p.credentialIssue?.kind).toBe('undecryptable')
  })

  it('配置文件里的口令优先', () => {
    const v = vault()
    v.set('key-passphrase', 'C:/k/id', 'from-vault')
    const p = applyCredentials(
      profile({ auth: { method: 'key', privateKeyPath: 'C:/k/id', passphrase: 'from-file' } }),
      v
    )
    expect(p.auth.passphrase).toBe('from-file')
  })

  it('没有 privateKeyPath 时原样返回（那是另一种配置错误，轮不到这里报）', () => {
    const v = vault()
    const p = applyCredentials(profile({ auth: { method: 'key' } }), v)
    expect(p.credentialIssue).toBeUndefined()
  })
})

describe('findPlaintextAuth · 明文检测', () => {
  it('挑出配置文件里的 password 和 passphrase', () => {
    const found = findPlaintextAuth(
      [
        profile({ id: 'a', label: 'A', auth: { method: 'password', password: 'x' } }),
        profile({
          id: 'b',
          label: 'B',
          auth: { method: 'key', privateKeyPath: '/k', passphrase: 'y' }
        }),
        profile({ id: 'c', label: 'C', auth: { method: 'key', privateKeyPath: '/k2' } })
      ],
      { canEncrypt: true }
    )
    expect(found.map((item) => `${item.profileId}:${item.field}`)).toEqual(['a:password', 'b:passphrase'])
  })

  it('canEncrypt 跟着传进来的状态走（决定界面能不能提供"迁移"）', () => {
    const list = [profile({ auth: { method: 'password', password: 'x' } })]
    expect(findPlaintextAuth(list, { canEncrypt: false })[0]!.canEncrypt).toBe(false)
    expect(findPlaintextAuth(list, { canEncrypt: true })[0]!.canEncrypt).toBe(true)
  })

  it('**不返回密码本身**——没必要把明文多传一圈', () => {
    const found = findPlaintextAuth(
      [profile({ auth: { method: 'password', password: 'top-secret' } })],
      { canEncrypt: true }
    )
    expect(JSON.stringify(found)).not.toContain('top-secret')
  })

  it('空密码不算明文（等同于没配）', () => {
    expect(
      findPlaintextAuth([profile({ auth: { method: 'password', password: '' } })], {
        canEncrypt: true
      })
    ).toEqual([])
  })
})
