/**
 * `~/.ssh/config` 解析。
 *
 * 这一层的错法都很隐蔽：**端口填错 → 一直超时**，用户名填错 → 三次密码后断开，
 * 两者都不会指向"导入功能"，用户只会以为集群坏了。所以每条 ssh 语义都要钉住。
 */
import { describe, expect, it } from 'vitest'
import { draftFromSshHost, parseSshConfig } from '../src/shared/ssh-config'

describe('ssh config · 基本字段', () => {
  it('四个字段都读出来', () => {
    const { hosts } = parseSshConfig(`
Host hpc
  HostName 192.0.2.46
  User alice
  Port 2223
  IdentityFile ~/.ssh/id_rsa
`)
    expect(hosts).toEqual([
      {
        alias: 'hpc',
        hostName: '192.0.2.46',
        user: 'alice',
        port: 2223,
        identityFile: '~/.ssh/id_rsa',
        proxyJump: undefined
      }
    ])
  })

  it('没写 HostName 时用别名', () => {
    const { hosts } = parseSshConfig('Host box\n  User me\n')
    expect(hosts[0]!.hostName).toBe('box')
    expect(hosts[0]!.port).toBeUndefined()
  })

  it('`Key=Value` 和 `Key Value` 两种写法都认', () => {
    const { hosts } = parseSshConfig('Host a\nHostName=x.org\nUser=u\nPort=2200\n')
    expect(hosts[0]).toMatchObject({ hostName: 'x.org', user: 'u', port: 2200 })
  })

  it('关键字大小写不敏感', () => {
    const { hosts } = parseSshConfig('HOST a\nhostname x.org\nUSER u\n')
    expect(hosts[0]).toMatchObject({ hostName: 'x.org', user: 'u' })
  })

  it('注释和行尾注释都去掉，引号里的 # 保留', () => {
    const { hosts } = parseSshConfig('# 头注释\nHost a\n  HostName "x#y.org" # 行尾\n')
    expect(hosts[0]!.hostName).toBe('x#y.org')
  })
})

describe('ssh config · 多主机与通配', () => {
  it('一行写多个模式，每个都算一台具体主机', () => {
    const { hosts } = parseSshConfig('Host a b c\n  User u\n')
    expect(hosts.map((h) => h.alias)).toEqual(['a', 'b', 'c'])
  })

  it('`Host *` 只当默认值，不出现在列表里', () => {
    const { hosts } = parseSshConfig(`
Host a
  HostName x.org
Host *
  User fallback
  Port 2200
`)
    expect(hosts.map((h) => h.alias)).toEqual(['a'])
    // 前面 a 块没给 User/Port，轮到 `Host *` 补
    expect(hosts[0]).toMatchObject({ user: 'fallback', port: 2200 })
  })

  /*
   * **先到先得**（first-obtained-wins）与"后者覆盖"的区别，是这段代码最容易写错的地方。
   * 写反了的表现：`Host *` 放在文件末尾时，会把前面每台主机自己的 User 全部改掉。
   */
  it('先到先得：前面的值不被后面的块覆盖', () => {
    const { hosts } = parseSshConfig(`
Host a
  User real-user
Host *
  User wildcard-user
`)
    expect(hosts[0]!.user).toBe('real-user')
  })

  it('`Host *.edu` 这类通配能给多台主机提供默认值', () => {
    const { hosts } = parseSshConfig(`
Host a.edu b.edu
  HostName 10.0.0.1
Host *.edu
  Port 2022
`)
    expect(hosts.every((h) => h.port === 2022)).toBe(true)
  })

  it('`!` 取反能排除某台', () => {
    const { hosts } = parseSshConfig(`
Host a b
  Port 2000
Host * !a
  User shared
`)
    const a = hosts.find((h) => h.alias === 'a')
    const b = hosts.find((h) => h.alias === 'b')
    expect(a?.user).toBeUndefined()
    expect(b?.user).toBe('shared')
  })
})

describe('ssh config · 异常与边界', () => {
  it('没有 Host 段 → 空列表（不抛）', () => {
    expect(parseSshConfig('User me\nPort 22\n').hosts).toEqual([])
    expect(parseSshConfig('').hosts).toEqual([])
  })

  it('端口不是数字 → 忽略并给出警告', () => {
    const { hosts, warnings } = parseSshConfig('Host a\nPort abc\n')
    expect(hosts[0]!.port).toBeUndefined()
    expect(warnings.join()).toContain('不是有效端口')
  })

  it('端口越界同样忽略', () => {
    const { hosts } = parseSshConfig('Host a\nPort 70000\n')
    expect(hosts[0]!.port).toBeUndefined()
  })

  it('Include 不展开，但要告诉用户（否则"少了几台主机"无从解释）', () => {
    const { warnings } = parseSshConfig('Include ~/.ssh/config.d/*\nHost a\n')
    expect(warnings.join()).toContain('Include')
  })

  it('Match 块整块跳过，不污染后面的 Host', () => {
    const { hosts } = parseSshConfig(`
Host a
  User before
Match host x
  User leaked
Host b
  User after
`)
    expect(hosts.map((h) => h.alias)).toEqual(['a', 'b'])
    expect(hosts.find((h) => h.alias === 'b')?.user).toBe('after')
  })

  it('ProxyJump 记下来并警告（本应用是直连）', () => {
    const { hosts, warnings } = parseSshConfig('Host a\nProxyJump jump.example.org\n')
    expect(hosts[0]!.proxyJump).toBe('jump.example.org')
    expect(warnings.join()).toContain('ProxyJump')
  })
})

describe('ssh config · 变成表单值', () => {
  it('缺省端口补 22，缺私钥路径留空', () => {
    const draft = draftFromSshHost({ alias: 'a', hostName: 'x.org' })
    expect(draft).toEqual({ label: 'a', host: 'x.org', port: '22', username: '', privateKeyPath: '' })
  })

  it('有端口就照抄（这里的 2223 是真实集群的跳板端口）', () => {
    const draft = draftFromSshHost({
      alias: 'hpc',
      hostName: '192.0.2.46',
      user: 'alice',
      port: 2223,
      identityFile: '~/.ssh/id_rsa'
    })
    expect(draft).toMatchObject({ host: '192.0.2.46', port: '2223', username: 'alice' })
  })
})
