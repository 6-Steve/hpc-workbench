/**
 * 作业分组。
 *
 * 重点不是"能分组"，而是：**同批要真的同批、不同批不能混、组 id 要稳定**。
 * 前两条错了会让用户按错误的分组做判断，第三条错了组会在每次刷新时上下跳。
 */
import { describe, expect, it } from 'vitest'
import {
  GROUP_WINDOW_MINUTES,
  describeGroup,
  groupIndex,
  groupJobs,
  type GroupableJob
} from '../src/renderer/src/lib/job-groups'

const T0 = 1_700_000_000_000

const job = (over: Partial<GroupableJob> = {}): GroupableJob => ({
  id: '1001',
  name: 'eval',
  partition: 'gpu',
  state: 'pending',
  submitTime: T0,
  ...over
})

const at = (minutes: number): number => T0 + minutes * 60_000

describe('groupJobs · 合并规则', () => {
  it('同名同分区、间隔 1 分钟 → 合成一组', () => {
    const groups = groupJobs(
      [job({ id: '1001' }), job({ id: '1002', submitTime: at(1) })],
      { enabled: true }
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]!.jobs).toHaveLength(2)
  })

  it('超出时间窗 → 不合并（同名但不同批）', () => {
    const groups = groupJobs(
      [job({ id: '1001' }), job({ id: '1002', submitTime: at(GROUP_WINDOW_MINUTES + 1) })],
      { enabled: true }
    )
    expect(groups).toHaveLength(2)
  })

  it('同名但不同分区 → 不合并', () => {
    const groups = groupJobs(
      [job({ id: '1001' }), job({ id: '1002', partition: 'cpu', submitTime: at(1) })],
      { enabled: true }
    )
    expect(groups).toHaveLength(2)
  })

  it('不同名 → 不合并', () => {
    const groups = groupJobs(
      [job({ id: '1001' }), job({ id: '1002', name: 'train', submitTime: at(1) })],
      { enabled: true }
    )
    expect(groups).toHaveLength(2)
  })

  it('关闭时每个作业各成一组', () => {
    const groups = groupJobs([job({ id: '1001' }), job({ id: '1002' })], { enabled: false })
    expect(groups).toHaveLength(2)
    expect(groups.every((group) => group.jobs.length === 1)).toBe(true)
  })

  it('没有提交时间也能分组（不抛，排到最后）', () => {
    const groups = groupJobs([job({ id: '1001', submitTime: null }), job({ id: '1002' })], {
      enabled: true
    })
    expect(groups.reduce((sum, group) => sum + group.jobs.length, 0)).toBe(2)
  })
})

describe('groupJobs · 计数', () => {
  it('四类状态分别计数，取消不算失败', () => {
    const groups = groupJobs(
      [
        job({ id: '1', state: 'completed' }),
        job({ id: '2', state: 'cancelled' }),
        job({ id: '3', state: 'failed' }),
        job({ id: '4', state: 'running' }),
        job({ id: '5', state: 'pending' })
      ],
      { enabled: true }
    )
    expect(groups[0]!.counts).toEqual({ total: 5, running: 1, pending: 1, done: 2, failed: 1 })
  })
})

describe('groupJobs · 稳定性', () => {
  /*
   * 队列每 20 秒刷新一次。如果组 id 带随机数，组会在列表里上下跳，
   * 用户点开的那一组下一秒可能就变成另一组了。
   */
  it('同一批数据两次分组得到同样的 id', () => {
    const jobs = [job({ id: '1001' }), job({ id: '1002', submitTime: at(2) })]
    const a = groupJobs(jobs, { enabled: true })
    const b = groupJobs([...jobs].reverse(), { enabled: true })
    expect(a[0]!.id).toBe(b[0]!.id)
  })

  it('新作业进来时，老组 id 不变', () => {
    const before = groupJobs([job({ id: '1001' })], { enabled: true })
    const after = groupJobs([job({ id: '1001' }), job({ id: '1002', submitTime: at(1) })], {
      enabled: true
    })
    expect(after[0]!.id).toBe(before[0]!.id)
  })
})

describe('groupIndex', () => {
  it('标出每组第一个（组头只画一次）', () => {
    const groups = groupJobs(
      [job({ id: '1001' }), job({ id: '1002', submitTime: at(1) })],
      { enabled: true }
    )
    const index = groupIndex(groups)
    expect(index.get('1001')!.isFirst).toBe(true)
    expect(index.get('1002')!.isFirst).toBe(false)
    expect(index.get('1002')!.group.jobs).toHaveLength(2)
  })
})

describe('describeGroup', () => {
  it('只报非零项，失败排前面', () => {
    const groups = groupJobs(
      [
        job({ id: '1', state: 'completed' }),
        job({ id: '2', state: 'failed' }),
        job({ id: '3', state: 'running' })
      ],
      { enabled: true }
    )
    expect(describeGroup(groups[0]!)).toBe('1/3 完成 · 1 失败 · 1 运行中')
  })

  it('全部排队时只说排队', () => {
    const groups = groupJobs([job({ id: '1' }), job({ id: '2' })], { enabled: true })
    expect(describeGroup(groups[0]!)).toBe('0/2 完成 · 2 排队')
  })
})
