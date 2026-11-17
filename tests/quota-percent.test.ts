/**
 * 配额百分比。
 *
 * 关键点：按**软限**算（提醒线），没设软限才看硬限，两个都没设就是 null——
 * 绝不能返回 0 或 100，那会在标题栏显示成"存储 0%"或"存储 100%"。
 */
import { describe, expect, it } from 'vitest'
import { quotaUsagePercent } from '../src/renderer/src/lib/format'

/** 用 Parameters 取参数类型，省得在这里重复写一遍结构（全局 Quota 在 node 侧不可见） */
type QuotaLike = NonNullable<Parameters<typeof quotaUsagePercent>[0]>

function quotaWith(used: number, soft: number | null, hard: number | null): QuotaLike {
  return { bytes: { used, soft, hard } }
}

describe('quotaUsagePercent', () => {
  it('有软限时按软限算', () => {
    expect(quotaUsagePercent(quotaWith(500, 1000, 2000))).toBe(50)
  })

  it('没软限才看硬限', () => {
    expect(quotaUsagePercent(quotaWith(500, null, 1000))).toBe(50)
  })

  it('两个限额都没设时返回 null，不编一个数出来', () => {
    expect(quotaUsagePercent(quotaWith(500, null, null))).toBeNull()
  })

  it('没有配额数据时返回 null', () => {
    expect(quotaUsagePercent(null)).toBeNull()
    expect(quotaUsagePercent(undefined)).toBeNull()
  })

  it('限额为 0 时返回 null，不做除零', () => {
    expect(quotaUsagePercent(quotaWith(0, 0, 0))).toBeNull()
  })
})
