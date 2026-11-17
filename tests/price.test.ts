import { describe, expect, it } from 'vitest'
import { estimateCost, formatPoints, formatPrice, priceByType, type PriceInput } from '../src/renderer/src/lib/price'

function price(type: string, cost: number, host: string): PriceInput {
  return { host, type, cost }
}

describe('priceByType：同型号多台机器聚合', () => {
  it('同价时区间上下限相同', () => {
    const map = priceByType([price('v100', 4, 'gpu11'), price('v100', 4, 'gpu12')])
    expect(map.get('v100')).toEqual({ min: 4, max: 4, hostCount: 2, hosts: ['gpu11', 'gpu12'] })
  })

  it('不同机器不同价时给出区间，不能只挑一个', () => {
    // 只取第一行的价格会让用户以为都是 4 点，实际有台机器 6 点
    const map = priceByType([price('a100', 4, 'gpu01'), price('a100', 6, 'gpu02')])
    expect(map.get('a100')?.min).toBe(4)
    expect(map.get('a100')?.max).toBe(6)
  })

  it('多个型号互不干扰', () => {
    const map = priceByType([price('v100', 4, 'gpu11'), price('a100', 10, 'gpu09')])
    expect(map.size).toBe(2)
    expect(map.get('a100')?.min).toBe(10)
  })

  it('空列表返回空 Map，不报错', () => {
    expect(priceByType([]).size).toBe(0)
  })

  it('跳过非法单价', () => {
    const map = priceByType([price('bad', -1, 'x'), price('nan', Number.NaN, 'y'), price('ok', 5, 'z')])
    expect(map.size).toBe(1)
    expect(map.get('ok')?.min).toBe(5)
  })
})

describe('formatPrice', () => {
  it('统一价只显示一个数字', () => {
    expect(formatPrice({ min: 4, max: 4, hostCount: 2, hosts: [] })).toBe('4 点/小时')
  })

  it('区间价显示范围', () => {
    expect(formatPrice({ min: 4, max: 6, hostCount: 2, hosts: [] })).toBe('4–6 点/小时')
  })

  it('没有价格时给占位符', () => {
    expect(formatPrice(undefined)).toBe('—')
  })
})

describe('estimateCost：费用试算', () => {
  it('单价 × 卡数 × 小时', () => {
    const result = estimateCost(10, 4, 8)
    expect(result?.total).toBe(320)
  })

  it('小数单价也不失真', () => {
    expect(estimateCost(2.5, 2, 3)?.total).toBe(15)
  })

  it('参数非法返回 null，不能返回 0（0 会被当成免费）', () => {
    expect(estimateCost(null, 4, 8)).toBeNull()
    expect(estimateCost(undefined, 4, 8)).toBeNull()
    expect(estimateCost(10, 0, 8)).toBeNull()
    expect(estimateCost(10, 4, 0)).toBeNull()
    expect(estimateCost(10, -1, 8)).toBeNull()
    expect(estimateCost(10, 4, Number.NaN)).toBeNull()
  })

  it('卡数向下取整，不出现半张卡', () => {
    expect(estimateCost(10, 3.7, 1)?.gpus).toBe(3)
    expect(estimateCost(10, 3.7, 1)?.total).toBe(30)
  })
})

describe('formatPoints', () => {
  it('整数不带小数点', () => {
    expect(formatPoints(320)).toBe('320')
  })

  it('小数保留两位', () => {
    expect(formatPoints(15.5)).toBe('15.50')
  })

  it('非数字给占位符', () => {
    expect(formatPoints(Number.NaN)).toBe('—')
  })
})
