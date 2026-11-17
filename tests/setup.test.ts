/**
 * 首次向导：输入规则 + 落盘。
 *
 * 这里守的是三件"看起来没问题、实际会咬人"的事：
 * 1. 向导写出来的文件**必须能被启动时的加载器读回来**（否则就是"配好了却连不上"）
 * 2. 密码**一个字都不能落进 JSON**（写进去了等于前面凭据模块白做）
 * 3. 私钥路径不存在时要**在向导里就拦下**，而不是等到连接时才报
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { emptyDraft, setupProfileId, validateSetupDraft, type SetupDraft } from '../src/shared/setup'
import { applySetup } from '../src/main/setup'
import { loadProfiles } from '../src/main/profiles'
import type { CredentialVault } from '../src/main/credentials/vault'

const ROOT = mkdtempSync(join(tmpdir(), 'hpc-setup-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

/** 一份真实存在的私钥（内容无所谓，向导只查存在性） */
const KEY_DIR = join(ROOT, 'keyfile')
mkdirSync(KEY_DIR, { recursive: true })
const KEY_PATH = join(KEY_DIR, 'id_ed25519')
writeFileSync(KEY_PATH, 'KEY')

function draft(patch: Partial<SetupDraft> = {}): SetupDraft {
  return { ...emptyDraft(), host: 'login.example.edu.cn', username: 'user01', privateKeyPath: KEY_PATH, ...patch }
}

/** 只记录调用，不做真加密——这里验的是"有没有存"，不是 DPAPI */
function fakeVault(): { vault: CredentialVault; calls: Array<[string, string, string]> } {
  const calls: Array<[string, string, string]> = []
  const vault = {
    set: (kind: string, scope: string, secret: string) => {
      calls.push([kind, scope, secret])
    }
  } as unknown as CredentialVault
  return { vault, calls }
}

describe('setup · 输入规则', () => {
  it('空表单会指出所有必填项', () => {
    const issues = validateSetupDraft(emptyDraft())
    const fields = issues.map((i) => i.field).sort()
    // label 有默认值、port 默认 22，所以不报；host/username/privateKeyPath 必填
    expect(fields).toEqual(['host', 'privateKeyPath', 'username'])
  })

  it('端口必须是 1–65535 的整数', () => {
    for (const bad of ['0', '65536', '22.5', 'abc', '']) {
      const issues = validateSetupDraft(draft({ port: bad }))
      expect(issues.some((i) => i.field === 'port'), bad).toBe(true)
    }
    expect(validateSetupDraft(draft({ port: '2222' }))).toEqual([])
  })

  it('host 带协议或路径要拦（用户很爱粘 ssh 命令）', () => {
    expect(validateSetupDraft(draft({ host: 'ssh://login.edu.cn' })).some((i) => i.field === 'host')).toBe(true)
    expect(validateSetupDraft(draft({ host: 'login.edu.cn/path' })).some((i) => i.field === 'host')).toBe(true)
    expect(validateSetupDraft(draft({ host: 'log in' })).some((i) => i.field === 'host')).toBe(true)
  })

  it('.ppk 私钥要拦并给出转换办法', () => {
    const issues = validateSetupDraft(draft({ privateKeyPath: 'C:\\k\\id.ppk' }))
    const hit = issues.find((i) => i.field === 'privateKeyPath')
    expect(hit?.message).toContain('puttygen')
  })

  it('密码方式下密码必填（向导里不放行，避免"配好却连不上"）', () => {
    const issues = validateSetupDraft(draft({ method: 'password', password: '' }))
    expect(issues.some((i) => i.field === 'password')).toBe(true)
    expect(validateSetupDraft(draft({ method: 'password', password: 'x' }))).toEqual([])
  })

  it('名称过长要拦（只是显示用，但不该撑破界面）', () => {
    expect(validateSetupDraft(draft({ label: 'x'.repeat(41) })).some((i) => i.field === 'label')).toBe(true)
  })
})

describe('setup · profile id', () => {
  it('中文名退回 cluster（id 只允许 ASCII）', () => {
    expect(setupProfileId('我的集群')).toBe('cluster')
    expect(setupProfileId('')).toBe('cluster')
  })

  it('英文名转成合法 slug', () => {
    expect(setupProfileId('Lab Cluster')).toBe('lab-cluster')
    expect(setupProfileId('  A2/B3  ')).toBe('a2-b3')
  })
})

describe('setup · 落盘', () => {
  it('写出来的文件能被启动加载器读回（同一套规则）', () => {
    const dir = join(ROOT, 'ok')
    const { vault } = fakeVault()
    const result = applySetup({ draft: draft(), dir }, { credentials: vault })

    expect(result.ok).toBe(true)
    expect(result.configPath).toBe(join(dir, 'profiles.json'))

    const loaded = loadProfiles(result.configPath!)
    expect(loaded.profiles).toHaveLength(1)
    expect(loaded.profiles[0]!.host).toBe('login.example.edu.cn')
    expect(loaded.profiles[0]!.username).toBe('user01')
    expect(loaded.profiles[0]!.port).toBe(22)
    expect(loaded.defaultProfile).toBe(loaded.profiles[0]!.id)
  })

  it('密码写进钥匙串，**不出现在文件里**', () => {
    const dir = join(ROOT, 'pwd')
    const { vault, calls } = fakeVault()
    const secret = 'p@ssw0rd-should-not-leak'

    const result = applySetup({ draft: draft({ method: 'password', password: secret }), dir }, { credentials: vault })
    expect(result.ok).toBe(true)

    const text = readFileSync(result.configPath!, 'utf8')
    expect(text).not.toContain(secret)
    expect(JSON.parse(text).profiles[0].auth).toEqual({ method: 'password' })

    expect(calls).toEqual([['ssh-password', setupProfileId('我的集群'), secret]])
  })

  it('私钥口令同样只进钥匙串', () => {
    const dir = join(ROOT, 'key')
    const { vault, calls } = fakeVault()

    const result = applySetup(
      { draft: draft({ privateKeyPath: KEY_PATH, passphrase: 'key-pass' }), dir },
      { credentials: vault }
    )
    expect(result.ok).toBe(true)
    expect(readFileSync(result.configPath!, 'utf8')).not.toContain('key-pass')
    expect(calls[0]![0]).toBe('key-passphrase')
  })

  it('私钥文件不存在 → 在向导里就拦下（不去建一份连不上的配置）', () => {
    const { vault } = fakeVault()
    const result = applySetup(
      { draft: draft({ privateKeyPath: join(ROOT, 'nope', 'id_ed25519') }), dir: join(ROOT, 'missing') },
      { credentials: vault }
    )
    expect(result.ok).toBe(false)
    expect(result.issues?.[0]?.field).toBe('privateKeyPath')
    expect(result.issues?.[0]?.message).toContain('找不到这个文件')
  })

  it('凭据存不进去时只降级成警告（配置已经写好了）', () => {
    const dir = join(ROOT, 'vault-fail')
    const vault = {
      set: () => {
        throw new Error('钥匙串不可用')
      }
    } as unknown as CredentialVault

    const result = applySetup({ draft: draft({ method: 'password', password: 'x' }), dir }, { credentials: vault })
    expect(result.ok).toBe(true)
    expect(result.warnings?.[0]).toContain('钥匙串')
    expect(loadProfiles(result.configPath!).profiles).toHaveLength(1)
  })
})


describe('setup · 多主机（从 SSH 配置一起导入）', () => {
  /*
   * `profiles` 本来就是数组，标题栏的跳板机切换器列的就是它。
   * 向导只写一台的后果很具体：用户 `ssh config` 里配了两台登录节点，
   * 装完却只能连一台——那是功能退化，不是简化。
   */
  it('主 + 一台附带主机 → 两条 profile，默认是第一条', () => {
    const dir = join(ROOT, 'multi')
    const { vault } = fakeVault()
    const result = applySetup(
      {
        draft: draft({ label: 'hpc' }),
        extras: [draft({ label: 'hpc-02', port: '2222' })],
        dir
      },
      { credentials: vault }
    )

    expect(result.ok).toBe(true)
    const loaded = loadProfiles(result.configPath!)
    expect(loaded.profiles.map((p) => p.id)).toEqual(['hpc', 'hpc-02'])
    expect(loaded.profiles[1]!.port).toBe(2222)
    expect(loaded.defaultProfile).toBe('hpc')
  })

  it('附带主机的私钥不存在 → 跳过它但主配置照写（并给出警告）', () => {
    const dir = join(ROOT, 'multi-badkey')
    const { vault } = fakeVault()
    const result = applySetup(
      {
        draft: draft({ label: 'hpc' }),
        extras: [draft({ label: 'broken', privateKeyPath: join(ROOT, 'nope', 'id_rsa') })],
        dir
      },
      { credentials: vault }
    )

    expect(result.ok).toBe(true)
    expect(loadProfiles(result.configPath!).profiles).toHaveLength(1)
    expect(result.warnings?.join()).toContain('没加进来')
  })

  it('附带主机重名 → 跳过，不产生重复 id', () => {
    const dir = join(ROOT, 'multi-dup')
    const { vault } = fakeVault()
    const result = applySetup(
      { draft: draft({ label: 'hpc' }), extras: [draft({ label: 'hpc' })], dir },
      { credentials: vault }
    )

    expect(result.ok).toBe(true)
    expect(loadProfiles(result.configPath!).profiles).toHaveLength(1)
    expect(result.warnings?.join()).toContain('重名')
  })
})
