/**
 * 日志路径定位。
 *
 * 这段逻辑的三条分支都是真机上踩出来的：
 * - scontrol 给精确路径（含 `.log` 这种猜不到的名字）
 * - 精确路径但文件还不存在（排队中 / 刚要跑）
 * - 作业被清理，退回 sacct + 命名约定
 *
 * 假 runner 按命令前缀返回，不碰网络。
 */
import { describe, expect, it } from 'vitest'
import { candidateLogPaths, resolveJobLogPath, type ShellRunner } from '../src/main/domain/job-log'

/** 造一个假 runner：按命令内容返回预设输出，并记录调用过的命令 */
function makeRunner(handler: (command: string) => string): ShellRunner & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async exec(command: string) {
      calls.push(command)
      return { stdout: handler(command), code: 0, stderr: '' }
    }
  }
}

const scontrolOk = (stdoutPath: string): string =>
  JSON.stringify({
    meta: {},
    jobs: [
      {
        job_id: 203815,
        name: 'demo-train',
        job_state: 'RUNNING',
        current_working_directory: '/home/user01/demo',
        standard_output: stdoutPath
      }
    ],
    warnings: [],
    errors: []
  })

describe('candidateLogPaths', () => {
  it('同时给 .out 和 .log 两种后缀', () => {
    const list = candidateLogPaths('/home/user01/demo', 'exp', '42')

    expect(list).toContain('/home/user01/demo/exp-42.out')
    expect(list).toContain('/home/user01/demo/exp-42.log')
  })

  it('工作目录带尾斜杠时不会拼出双斜杠', () => {
    for (const path of candidateLogPaths('/home/user01/demo/', 'exp', '42')) {
      expect(path.startsWith('/home/user01/demo/')).toBe(true)
      expect(path).not.toContain('//')
    }
  })
})

describe('resolveJobLogPath', () => {
  it('scontrol 有精确路径且文件存在时直接用它，不再去猜', async () => {
    // 注意这是 .log，且名字和作业名/id 的拼接规则对不上——正是猜不出来的那种
    const runner = makeRunner((command) =>
      command.includes('scontrol show job') ? scontrolOk('/data/out/qvit-all-203815.log') : '__YES__\n'
    )

    const result = await resolveJobLogPath(runner, '203815', {})
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.data).toEqual({ path: '/data/out/qvit-all-203815.log', source: 'scontrol', exists: true })
    // 只问了 scontrol + test -f 两条命令，没跑候选循环
    expect(runner.calls).toHaveLength(2)
    expect(runner.calls.some((c) => c.includes('for f in'))).toBe(false)
  })

  it('精确路径但文件还没出现时如实标 exists=false（排队中的作业）', async () => {
    const runner = makeRunner((command) =>
      command.includes('scontrol show job') ? scontrolOk('/home/user01/demo/exp-42.log') : '__NO__\n'
    )

    const result = await resolveJobLogPath(runner, '42', {})
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // 路径仍然是权威答案：跟随可以 `tail -F` 等它出现，不能转头去猜别的名字
    expect(result.data.exists).toBe(false)
    expect(result.data.source).toBe('scontrol')
  })

  it('scontrol 查不到（作业已清理）时退回命名约定', async () => {
    const runner = makeRunner((command) => {
      if (command.includes('scontrol show job')) {
        return JSON.stringify({ meta: {}, jobs: [], warnings: [{ description: 'Zero jobs to dump' }], errors: [] })
      }
      return '__FOUND__/home/user01/demo/slurm-42.log\n'
    })

    const result = await resolveJobLogPath(runner, '42', { jobName: 'exp', workDir: '/home/user01/demo' })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.data).toEqual({ path: '/home/user01/demo/slurm-42.log', source: 'sacct', exists: true })
  })

  it('scontrol 命令直接抛错也不致命，照样走兜底', async () => {
    const runner: ShellRunner = {
      async exec(command: string) {
        if (command.includes('scontrol show job')) throw new Error('command not found')
        return { stdout: '__FOUND__/home/user01/demo/exp-42.out\n', code: 0, stderr: '' }
      }
    }

    const result = await resolveJobLogPath(runner, '42', { jobName: 'exp', workDir: '/home/user01/demo' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.path).toBe('/home/user01/demo/exp-42.out')
  })

  it('两条路都不通时把试过的路径全列出来', async () => {
    const runner = makeRunner((command) => (command.includes('scontrol show job') ? '{"jobs":[]}' : '__NOT_FOUND__\n'))

    const result = await resolveJobLogPath(runner, '42', { jobName: 'exp', workDir: '/home/user01/demo' })
    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.reason).toContain('没找到')
    // 六个候选都要能被用户看到，否则他不知道该去文件页找什么
    expect(result.tried.length).toBeGreaterThanOrEqual(6)
    expect(result.raw).toContain('/home/user01/demo')
  })

  it('连工作目录都没有时给出"为什么查不到"而不是空列表', async () => {
    const runner = makeRunner(() => JSON.stringify({ jobs: [] }))

    const result = await resolveJobLogPath(runner, '42', { workDir: null })
    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.reason).toContain('查不到')
    expect(result.raw).toContain('jobId=42')
  })

  it('相对路径的工作目录不接受（远端要绝对路径）', async () => {
    const runner = makeRunner(() => JSON.stringify({ jobs: [] }))
    const result = await resolveJobLogPath(runner, '42', { workDir: 'demo' })
    expect(result.ok).toBe(false)
  })
})
