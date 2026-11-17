/**
 * 诊断包的脱敏。
 *
 * 这段代码的失败方式不是"显示不好看"，是**泄露**——包是要发出去的。
 * 所以每一条规则都要有用例，尤其是"命令原文里嵌了密码"这种最容易被忘掉的情况。
 */
import { describe, expect, it } from 'vitest'
import {
  maskHomePath,
  maskHost,
  maskKeyPath,
  maskUsername,
  redactKnownHosts,
  redactProfilesFile,
  scrubSecrets
} from '../src/shared/diagnostic'

describe('脱敏 · 主机地址', () => {
  it('IPv4 留前两段', () => {
    expect(maskHost('192.0.2.46')).toBe('192.0.*.*')
    expect(maskHost('192.168.1.1')).toBe('192.168.*.*')
  })

  it('IPv6 留前两组', () => {
    expect(maskHost('2001:da8:1:2::5')).toBe('2001:da8:*')
  })

  it('域名留首尾两位', () => {
    expect(maskHost('login.example.edu.cn')).toBe('lo***.cn')
  })

  it('太短的名字直接全遮（否则等于没遮）', () => {
    expect(maskHost('hpc1')).toBe('***')
  })

  it('空值不炸', () => {
    expect(maskHost('')).toBe('')
  })
})

describe('脱敏 · 用户名与路径', () => {
  it('用户名留首尾 + 长度', () => {
    expect(maskUsername('alice')).toBe('a***e(5)')
    expect(maskUsername('ab')).toBe('***(2)')
  })

  /*
   * 私钥路径里带用户名（C:\Users\alice\...），而"私钥放在哪"对诊断没有价值。
   * 只留文件名，方便判断"是不是 .ppk""是不是 ed25519"。
   */
  it('私钥路径只留文件名，.ssh 收成 ~', () => {
    expect(maskKeyPath('C:\\Users\\alice\\.ssh\\id_rsa')).toBe('~/.ssh/id_rsa')
    expect(maskKeyPath('/home/alice/.ssh/id_ed25519')).toBe('~/.ssh/id_ed25519')
    expect(maskKeyPath('D:\\keys\\work.pem')).toBe('…/work.pem')
  })

  it('配置目录里的用户名段替换掉', () => {
    expect(maskHomePath('C:\\Users\\alice\\AppData\\Roaming\\hpc')).toBe(
      'C:\\Users\\<user>\\AppData\\Roaming\\hpc'
    )
    expect(maskHomePath('/home/alice/.config/hpc')).toBe('/home/<user>/.config/hpc')
  })
})

describe('脱敏 · 自由文本里的秘密', () => {
  it('key=value 形式的密码/令牌被替换', () => {
    expect(scrubSecrets('export TOKEN=abcd1234')).toBe('export TOKEN=***')
    expect(scrubSecrets('mysql --password=hunter2 -e "select 1"')).toContain('--password=***')
    expect(scrubSecrets('API_KEY: abc-123')).toContain('***')
  })

  it('OpenAI 风格的 sk- 令牌被替换', () => {
    expect(scrubSecrets('key sk-abcdefgh12345678 end')).toBe('key sk-*** end')
  })

  it('Bearer 头被替换', () => {
    expect(scrubSecrets('Authorization: Bearer abc.def.ghi')).toContain('Bearer ***')
  })

  /*
   * `mysql -pMyPass123` 这种写法没有 `=`，只能靠 `-pXXXX` 抓。
   * 宁可把 `-pA100`（分区名）也遮掉，也不能漏掉密码。
   */
  it('-pXXXX 这种紧贴写法也遮住', () => {
    expect(scrubSecrets('mysql -uroot -pMyPass123')).toContain('-p***')
    expect(scrubSecrets('mysql -uroot -pMyPass123')).not.toContain('MyPass123')
  })

  it('普通命令不被动到', () => {
    const cmd = 'squeue --me --format="%.18i %.9P %.30j %.8u"'
    expect(scrubSecrets(cmd)).toBe(cmd)
  })
})

describe('脱敏 · 配置文件（白名单）', () => {
  const raw = {
    version: 2,
    defaultProfile: 'hpc',
    profiles: [
      {
        id: 'hpc',
        label: 'hpc',
        host: '192.0.2.46',
        port: 2223,
        username: 'alice',
        auth: { method: 'key', privateKeyPath: 'C:\\Users\\alice\\.ssh\\id_rsa', password: 'leaked' },
        maxConcurrent: 5,
        // 将来可能有的字段：默认不该出现在包里
        jumpHost: 'bastion.internal.example'
      }
    ]
  }

  it('认识的字段保留并脱敏，端口不遮（诊断需要）', () => {
    const result = redactProfilesFile(raw)
    expect(result.profiles[0]).toMatchObject({
      id: 'hpc',
      host: '192.0.*.*',
      port: 2223,
      username: 'a***e(5)',
      auth: { method: 'key', privateKeyPath: '~/.ssh/id_rsa' }
    })
    expect(result.defaultProfile).toBe('hpc')
  })

  it('auth 里只留 method 和路径，密码绝不带出', () => {
    const text = JSON.stringify(redactProfilesFile(raw))
    expect(text).not.toContain('leaked')
    expect(text).not.toContain('password')
  })

  it('白名单之外的新字段默认不出现（多一个字段不多一个漏点）', () => {
    const text = JSON.stringify(redactProfilesFile(raw))
    expect(text).not.toContain('bastion.internal.example')
  })

  it('畸形输入不炸', () => {
    expect(redactProfilesFile(null).profiles).toEqual([])
    expect(redactProfilesFile({}).profiles).toEqual([])
  })
})

describe('脱敏 · known_hosts', () => {
  it('键里的 host 脱敏，端口和指纹保留', () => {
    const result = redactKnownHosts({
      version: 1,
      hosts: {
        '192.0.2.46:2223': [{ algorithm: 'ssh-ed25519', fingerprint: 'SHA256:abc' }]
      }
    })
    expect(Object.keys(result.hosts)).toEqual(['192.0.*.*:2223'])
    expect(JSON.stringify(result)).toContain('SHA256:abc')
  })
})
