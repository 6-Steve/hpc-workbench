/**
 * 单台主机的编辑。
 *
 * 这里最要紧的不是"能改字段"，而是三条**不改**：
 * 不改 id、不碰别的主机、不把密码写进 JSON。
 */
import { describe, expect, it } from 'vitest'
import { ConfigError } from '../src/main/profiles'
import { patchProfile, type ProfilePatch } from '../src/main/profiles-edit'

const FILE = JSON.stringify({
  version: 2,
  defaultProfile: 'hpc',
  profiles: [
    {
      id: 'hpc',
      label: 'hpc',
      host: '192.0.2.46',
      port: 2223,
      username: 'alice',
      auth: { method: 'key', privateKeyPath: '~/.ssh/id_rsa' }
    },
    {
      id: 'hpc-02',
      label: 'hpc-02',
      host: '192.0.2.46',
      port: 2222,
      username: 'alice',
      auth: { method: 'key', privateKeyPath: '~/.ssh/id_rsa' }
    }
  ]
})

const patch = (over: Partial<ProfilePatch> = {}): ProfilePatch => ({
  id: 'hpc-02',
  label: 'hpc-02',
  host: '192.0.2.46',
  port: 2224,
  username: 'alice',
  auth: { method: 'key', privateKeyPath: '~/.ssh/id_rsa' },
  ...over
})

describe('patchProfile · 只动目标那一台', () => {
  it('改端口后只有它变了，另一台原样', () => {
    const result = patchProfile(FILE, patch(), '/tmp/profiles.json')
    const after = JSON.parse(result.text)

    expect(after.profiles[1].port).toBe(2224)
    expect(after.profiles[0]).toEqual(JSON.parse(FILE).profiles[0])
    expect(result.changed).toBe(true)
  })

  it('什么都没改时 changed=false（调用方可以跳过写盘）', () => {
    const result = patchProfile(FILE, patch({ port: 2222 }), '/tmp/profiles.json')
    expect(result.changed).toBe(false)
  })

  it('previous 带出旧的连接参数（界面用来判断要不要提醒重连）', () => {
    const result = patchProfile(FILE, patch(), '/tmp/profiles.json')
    expect(result.previous).toMatchObject({ host: '192.0.2.46', port: 2222, method: 'key' })
  })
})

describe('patchProfile · 三条保护', () => {
  /*
   * id 是连接池的键。改了 id，旧会话会成孤儿：
   * 隧道/终端挂在上面继续跑，界面上却再也找不到它。
   */
  it('patch 里塞了别的 id 也不采纳', () => {
    const result = patchProfile(FILE, patch({ id: 'hpc-02' }), '/tmp/profiles.json')
    const after = JSON.parse(result.text)
    expect(after.profiles[1].id).toBe('hpc-02')
    // 也没有凭空多出一台
    expect(after.profiles).toHaveLength(2)
  })

  it('密码永远不会出现在 JSON 里', () => {
    const result = patchProfile(
      FILE,
      // 故意多塞一个 password：patchProfile 只认已知字段，它不该漏进 JSON
      ({ ...patch({ auth: { method: 'password' } }), password: 'hunter2' } as unknown as ProfilePatch),
      '/tmp/profiles.json'
    )
    expect(result.text).not.toContain('hunter2')
    // 注意不能断言 `not.toContain('password')`：值就是 "password"
    expect(result.text).not.toContain('"password":')
    expect(JSON.parse(result.text).profiles[1].auth).toEqual({ method: 'password' })
  })

  it('其余顶层字段（defaultProfile / version / $comment）保留', () => {
    const withComment = JSON.stringify({
      $comment: '手写的说明',
      version: 2,
      defaultProfile: 'hpc',
      profiles: JSON.parse(FILE).profiles
    })
    const after = JSON.parse(patchProfile(withComment, patch(), '/tmp/x.json').text)
    expect(after.$comment).toBe('手写的说明')
    expect(after.defaultProfile).toBe('hpc')
  })
})

describe('patchProfile · 拒绝而不是猜', () => {
  it('找不到 id → 抛 ConfigError', () => {
    expect(() => patchProfile(FILE, patch({ id: 'nope' }), '/tmp/x.json')).toThrow(ConfigError)
  })

  it('坏 JSON → 抛 ConfigError（不返回半成品）', () => {
    expect(() => patchProfile('{ 坏掉的', patch(), '/tmp/x.json')).toThrow(ConfigError)
  })

  /*
   * 端口非法必须在**写盘之前**被拦下：否则文件里会留下一台连不上的主机。
   * 拦它的是启动时那套 `validateProfiles`，不是这里另写一份规则。
   */
  it('端口非法 → 校验拦下', () => {
    expect(() => patchProfile(FILE, patch({ port: 70000 }), '/tmp/x.json')).toThrow()
  })

  it('私钥方式但路径为空 → 校验拦下', () => {
    expect(() =>
      patchProfile(FILE, patch({ auth: { method: 'key', privateKeyPath: '' } }), '/tmp/x.json')
    ).toThrow()
  })

  it('输出以换行结尾（和向导写出的文件格式一致）', () => {
    const result = patchProfile(FILE, patch(), '/tmp/x.json')
    expect(result.text.endsWith('\n')).toBe(true)
  })
})
