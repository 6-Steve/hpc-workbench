import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseSacct, sacctCommand } from '../src/main/adapters/sacct'

const raw = readFileSync(join(__dirname, '..', 'fixtures', 'sacct.json'), 'utf8')

describe('sacctCommand', () => {
  it('不用 --me：这个版本不认（实测报 unrecognized option）', () => {
    expect(sacctCommand(7)).not.toContain('--me')
    expect(sacctCommand(7)).toContain('-u "$USER"')
    expect(sacctCommand(3)).toContain('now-3days')
  })
})

describe('parseSacct：历史作业', () => {
  it('解析出全部作业', () => {
    const result = parseSacct(raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data).toHaveLength(4)
  })

  it('state 是嵌套对象，要取 current', () => {
    const result = parseSacct(raw)
    if (!result.ok) throw new Error(result.reason)

    const failed = result.data.find((job) => job.id === '203248')
    expect(failed?.state).toBe('failed')
    expect(failed?.rawState).toBe('FAILED')
  })

  it('reason 是字符串 "None" 时当成没有原因', () => {
    const result = parseSacct(raw)
    if (!result.ok) throw new Error(result.reason)
    // 实测 sacct 会给 "None" 而不是 null，别把它当有意义的原因
    expect(result.data[0]?.stateReason).toBeNull()
  })

  it('从 time 里取时长和起止时间', () => {
    const result = parseSacct(raw)
    if (!result.ok) throw new Error(result.reason)

    const completed = result.data.find((job) => job.id === '195275')
    expect(completed?.elapsedSeconds).toBe(7260)
    expect(completed?.startTime).toBe(1792567269)
    expect(completed?.endTime).toBe(1792574529)
    expect(completed?.submitTime).toBe(1792567260)
  })

  it('未结束的作业 end 是 0，要转成 null', () => {
    const result = parseSacct(raw)
    if (!result.ok) throw new Error(result.reason)
    const running = result.data.find((job) => job.id === '205001')
    expect(running?.state).toBe('running')
    expect(running?.endTime).toBeNull()
  })

  it('从 tres.allocated 数组里取核数和卡数', () => {
    const result = parseSacct(raw)
    if (!result.ok) throw new Error(result.reason)

    const withGpu = result.data.find((job) => job.id === '195275')
    expect(withGpu?.cpus).toBe(16)
    expect(withGpu?.gpus).toBe(4)
    expect(withGpu?.nodeCount).toBe(2)

    const noGpu = result.data.find((job) => job.id === '203263')
    expect(noGpu?.gpus).toBeNull()
  })

  it('时限 infinite 时给 null，不是 0', () => {
    const result = parseSacct(raw)
    if (!result.ok) throw new Error(result.reason)
    expect(result.data.find((job) => job.id === '205001')?.timeLimitMinutes).toBeNull()
    expect(result.data.find((job) => job.id === '195275')?.timeLimitMinutes).toBe(180)
  })

  it('识别「状态失败但退出码是 0」这种误导情况', () => {
    const result = parseSacct(raw)
    if (!result.ok) throw new Error(result.reason)

    const failed = result.data.find((job) => job.id === '203248')
    expect(failed?.exitReturnCode).toBe(0)
    expect(failed?.exitStatus).toBe('SUCCESS')
    // 关键：界面得知道"别拿退出码当失败原因"
    expect(failed?.exitCodeMisleading).toBe(true)

    // 正常完成的作业不该被标成误导
    expect(result.data.find((job) => job.id === '195275')?.exitCodeMisleading).toBe(false)
  })

  it('空列表不算错误', () => {
    const empty = JSON.stringify({ meta: {}, jobs: [], warnings: [], errors: [] })
    const result = parseSacct(empty)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toEqual([])
  })

  it('空输出给出明确原因，不是笼统的"解析失败"', () => {
    const result = parseSacct('')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      // json.ts 已经把"空输出 / 不是 JSON / 被截断"分开了，别退化成笼统的一句话
      expect(result.reason).toContain('没有输出')
      // 契约要求失败必须带 raw（哪怕原文是空的，也要说明"为什么空"）
      expect(result.raw.length).toBeGreaterThan(0)
    }
  })

  it('不是 JSON 时保留原文', () => {
    const result = parseSacct('slurm_load_jobs error: Socket timed out')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.raw).toContain('Socket timed out')
  })
})

describe('workDir：定位日志用', () => {
  it('从 working_directory 取工作目录', () => {
    const result = parseSacct(raw)
    if (!result.ok) throw new Error(result.reason)

    // sacct 不提供 StdOut 字段，只能靠 workDir + 文件名约定去猜日志在哪
    expect(result.data.find((job) => job.id === '195275')?.workDir).toBe('/home/user01/projects/msq')
  })

  it('没有这个字段时给 null，不瞎编路径', () => {
    const withoutDir = JSON.stringify({
      meta: {},
      jobs: [{ job_id: 1, name: 'x', state: { current: 'COMPLETED' } }],
      warnings: [],
      errors: []
    })
    const result = parseSacct(withoutDir)
    if (!result.ok) throw new Error(result.reason)
    expect(result.data[0]?.workDir).toBeNull()
  })
})
