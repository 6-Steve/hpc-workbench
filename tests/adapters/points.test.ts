import { describe, expect, it } from 'vitest'
import { parsePoints } from '../../src/main/adapters/points'
import { fixture } from '../fixtures'

describe('parsePoints（真实夹具）', () => {
  it('单行三浮点', () => {
    const result = parsePoints(fixture('scir-account.txt'))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.total).toBe(5200)
      expect(result.data.used).toBeCloseTo(689.88, 2)
      expect(result.data.avail).toBeCloseTo(4510.12, 2)
    }
  })
})

describe('parsePoints（边界）', () => {
  it('容忍千分位逗号与多余空白', () => {
    const result = parsePoints('Total:  5,200.00   Used: 683.46   Avail: 4,516.54\n')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.total).toBe(5200)
      expect(result.data.avail).toBe(4516.54)
    }
  })

  it('字段顺序乱了就失败，不猜', () => {
    const result = parsePoints('Avail: 1 Used: 2 Total: 3')
    expect(result.ok).toBe(false)
  })

  it('命令不存在时保留原始 stderr 片段', () => {
    const raw = 'bash: scir-account: command not found'
    const result = parsePoints(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.raw).toBe(raw)
      expect(result.reason).toContain('Total')
    }
  })

  it('空输出时理由指向"没有输出"', () => {
    const result = parsePoints('  \n ')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('没有输出')
  })

  it('数字里混进非法字符时失败', () => {
    const result = parsePoints('Total: 5x00 Used: 683 Avail: 4516')
    expect(result.ok).toBe(false)
  })
})
