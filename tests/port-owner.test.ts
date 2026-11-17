/**
 * 反查「集群侧端口被谁占着」。
 *
 * 这一组测试存在的理由：反方向的转发绑不上时，ssh2 只给一句
 * `Unable to bind to 127.0.0.1:55555`——**协议里没有原因字段**。
 * 第一版照着这句话猜「是你自己手敲的 ssh -R 还开着」，真机一验就错了：
 * 占着 55555 是另一个账号。所以现在改成真去读 `/proc/net/tcp` 的 uid，
 * 这里锁住解析与措辞，别再退回猜测。
 */
import { describe, expect, it } from 'vitest'
import {
  lookupPortOwner,
  parsePortOwner,
  portBusyHint,
  portOwnerCommand,
  suggestPorts,
  type CommandRunner
} from '../src/main/domain/port-owner'

function makeRunner(output: string, code = 0): CommandRunner & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async exec(command: string) {
      calls.push(command)
      return { stdout: output, code, stderr: '' }
    }
  }
}

describe('反查命令', () => {
  it('端口转成 4 位大写十六进制', () => {
    // 55555 = 0xD903，不是 "55555"——/proc/net/tcp 里存的是十六进制
    expect(portOwnerCommand(55555)).toContain(':D903')
    expect(portOwnerCommand(55555)).not.toContain(':55555')
  })

  it('小端口要补零，不能变成三位', () => {
    // 22 = 0x16 → 0016。用 toString(16) 不补零会写成 ":16"，
    // 那会误匹配端口 0x0016... 之外的一堆东西
    expect(portOwnerCommand(22)).toContain(':0016')
  })

  it('两个 tcp 表都查，IPv6 也可能占着', () => {
    const command = portOwnerCommand(8080)
    expect(command).toContain('/proc/net/tcp ')
    expect(command).toContain('/proc/net/tcp6')
  })

  it('按本地端口匹配、不看状态——占着端口的可能是客户端', () => {
    // 实测踩过：某人的**客户端**把源端口显式绑到 55556 再连出去，
    // /proc/net/tcp 里是一对 ESTAB、没有 LISTEN。只认 0A 会得出"没人占"的错误结论，
    // 然后我们去 bind 照样 EADDRINUSE。所以只看 $2（本地地址），不看状态、也不看 $3。
    const command = portOwnerCommand(55555)
    expect(command).toContain('$2 ~ pat')
    expect(command).not.toContain('$3')
    expect(command).not.toContain('"0A"')
  })

  it('不需要 root 权限，也不调用 sudo', () => {
    expect(portOwnerCommand(55555)).not.toContain('sudo')
  })

  it('生成的脚本结构上是一段能跑的循环——拦「do;」这类空命令语法错', () => {
    // 第一版是按 "; " 把片段 join 起来的，结果拼出 `for ...; do; if ...`，
    // bash 直接 syntax error。当时所有用例都在断言"包含 :D903"，一条都没拦住。
    //
    // 不用真的 spawn bash 去 `-n`：本机沙箱里 spawnSync('bash') 直接 EBUSY，
    // 测试只能静默跳过，看着绿其实一条没跑。检查真正会出错的几个结构特征更可靠。
    const command = portOwnerCommand(55555)
    expect(command).not.toMatch(/\bdo\s*;/)
    const opens = (command.match(/\bdo\b/g) ?? []).length
    const closes = (command.match(/\bdone\b/g) ?? []).length
    expect(opens).toBe(closes)
    expect((command.match(/'/g) ?? []).length % 2).toBe(0)
    expect((command.match(/"/g) ?? []).length % 2).toBe(0)
  })
})

describe('解析反查结果', () => {
  it('标准输出解析成 uid + 用户名', () => {
    expect(parsePortOwner('10310:sdchen\n')).toEqual({ uid: 10310, username: 'sdchen' })
  })

  it('用户名查不到时是 null，不能当成空字符串混过去', () => {
    // getent 失败（LDAP 抖动 / 用户已删）时命令输出 "10310:"
    expect(parsePortOwner('10310:\n')).toEqual({ uid: 10310, username: null })
  })

  it('没有输出表示查不到', () => {
    expect(parsePortOwner('')).toBeNull()
    expect(parsePortOwner('\n\n')).toBeNull()
  })

  it('前面有噪音行时取第一条有效结果', () => {
    expect(parsePortOwner('awk: warning\n0:root\n10310:sdchen\n')).toEqual({
      uid: 0,
      username: 'root'
    })
  })

  it('非 uid:name 形状的行一律跳过', () => {
    expect(parsePortOwner('LISTEN 0 128 127.0.0.1:55555')).toBeNull()
  })
})

describe('lookupPortOwner', () => {
  it('正常情况返回所有者', async () => {
    const runner = makeRunner('10310:sdchen\n')
    await expect(lookupPortOwner(runner, 55555)).resolves.toEqual({
      uid: 10310,
      username: 'sdchen'
    })
  })

  it('命令本身出错时返回 null，不抛', async () => {
    // 这是失败路径上的诊断：诊断自己再抛，会把真正的绑定错误盖掉
    const runner: CommandRunner = {
      async exec() {
        throw new Error('连接断了')
      }
    }
    await expect(lookupPortOwner(runner, 55555)).resolves.toBeNull()
  })

  it('非零退出码且无输出时返回 null', async () => {
    const runner = makeRunner('', 127)
    await expect(lookupPortOwner(runner, 55555)).resolves.toBeNull()
  })

  it('端口不合法时连命令都不发', async () => {
    const runner = makeRunner('10310:sdchen\n')
    await expect(lookupPortOwner(runner, 0)).resolves.toBeNull()
    await expect(lookupPortOwner(runner, 70000)).resolves.toBeNull()
    expect(runner.calls).toHaveLength(0)
  })
})

describe('给用户的措辞', () => {
  it('查到是谁就报名字', () => {
    const hint = portBusyHint(55555, { uid: 10310, username: 'sdchen' })
    expect(hint).toContain('sdchen')
    expect(hint).toContain('55555')
  })

  it('必须点明 127.0.0.1 是全用户共享的', () => {
    // 不写这句，用户会一直怀疑自己开没开那条 ssh -R——
    // 这正是第一版提示把人带偏的地方
    const hint = portBusyHint(55555, { uid: 10310, username: 'sdchen' })
    expect(hint).toContain('所有用户共享')
  })

  it('查不到就说查不到，不编原因', () => {
    const hint = portBusyHint(55555, null)
    expect(hint).toContain('没查到')
    expect(hint).not.toContain('手敲')
  })

  it('uid 有、名字没有时用 uid 指代', () => {
    const hint = portBusyHint(55555, { uid: 10310, username: null })
    expect(hint).toContain('10310')
  })

  it('总是给一个能立刻照做的退路', () => {
    for (const hint of [
      portBusyHint(55555, null),
      portBusyHint(55555, { uid: 0, username: 'root' })
    ]) {
      expect(hint).toContain('55556')
    }
  })
})

describe('备选端口', () => {
  it('从原端口往后取，不重复原端口', () => {
    expect(suggestPorts(55555, 2)).toEqual([55556, 55557])
  })

  it('不越过 65535', () => {
    expect(suggestPorts(65535, 3)).toEqual([])
    expect(suggestPorts(65534, 3)).toEqual([65535])
  })
})
