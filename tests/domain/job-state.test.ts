import { describe, expect, it } from 'vitest'
import { describeReason, isHeldByUser, normalizeJobState } from '../../src/main/domain/job-state'

describe('normalizeJobState', () => {
  it('SLURM 的全大写下划线写法', () => {
    expect(normalizeJobState('PENDING')).toBe('pending')
    expect(normalizeJobState('RUNNING')).toBe('running')
    expect(normalizeJobState('CANCELLED')).toBe('cancelled')
    expect(normalizeJobState('NODE_FAIL')).toBe('node-fail')
    expect(normalizeJobState('OUT_OF_MEMORY')).toBe('out-of-memory')
  })

  it('容忍前后空白与大小写混写', () => {
    expect(normalizeJobState('  Running ')).toBe('running')
  })

  it('认不出的状态归到 unknown', () => {
    expect(normalizeJobState('WAT')).toBe('unknown')
    expect(normalizeJobState('')).toBe('unknown')
  })
})

describe('describeReason', () => {
  it('JobHeldUser 必须和资源不足区分开', () => {
    const held = describeReason('JobHeldUser')
    const resources = describeReason('Resources')

    expect(held.text).toContain('已挂起')
    expect(held.action).toBe('一键恢复')
    expect(resources.text).toContain('空闲资源')
    expect(resources.text).not.toContain('挂起')
  })

  it('Priority 只能等，没有可操作项', () => {
    const reason = describeReason('Priority')
    expect(reason.text).toContain('优先级')
    expect(reason.action).toBeNull()
  })

  it('PartitionTimeLimit 指向"改时长"', () => {
    expect(describeReason('PartitionTimeLimit').action).toContain('时长')
  })

  it('认不出的原因原样显示，不吞掉调度器的说法', () => {
    const reason = describeReason('SomeNewReason2027')
    expect(reason.text).toContain('SomeNewReason2027')
  })

  it('没有原因时给"等待调度"而不是报错', () => {
    expect(describeReason(null).text).toBe('等待调度')
    expect(describeReason('').text).toBe('等待调度')
  })
})

describe('isHeldByUser', () => {
  it('只有 JobHeldUser 算"用户自己挂起"', () => {
    expect(isHeldByUser('JobHeldUser')).toBe(true)
    expect(isHeldByUser('Resources')).toBe(false)
    expect(isHeldByUser(null)).toBe(false)
  })
})
