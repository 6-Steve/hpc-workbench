/**
 * 凭据保险库。
 *
 * 这一份测试的重点不是覆盖率，而是**四条一旦写错就会静默出事的行为**：
 *
 * 1. 明文绝不能出现在存储里（连前缀片段都不行）
 * 2. 三类凭据的 scope 不能串（ssh-password 按 profile，platform 按账号）
 * 3. 钥匙串不可用时必须拒绝保存，而不是"存了个明文"
 * 4. 解密失败必须能和"没存过"区分开
 *
 * 用假的 `Cipher`（base64 加个前缀就当地加密），不碰 Electron，
 * 所以能在纯 node 里跑。
 */
import { describe, expect, it } from 'vitest'
import { CredentialVault, explainVaultError, type Cipher } from '../src/main/credentials/vault'
import {
  credentialKey,
  describeScope,
  normalizeScope,
  isCredentialKind
} from '../src/main/credentials/types'
import type { KVStore } from '../src/main/store/kv'

/** 内存 KV，行为对齐 FileKVStore 的语义 */
function memoryStore(): KVStore & { raw: Map<string, unknown> } {
  const raw = new Map<string, unknown>()
  return {
    raw,
    get<T>(key: string): T | undefined {
      return raw.get(key) as T | undefined
    },
    set<T>(key: string, value: T): void {
      raw.set(key, value)
    },
    delete(key: string): void {
      raw.delete(key)
    },
    keys(): string[] {
      return [...raw.keys()]
    }
  }
}

/** 假加密：可断言"存储里没有明文" */
function fakeCipher(options: { available?: boolean; failDecrypt?: boolean } = {}): Cipher {
  return {
    available: options.available ?? true,
    backend: '测试用假加密',
    encrypt: (plain) => `enc:${Buffer.from(plain, 'utf8').toString('base64')}`,
    decrypt: (cipher) => {
      if (options.failDecrypt) throw new Error('解不开')
      if (!cipher.startsWith('enc:')) throw new Error('格式不对')
      return Buffer.from(cipher.slice(4), 'base64').toString('utf8')
    }
  }
}

function vaultWith(options: { available?: boolean; failDecrypt?: boolean } = {}) {
  const store = memoryStore()
  const vault = new CredentialVault({
    store,
    cipher: fakeCipher(options),
    now: () => new Date('2026-11-06T00:00:00.000Z')
  })
  return { vault, store }
}

describe('CredentialVault · 存取', () => {
  it('存进去能取回来', () => {
    const { vault } = vaultWith()
    vault.set('ssh-password', 'cluster', 'hunter2')
    const found = vault.get('ssh-password', 'cluster')
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.secret).toBe('hunter2')
    expect(found.source).toBe('disk')
  })

  it('存盘的内容里没有明文——连一段都不行', () => {
    const { vault, store } = vaultWith()
    const secret = 'super-secret-P@ssw0rd-2026'
    vault.set('ssh-password', 'cluster', secret)

    // 整个 KV 序列化之后逐段找：完整密码、长度过半的前缀、后半段，
    // 都不该出现。只查完整字符串容易漏掉"存了前缀"这种蠢实现
    const dumped = JSON.stringify([...store.raw.entries()])
    expect(dumped).not.toContain(secret)
    expect(dumped).not.toContain(secret.slice(0, 12))
    expect(dumped).not.toContain(secret.slice(-12))
  })

  it('存的时候会清掉同一条的会话缓存，避免内存里多留一份明文', () => {
    const { vault } = vaultWith()
    vault.rememberForSession('ssh-password', 'cluster', 'old')
    vault.set('ssh-password', 'cluster', 'new')
    const found = vault.get('ssh-password', 'cluster')
    expect(found.ok).toBe(true)
    if (!found.ok) return
    // 拿到的是落盘的那份，说明会话缓存已经被清掉
    expect(found.secret).toBe('new')
    expect(found.source).toBe('disk')
  })

  it('删掉之后取不到', () => {
    const { vault } = vaultWith()
    vault.set('ssh-password', 'cluster', 'x')
    vault.remove('ssh-password', 'cluster')
    expect(vault.get('ssh-password', 'cluster').ok).toBe(false)
    expect(vault.has('ssh-password', 'cluster')).toBe(false)
  })

  it('删到一条不剩时，磁盘上不留空壳', () => {
    const { vault, store } = vaultWith()
    vault.set('ssh-password', 'cluster', 'x')
    vault.remove('ssh-password', 'cluster')
    expect(store.keys()).toEqual([])
  })

  it('空密码被拒——存一个空串等于没存，但界面上会显示"已保存"', () => {
    const { vault } = vaultWith()
    expect(() => vault.set('ssh-password', 'cluster', '')).toThrow()
  })
})

describe('CredentialVault · scope 隔离', () => {
  it('两台跳板机各存各的密码，互不覆盖', () => {
    const { vault } = vaultWith()
    vault.set('ssh-password', 'cluster', 'cluster-pw')
    vault.set('ssh-password', 'jump', 'jump-pw')

    const a = vault.get('ssh-password', 'cluster')
    const b = vault.get('ssh-password', 'jump')
    expect(a.ok && a.secret).toBe('cluster-pw')
    expect(b.ok && b.secret).toBe('jump-pw')
  })

  it('同一个 scope 在不同 kind 下互不相干', () => {
    // 用户名叫 user01，跳板机 id 也叫 user01 是完全可能的
    const { vault } = vaultWith()
    vault.set('ssh-password', 'user01', 'ssh-pw')
    vault.set('platform-password', 'user01', 'ldap-pw')

    const ssh = vault.get('ssh-password', 'user01')
    const ldap = vault.get('platform-password', 'user01')
    expect(ssh.ok && ssh.secret).toBe('ssh-pw')
    expect(ldap.ok && ldap.secret).toBe('ldap-pw')
  })

  it('同一私钥的等价路径指向同一条记录', () => {
    const { vault } = vaultWith()
    const windows = process.platform === 'win32'
    const keyPath = windows ? 'C:\\Users\\x\\.ssh\\id_ed25519' : '/home/x/.ssh/id_ed25519'
    const equivalent = windows ? 'C:/Users/x/.ssh/id_ed25519' : '/home/x/./.ssh/id_ed25519'
    vault.set('key-passphrase', keyPath, 'pp')
    expect(vault.get('key-passphrase', equivalent)).toMatchObject({ ok: true, secret: 'pp' })
  })

  it('删某条 profile 的凭据时，不会连带把私钥口令弄哑', () => {
    /*
     * 这是个真实的坑：私钥口令的 scope 是**文件路径**，同一把 key 会被多条
     * profile 共用。如果"删 profile 就按 scope 全删"，另一台还在用这把 key 的
     * 机器会突然开始要密码，而且没人会联想到是删了别的 profile 导致的。
     */
    const { vault } = vaultWith()
    const keyPath = 'C:/Users/x/.ssh/id_ed25519'
    vault.set('ssh-password', 'cluster', 'ssh-pw')
    vault.set('key-passphrase', keyPath, 'pp')

    vault.removeProfileCredentials('cluster')

    expect(vault.has('ssh-password', 'cluster')).toBe(false)
    // 口令还在
    expect(vault.has('key-passphrase', keyPath)).toBe(true)
  })
})

describe('CredentialVault · 钥匙串不可用', () => {
  it('不可用时拒绝保存，并说清原因（绝不静默存明文）', () => {
    const { vault, store } = vaultWith({ available: false })
    expect(() => vault.set('ssh-password', 'cluster', 'pw')).toThrow(/不可用/)
    // 关键：什么都没写进去
    expect(store.keys()).toEqual([])
  })

  it('不可用时仍然可以"本次记住"，而且不落盘', () => {
    const { vault, store } = vaultWith({ available: false })
    vault.rememberForSession('ssh-password', 'cluster', 'pw')

    const found = vault.get('ssh-password', 'cluster')
    expect(found.ok && found.secret).toBe('pw')
    expect(found.ok && found.source).toBe('session')
    expect(store.keys()).toEqual([])
  })

  it('status 把后端名字和数量如实报出来', () => {
    const { vault } = vaultWith({ available: false })
    vault.rememberForSession('ssh-password', 'a', 'x')
    vault.rememberForSession('ssh-password', 'b', 'y')
    const status = vault.status()
    expect(status.available).toBe(false)
    expect(status.backend).toContain('测试')
    expect(status.stored).toBe(0)
    expect(status.sessionOnly).toBe(2)
  })
})

describe('CredentialVault · 解密失败', () => {
  it('解不开要和"没存过"区分开', () => {
    const { vault } = vaultWith({ failDecrypt: true })
    vault.set('ssh-password', 'cluster', 'pw')

    const found = vault.get('ssh-password', 'cluster')
    expect(found.ok).toBe(false)
    if (found.ok) return
    expect(found.reason).toBe('undecryptable')

    // 对照组：没存过的是 missing
    const missing = vault.get('ssh-password', 'nope')
    expect(missing.ok).toBe(false)
    if (missing.ok) return
    expect(missing.reason).toBe('missing')
  })

  it('一条坏记录不会让整个清单炸掉', () => {
    const { vault, store } = vaultWith()
    vault.set('ssh-password', 'good', 'pw')
    // 手工塞一条形状不对的
    const namespace = store.get<Record<string, unknown>>('credentials.vault') ?? {}
    store.set('credentials.vault', { ...namespace, 'ssh-password::broken': { nope: true } })

    expect(() => vault.list()).not.toThrow()
    expect(vault.list().filter((item) => item.scope === 'good')).toHaveLength(1)
  })
})

describe('CredentialVault · 解密缓存', () => {
  /*
   * 缓存是为了避开"每次 ProfileState.current() 都调一次同步 DPAPI"
   * （启动时会有好几次，之后每 20 秒的作业轮询也要走）。
   *
   * 但缓存一旦失效写错，症状是"改了密码没用"——比慢严重得多。
   * 所以这里两个方向都锁住：**该省的要省，该失效的必须失效**。
   */
  function countingVault() {
    const store = memoryStore()
    let decrypts = 0
    const vault = new CredentialVault({
      store,
      cipher: {
        available: true,
        backend: '计数用',
        encrypt: (plain) => `enc:${Buffer.from(plain, 'utf8').toString('base64')}`,
        decrypt: (value) => {
          decrypts += 1
          return Buffer.from(value.slice(4), 'base64').toString('utf8')
        }
      }
    })
    return {
      vault,
      decryptCount: () => decrypts
    }
  }

  it('同一条凭据只解密一次', () => {
    const { vault, decryptCount } = countingVault()
    vault.set('ssh-password', 'cluster', 'pw')

    for (let i = 0; i < 5; i += 1) {
      expect(vault.has('ssh-password', 'cluster')).toBe(true)
      const found = vault.get('ssh-password', 'cluster')
      expect(found.ok && found.secret).toBe('pw')
    }
    expect(decryptCount()).toBe(1)
  })

  it('换一个密码之后，取到的是新的（不能还拿缓存的旧值）', () => {
    const { vault } = countingVault()
    vault.set('ssh-password', 'cluster', 'old-pw')
    expect((vault.get('ssh-password', 'cluster') as { secret: string }).secret).toBe('old-pw')

    vault.set('ssh-password', 'cluster', 'new-pw')
    expect((vault.get('ssh-password', 'cluster') as { secret: string }).secret).toBe('new-pw')
  })

  it('删掉之后立刻取不到（缓存也要清）', () => {
    const { vault } = countingVault()
    vault.set('ssh-password', 'cluster', 'pw')
    expect(vault.get('ssh-password', 'cluster').ok).toBe(true)

    vault.remove('ssh-password', 'cluster')
    expect(vault.get('ssh-password', 'cluster').ok).toBe(false)
  })

  it('"本次记住"的值优先于磁盘上的旧值', () => {
    const { vault } = countingVault()
    vault.set('ssh-password', 'cluster', 'from-disk')
    vault.rememberForSession('ssh-password', 'cluster', 'from-session')

    const found = vault.get('ssh-password', 'cluster')
    expect(found.ok && found.secret).toBe('from-session')
    expect(found.ok && found.source).toBe('session')
  })

  it('不同 scope 各自缓存，不会串', () => {
    const { vault, decryptCount } = countingVault()
    vault.set('ssh-password', 'a', 'pw-a')
    vault.set('ssh-password', 'b', 'pw-b')

    expect((vault.get('ssh-password', 'a') as { secret: string }).secret).toBe('pw-a')
    expect((vault.get('ssh-password', 'b') as { secret: string }).secret).toBe('pw-b')
    expect(decryptCount()).toBe(2)
  })
})

describe('types · scope 规范化', () => {
  it.runIf(process.platform === 'win32')('key-passphrase 的 Windows 路径分隔符被统一', () => {
    const a = normalizeScope('key-passphrase', 'C:\\Users\\x\\id')
    const b = normalizeScope('key-passphrase', 'C:/Users/x/id')
    expect(a).toBe(b)
    expect(a).not.toContain('\\')
  })

  it('profileId 和账号名只 trim，不猜别名', () => {
    expect(normalizeScope('ssh-password', '  cluster  ')).toBe('cluster')
    expect(normalizeScope('platform-password', ' user01 ')).toBe('user01')
  })

  it('空 scope 直接抛——存进去也永远取不回来', () => {
    expect(() => normalizeScope('ssh-password', '   ')).toThrow()
  })

  it('credentialKey 不会因为 scope 里含冒号就切错', () => {
    // profileId 理论上不会有冒号，但万一有，也不能把 kind 切走
    const key = credentialKey('ssh-password', 'a::b')
    expect(key.startsWith('ssh-password::')).toBe(true)
  })

  it('describeScope 对路径只显示最后两段', () => {
    const text = describeScope('key-passphrase', 'C:/Users/someone/really/deep/.ssh/id_ed25519')
    expect(text).toBe('…/.ssh/id_ed25519')
  })

  it('isCredentialKind 挡住乱填的种类', () => {
    expect(isCredentialKind('ssh-password')).toBe(true)
    expect(isCredentialKind('whatever')).toBe(false)
    expect(isCredentialKind(null)).toBe(false)
  })
})

describe('explainVaultError · 给用户的话', () => {
  it('不可用的原因原样透出，不要包成"保存失败"', () => {
    const text = explainVaultError(new Error('这台机器上系统钥匙环不可用，无法保存密码'))
    expect(text).toContain('不可用')
    expect(text).not.toContain('保存失败')
  })

  it('空密码给一句短的', () => {
    expect(explainVaultError(new Error('密码是空的，没有可存的内容'))).toBe('密码是空的')
  })

  it('不认识的异常兜底，但不能把对象打印成 [object Object]', () => {
    expect(explainVaultError('boom')).toBe('保存失败：boom')
  })
})
