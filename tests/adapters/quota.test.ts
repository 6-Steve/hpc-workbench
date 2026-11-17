import { describe, expect, it } from 'vitest'
import { parseQuota, parseSize } from '../../src/main/adapters/quota'
import { fixture } from '../fixtures'

const G = 1024 ** 3
const T = 1024 ** 4

describe('parseQuota（真实夹具）', () => {
  const result = parseQuota(fixture('mmlsquota.txt'))

  it('解析出容量与文件数两个维度', () => {
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.data).toHaveLength(1)
    const quota = result.data[0]!
    expect(quota.filesystem).toBe('gpfs01')
    expect(quota.type).toBe('USR')
  })

  it('容量维度按字节解析，带单位后缀', () => {
    if (!result.ok) return
    const bytes = result.data[0]!.bytes

    expect(bytes.used).toBe(Math.round(90.7 * G))
    expect(bytes.soft).toBe(6 * T)
    expect(bytes.hard).toBe(9 * T)
    expect(bytes.inDoubt).toBe(Math.round(1.428 * G))
    expect(bytes.grace).toBe('none')
  })

  it('文件数维度是裸整数，不能套容量那一套单位规则', () => {
    if (!result.ok) return
    const files = result.data[0]!.files

    expect(files.used).toBe(371344)
    expect(files.soft).toBe(6291456)
    expect(files.hard).toBe(9437184)
    expect(files.inDoubt).toBe(89)
  })

  it('表头行不会被当成数据', () => {
    if (!result.ok) return
    expect(result.data.some((q) => /filesystem/i.test(q.filesystem))).toBe(false)
  })
})

describe('parseQuota（边界）', () => {
  const header = [
    '                         Block Limits                                    |     File Limits',
    'Filesystem type         blocks      quota      limit   in_doubt    grace |    files   quota    limit in_doubt    grace  Remarks'
  ]

  it('grace 变成 "7 days" 时（两个 token）也能正确切分', () => {
    const line = 'gpfs01     USR          90.7G         6T         9T     1.428G     none |   371344 6291456  9437184       89     7 days'
    const result = parseQuota([...header, line].join('\n'))

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data[0]!.files.grace).toBe('7 days')
  })

  it('grace 变成 expired 时原样保留', () => {
    const line = 'gpfs01     USR          90.7G         6T         9T     1.428G     none |   371344 6291456  9437184       89     expired'
    const result = parseQuota([...header, line].join('\n'))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data[0]!.files.grace).toBe('expired')
  })

  it('quota 为 none 时解析成 null，不是 0', () => {
    const line = 'gpfs01     USR          90.7G      none      none     1.428G     none |   371344    none     none       89     none'
    const result = parseQuota([...header, line].join('\n'))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data[0]!.bytes.soft).toBeNull()
      expect(result.data[0]!.bytes.hard).toBeNull()
      expect(result.data[0]!.files.soft).toBeNull()
    }
  })

  it('多行（多个文件系统）逐行解析，不只取第一行', () => {
    const l1 = 'gpfs01     USR          90.7G         6T         9T     1.428G     none |   371344 6291456  9437184       89     none'
    const l2 = 'gpfs02     USR           1.2G         2T         3T          0     none |      120 1048576  2097152        0     none'
    const result = parseQuota([...header, l1, l2].join('\n'))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data).toHaveLength(2)
      expect(result.data[1]!.filesystem).toBe('gpfs02')
      expect(result.data[1]!.files.used).toBe(120)
    }
  })

  it('Remarks 非空时不弄脏 grace', () => {
    const line = 'gpfs01     USR          90.7G         6T         9T     1.428G     none |   371344 6291456  9437184       89     none  over-quota-soon'
    const result = parseQuota([...header, line].join('\n'))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data[0]!.files.grace).toBe('none')
      expect(result.data[0]!.remarks).toBe('over-quota-soon')
    }
  })

  it('命令没输出时失败（多半是路径或权限问题）', () => {
    const result = parseQuota('')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('没有输出')
  })

  it('只有表头没有数据行时失败，不返回空数组', () => {
    const result = parseQuota(header.join('\n'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('没有找到')
  })

  it('数据行数字坏掉时失败，保留原文', () => {
    const line = 'gpfs01     USR          ???          6T         9T     1.428G     none |   371344 6291456  9437184       89     none'
    const raw = [...header, line].join('\n')
    const result = parseQuota(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.raw).toBe(raw)
  })
})

describe('parseSize', () => {
  it('各种后缀', () => {
    expect(parseSize('1K')).toBe(1024)
    expect(parseSize('1M')).toBe(1024 ** 2)
    expect(parseSize('90.7G')).toBe(Math.round(90.7 * G))
    expect(parseSize('6T')).toBe(6 * T)
    expect(parseSize('371344')).toBe(371344)
  })

  it('none / N/A / - 返回 null', () => {
    expect(parseSize('none')).toBeNull()
    expect(parseSize('N/A')).toBeNull()
    expect(parseSize('-')).toBeNull()
    expect(parseSize(undefined)).toBeNull()
  })
})
