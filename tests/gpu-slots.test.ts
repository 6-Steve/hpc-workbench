/**
 * 卡位矩阵的推导规则。
 *
 * 这三条规则每一条写错都会**在界面上骗人**：
 * 把 drain 的机器画成空闲、把 ALLOCATED 当成没卡、或者多型号摊错数量。
 * 界面层的 if 是钉不住的，所以钉在纯函数上。
 */
import { describe, expect, it } from 'vitest'
import { slotSummary, slotsOf, type SlotNode } from '../src/shared/gpu-slots'

function node(patch: Partial<SlotNode> = {}): SlotNode {
  return {
    blocked: false,
    gpus: [{ type: 'A100', count: 8 }],
    gpusUsed: [],
    ...patch
  }
}

const count = (slots: string[], state: string): number => slots.filter((slot) => slot === state).length

describe('slotsOf · 基本', () => {
  it('8 卡没作业 → 8 个空闲', () => {
    const slots = slotsOf(node(), 'A100')
    expect(slots).toHaveLength(8)
    expect(count(slots, 'free')).toBe(8)
  })

  it('用了 3 张 → 3 占用 + 5 空闲，顺序是先占用后空闲', () => {
    const slots = slotsOf(node({ gpusUsed: [{ type: 'A100', count: 3 }] }), 'A100')
    expect(slots.slice(0, 3)).toEqual(['used', 'used', 'used'])
    expect(slots.slice(3)).toEqual(['free', 'free', 'free', 'free', 'free'])
  })

  it('用满 → 全占用，没有空闲', () => {
    const slots = slotsOf(node({ gpusUsed: [{ type: 'A100', count: 8 }] }), 'A100')
    expect(count(slots, 'free')).toBe(0)
    expect(slots).toHaveLength(8)
  })
})

describe('slotsOf · 三条容易写反的规则', () => {
  /*
   * 规则 1：blocked 的机器哪怕一张都没用，也不能显示空闲。
   * 写错的后果是用户点了提交、调度器不派活，然后以为是应用坏了。
   */
  it('blocked 机器即使 gpusUsed 为空也全标不可用', () => {
    const slots = slotsOf(node({ blocked: true }), 'A100')
    expect(slots).toHaveLength(8)
    expect(count(slots, 'blocked')).toBe(8)
    expect(count(slots, 'free')).toBe(0)
  })

  /*
   * 规则 2：有作业 ≠ 没卡。ALLOCATED 的机器仍有空卡，
   * 判断依据只能是「总卡 − 已用」，绝不能看状态名。
   * （这个函数拿不到 state，正是刻意的——从类型上就不给你犯错的机会。）
   */
  it('部分占用时仍算出空闲卡', () => {
    const slots = slotsOf(node({ gpusUsed: [{ type: 'A100', count: 2 }] }), 'A100')
    expect(count(slots, 'free')).toBe(6)
  })

  /*
   * 规则 3：多型号按型号分别算，不能先合总数再摊。
   * 写错的后果是"V100 显示 8 张空闲"——A100 的数量漏到了 V100 上。
   */
  it('多型号互不串味', () => {
    const mixed = node({
      gpus: [
        { type: 'A100', count: 4 },
        { type: 'V100', count: 4 }
      ],
      gpusUsed: [{ type: 'A100', count: 4 }]
    })
    expect(count(slotsOf(mixed, 'A100'), 'free')).toBe(0)
    expect(count(slotsOf(mixed, 'V100'), 'free')).toBe(4)
    expect(slotsOf(mixed, 'V100')).toHaveLength(4)
  })
})

describe('slotsOf · 脏数据', () => {
  it('不存在的型号 → 空数组（不抛）', () => {
    expect(slotsOf(node(), 'H100')).toEqual([])
  })

  it('used 大于 total（统计不同步）→ 全占用，不出现负数个格子', () => {
    const slots = slotsOf(node({ gpusUsed: [{ type: 'A100', count: 20 }] }), 'A100')
    expect(slots).toHaveLength(8)
    expect(count(slots, 'free')).toBe(0)
  })

  it('count 为 0 → 不画格', () => {
    expect(slotsOf(node({ gpus: [{ type: 'A100', count: 0 }] }), 'A100')).toEqual([])
  })

  it('负数 count 夹到 0', () => {
    expect(slotsOf(node({ gpus: [{ type: 'A100', count: -3 }] }), 'A100')).toEqual([])
  })
})

describe('slotSummary · 卡片头汇总', () => {
  it('两台机器相加，blocked 的卡算进总数但不算空闲', () => {
    const nodes = [
      node({ gpusUsed: [{ type: 'A100', count: 3 }] }),
      node({ blocked: true })
    ]
    expect(slotSummary(nodes, 'A100')).toEqual({ total: 16, free: 5 })
  })

  it('空列表 → 0 / 0（不除零）', () => {
    expect(slotSummary([], 'A100')).toEqual({ total: 0, free: 0 })
  })

  it('与逐节点相加一致', () => {
    const nodes = [node(), node({ gpusUsed: [{ type: 'A100', count: 8 }] })]
    const expected = nodes.reduce((sum, item) => sum + slotsOf(item, 'A100').length, 0)
    expect(slotSummary(nodes, 'A100').total).toBe(expected)
  })
})
