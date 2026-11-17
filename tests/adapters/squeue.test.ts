import { describe, expect, it } from 'vitest'
import { parseSqueue } from '../../src/main/adapters/squeue'
import { fixture } from '../fixtures'

function parseFixture() {
  const result = parseSqueue(fixture('squeue.json'))
  if (!result.ok) throw new Error(`夹具解析失败：${result.reason}`)
  return result.data
}

describe('parseSqueue（真实夹具）', () => {
  const jobs = parseFixture()

  it('解析出作业，且 state 与 reason 是独立字段', () => {
    expect(jobs).toHaveLength(1)
    const job = jobs[0]!
    expect(job.id).toBe('185046')
    expect(job.state).toBe('pending')
    expect(job.rawState).toBe('PENDING')
    expect(job.reason).toBe('JobHeldUser')
  })

  it('JobHeldUser 必须被识别为"用户自己挂起"，不能显示成普通排队', () => {
    const job = jobs[0]!
    expect(job.heldByUser).toBe(true)
    expect(job.reasonText).toContain('已挂起')
    expect(job.reasonText).not.toContain('空闲资源')
  })

  it('{} 包装的数值字段正确解包', () => {
    const job = jobs[0]!
    expect(job.nodeCount).toBe(2)
    expect(job.cpus).toBe(8)
    expect(job.timeLimitMinutes).toBe(2880)
  })

  it('从 tres_req_str 里抠出申请的 GPU 张数', () => {
    expect(jobs[0]!.gpusRequested).toBe(4)
  })

  it('排队中的作业没有节点名', () => {
    expect(jobs[0]!.nodes).toBeNull()
  })

  it('时间字段是 Unix 秒，未开始时为 0', () => {
    expect(jobs[0]!.startTime).toBe(0)
    expect(jobs[0]!.submitTime).toBeGreaterThan(1_700_000_000)
  })
})

describe('parseSqueue（边界）', () => {
  it('空队列是正常状态，返回空数组而不是错误', () => {
    const result = parseSqueue(JSON.stringify({ jobs: [], errors: [] }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toEqual([])
  })

  it('time_limit 为无限时返回 null', () => {
    const result = parseSqueue(
      JSON.stringify({
        jobs: [{ job_id: 1, name: 'x', job_state: 'RUNNING', time_limit: { set: true, infinite: true, number: 0 } }],
        errors: []
      })
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data[0]!.timeLimitMinutes).toBeNull()
  })

  it('没有 GPU 申请记录时 gpusRequested 为 null（不是 0）', () => {
    const result = parseSqueue(
      JSON.stringify({
        jobs: [{ job_id: 2, name: 'y', job_state: 'RUNNING', tres_req_str: 'cpu=4,mem=8G' }],
        errors: []
      })
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data[0]!.gpusRequested).toBeNull()
  })

  it('运行中的作业优先排在前面', () => {
    const result = parseSqueue(
      JSON.stringify({
        jobs: [
          { job_id: 10, name: 'pending-one', job_state: 'PENDING', state_reason: 'Resources' },
          { job_id: 9, name: 'running-one', job_state: 'RUNNING', nodes: 'node01' }
        ],
        errors: []
      })
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data[0]!.state).toBe('running')
      expect(result.data[0]!.nodes).toBe('node01')
    }
  })

  it('缺 job_id 的作业让整次解析失败，而不是悄悄跳过', () => {
    const result = parseSqueue(JSON.stringify({ jobs: [{ name: 'no-id' }], errors: [] }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('job_id')
  })

  it('非 JSON 输入失败且保留原文', () => {
    const raw = 'slurm_load_jobs error: Socket timed out on send/recv operation'
    const result = parseSqueue(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.raw).toBe(raw)
  })
})
