/**
 * `scontrol show job --json` 解析。
 *
 * 夹具是真实输出（已脱敏），故意保留了一个关键细节：输出文件叫
 * `demo-train-203815.log`——**`.log` 不是 `.out`**。
 * 这就是"必须用 standard_output、不能拿作业名猜文件名"的现实依据。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseScontrolJob, scontrolJobCommand } from '../../src/main/adapters/scontrol-job'

const fixture = readFileSync(join(__dirname, '../../fixtures/scontrol-job.json'), 'utf8')

describe('parseScontrolJob', () => {
  it('解出运行中作业的精确输出路径', () => {
    const result = parseScontrolJob(fixture)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // 路径必须是精确值，不能是猜出来的
    expect(result.data.stdoutPath).toBe('/home/user01/projects/models/demo-project/demo-train-203815.log')
    expect(result.data.workDir).toBe('/home/user01/projects/models/demo-project')
    expect(result.data.command).toBe('/home/user01/projects/models/demo-project/train_all.sh')
  })

  it('job_id 是数字，必须转成字符串', () => {
    const result = parseScontrolJob(fixture)
    if (!result.ok) throw new Error('应能解析')
    expect(result.data.id).toBe('203815')
    expect(typeof result.data.id).toBe('string')
  })

  it('数值字段走 {set,infinite,number}，时间字段是裸 epoch 秒', () => {
    const result = parseScontrolJob(fixture)
    if (!result.ok) throw new Error('应能解析')

    expect(result.data.cpus).toBe(16)
    expect(result.data.nodeCount).toBe(1)
    expect(result.data.memoryMb).toBe(65536)
    expect(result.data.timeLimitMinutes).toBe(4320)
    // 时间是裸数字：1793467306 秒（2026-11-01 前后），不是 {set:..} 包装
    expect(result.data.startTime).toBe(1793467306)
    expect(result.data.submitTime).toBe(1793445816)
    expect(result.data.endTime).toBe(1793726506)
  })

  it('GPU 数取 gres/gpu 总数，不把按型号那项再加一遍', () => {
    const result = parseScontrolJob(fixture)
    if (!result.ok) throw new Error('应能解析')

    // tres_alloc_str 同时有 gres/gpu=2 和 gres/gpu:a100-sxm4-80gb=2，总数是 2 不是 4
    expect(result.data.gpus).toBe(2)
    expect(result.data.gpuDetail).toEqual(['gpu:a100-sxm4-80gb:2(IDX:4-5)'])
  })

  it('state_reason 是字符串 "None" 时归一成 null', () => {
    const result = parseScontrolJob(fixture)
    if (!result.ok) throw new Error('应能解析')
    expect(result.data.stateReason).toBeNull()
    expect(result.data.state).toBe('running')
  })

  it('作业被控制器清理时返回失败，不能返回空数据冒充成功', () => {
    // 真实输出：exit 0，jobs 为空，warnings 里说 Zero jobs to dump
    const purged = JSON.stringify({
      meta: { plugin: 'data_parser/v0.0.40' },
      jobs: [],
      warnings: [{ description: 'Zero jobs to dump', data_type: '0x83' }],
      errors: []
    })

    const result = parseScontrolJob(purged)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('清理')
    // raw 必须保留，否则界面上没法展开看原始输出
    expect(result.raw).toContain('Zero jobs to dump')
  })

  it('调度器返回 errors 时如实报错', () => {
    const withError = JSON.stringify({
      meta: {},
      jobs: [],
      warnings: [],
      errors: [{ description: 'Invalid job id specified', error_code: 1 }]
    })

    const result = parseScontrolJob(withError)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('Invalid job id specified')
  })

  it('空输出和非 JSON 输出各有各的说法', () => {
    const empty = parseScontrolJob('   ')
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.reason).toContain('没有输出')

    const notJson = parseScontrolJob('slurm_load_jobs error: Socket timed out on send/recv operation')
    expect(notJson.ok).toBe(false)
    if (!notJson.ok) expect(notJson.reason).toContain('不是 JSON')
  })

  it('相对的输出路径按工作目录补全', () => {
    const relative = JSON.stringify({
      meta: {},
      jobs: [
        {
          job_id: 100,
          name: 'rel',
          job_state: 'PENDING',
          current_working_directory: '/home/user01/work',
          standard_output: 'logs/out.log',
          errors: []
        }
      ],
      warnings: [],
      errors: []
    })

    const result = parseScontrolJob(relative)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.stdoutPath).toBe('/home/user01/work/logs/out.log')
  })

  it('排队作业的 nodes 占位符不是真节点名', () => {
    const pending = JSON.stringify({
      meta: {},
      jobs: [
        {
          job_id: 101,
          name: 'queued',
          job_state: 'PENDING',
          nodes: '(null)',
          state_reason: 'Priority',
          tres_req_str: 'cpu=4,mem=16G,node=1,gres/gpu=1',
          tres_alloc_str: '',
          errors: []
        }
      ],
      warnings: [],
      errors: []
    })

    const result = parseScontrolJob(pending)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.nodes).toBeNull()
    // 排队时只有申请值，要能从 tres_req_str 拿到卡数
    expect(result.data.gpus).toBe(1)
    expect(result.data.stateReasonText).not.toBe('')
  })
})

describe('scontrolJobCommand', () => {
  it('拼出询问单条作业的命令', () => {
    expect(scontrolJobCommand('203815')).toBe('scontrol show job 203815 --json')
  })
})
