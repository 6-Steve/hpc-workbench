import { describe, expect, it } from 'vitest'
import {
  isBlocked,
  isSellable,
  nodeStateLabel,
  normalizeNodeState,
  normalizeNodeStates
} from '../../src/main/domain/node-state'

describe('normalizeNodeState', () => {
  it('sinfo 的小写与 scontrol 的全大写映射到同一个枚举', () => {
    expect(normalizeNodeState('idle')).toBe('idle')
    expect(normalizeNodeState('IDLE')).toBe('idle')
    expect(normalizeNodeState('mix')).toBe('mixed')
    expect(normalizeNodeState('MIXED')).toBe('mixed')
    expect(normalizeNodeState('alloc')).toBe('alloc')
    expect(normalizeNodeState('ALLOCATED')).toBe('alloc')
  })

  it('alloc 与 ALLOCATED 是词形差异，不是大小写差异', () => {
    // 单纯 toLowerCase() 得到 'allocated'，跟 'alloc' 对不上
    expect(normalizeNodeState('ALLOCATED')).toBe(normalizeNodeState('alloc'))
    expect('ALLOCATED'.toLowerCase()).not.toBe('alloc')
  })

  it('文本格式的复合状态 IDLE+DRAIN 取主干', () => {
    expect(normalizeNodeState('IDLE+DRAIN')).toBe('idle')
  })

  it('认不出的状态归到 unknown，而不是崩掉', () => {
    expect(normalizeNodeState('POWERED_DOWN')).toBe('unknown')
    expect(normalizeNodeState('')).toBe('unknown')
  })
})

describe('normalizeNodeStates', () => {
  it('保留全部状态并去重', () => {
    expect(normalizeNodeStates(['IDLE', 'DRAIN'])).toEqual(['idle', 'drain'])
    expect(normalizeNodeStates(['DOWN', 'DRAIN', 'NOT_RESPONDING'])).toEqual(['down', 'drain', 'unknown'])
  })

  it('复合串会拆开', () => {
    expect(normalizeNodeStates(['IDLE+DRAIN'])).toEqual(['idle', 'drain'])
  })

  it('空数组返回空数组', () => {
    expect(normalizeNodeStates([])).toEqual([])
  })
})

describe('isBlocked（scontrol 路径用）', () => {
  it('ALLOCATED 不算阻断——它照样有空闲卡', () => {
    expect(isBlocked(['alloc'])).toBe(false)
  })

  it('IDLE+DRAIN 必须阻断，哪怕它也含 IDLE', () => {
    expect(isBlocked(['idle', 'drain'])).toBe(true)
  })

  it('DOWN / NOT_RESPONDING 阻断', () => {
    expect(isBlocked(['down', 'drain', 'unknown'])).toBe(true)
  })

  it('状态为空时按阻断处理（宁可少卖，不可错卖）', () => {
    expect(isBlocked([])).toBe(true)
  })
})

describe('isSellable（sinfo 语义，与 isBlocked 的区别）', () => {
  it('ALLOCATED 在 sinfo 语义下不可售，在 scontrol 语义下可接单', () => {
    expect(isSellable(['alloc'])).toBe(false)
    expect(isBlocked(['alloc'])).toBe(false)
  })

  it('idle 与 mixed 都可售', () => {
    expect(isSellable(['idle'])).toBe(true)
    expect(isSellable(['mixed'])).toBe(true)
  })

  it('多状态时只要有不可售的就整台排除', () => {
    expect(isSellable(['idle', 'drain'])).toBe(false)
  })
})

describe('nodeStateLabel', () => {
  it('每种状态都有中文标签，未知也有兜底', () => {
    expect(nodeStateLabel('drain')).toBe('排空中')
    expect(nodeStateLabel('unknown')).toBe('未知')
  })
})
