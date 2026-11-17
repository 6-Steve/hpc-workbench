import { describe, expect, it } from 'vitest'
import { freeByType, parseGres, totalGpus } from '../../src/main/adapters/gres'

describe('parseGres', () => {
  it('丢弃 socket 后缀，只取型号与数量', () => {
    expect(parseGres('gpu:nvidia_h100_80gb_hbm3:2(S:1)')).toEqual([
      { type: 'nvidia_h100_80gb_hbm3', count: 2 }
    ])
    expect(parseGres('gpu:nvidia_a800_80gb_pcie:2(S:0)')).toEqual([
      { type: 'nvidia_a800_80gb_pcie', count: 2 }
    ])
  })

  it('单节点多机型：拆成两条，型号名里的 - 和 _ 都保留', () => {
    const result = parseGres('gpu:tesla_v100s-pcie-32gb:3(S:0),gpu:tesla_v100-sxm2-32gb:2(S:1)')
    expect(result).toEqual([
      { type: 'tesla_v100s-pcie-32gb', count: 3 },
      { type: 'tesla_v100-sxm2-32gb', count: 2 }
    ])
  })

  it('gres_used 的 (IDX:...) 与 (S:...) 同样能解析，但数量含义是"已用"', () => {
    expect(parseGres('gpu:tesla_v100s-pcie-32gb:1(IDX:0)')).toEqual([
      { type: 'tesla_v100s-pcie-32gb', count: 1 }
    ])
    // 一张都没用时的写法
    expect(parseGres('gpu:nvidia_a100_80gb_pcie:0(IDX:N/A)')).toEqual([
      { type: 'nvidia_a100_80gb_pcie', count: 0 }
    ])
  })

  it('空值 / N/A / 无 gpu 前缀一律返回空数组，不抛异常', () => {
    expect(parseGres('')).toEqual([])
    expect(parseGres(null)).toEqual([])
    expect(parseGres(undefined)).toEqual([])
    expect(parseGres('N/A')).toEqual([])
    expect(parseGres('(null)')).toEqual([])
  })

  it('同型号重复出现会合并求和', () => {
    expect(parseGres('gpu:a:2(S:0),gpu:a:3(S:1)')).toEqual([{ type: 'a', count: 5 }])
  })

  it('连续调用不会因为正则 lastIndex 残留而漏匹配', () => {
    const input = 'gpu:a:1(S:0)'
    expect(parseGres(input)).toEqual([{ type: 'a', count: 1 }])
    expect(parseGres(input)).toEqual([{ type: 'a', count: 1 }])
  })
})

describe('totalGpus / freeByType', () => {
  it('总卡数是各型号求和', () => {
    expect(totalGpus([{ type: 'a', count: 3 }, { type: 'b', count: 2 }])).toBe(5)
  })

  it('空闲必须按型号分别减，不能先合总数再摊', () => {
    // 实测 node13：3 张 v100s + 2 张 v100-32sxm，其中 v100s 用了 1 张、v100 用满
    const total = [
      { type: 'tesla_v100s-pcie-32gb', count: 3 },
      { type: 'tesla_v100-sxm2-32gb', count: 2 }
    ]
    const used = [
      { type: 'tesla_v100s-pcie-32gb', count: 1 },
      { type: 'tesla_v100-sxm2-32gb', count: 2 }
    ]

    expect(freeByType(total, used)).toEqual([
      { type: 'tesla_v100s-pcie-32gb', count: 2 },
      { type: 'tesla_v100-sxm2-32gb', count: 0 }
    ])

    // 若先算总数再平摊会得到"两种卡都还有货"，是错的
    expect(totalGpus(total) - totalGpus(used)).toBe(2)
  })

  it('已用超过总数时不会出现负数', () => {
    expect(freeByType([{ type: 'a', count: 1 }], [{ type: 'a', count: 3 }])).toEqual([{ type: 'a', count: 0 }])
  })

  it('没有已用记录时全部算空闲', () => {
    expect(freeByType([{ type: 'a', count: 4 }], [])).toEqual([{ type: 'a', count: 4 }])
  })
})
