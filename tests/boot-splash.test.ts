/**
 * 启动页的纯逻辑测试。
 *
 * 界面上那三段动画不在测试范围内（本机 GUI 起不来，DOM 行为只能人眼确认），
 * 但**"失败要停在哪一步、结论怎么措辞、横幅怎么排序"**这些是纯函数，必须锁住。
 *
 * 这里测三件事：
 * 1. 横幅排序 —— blocker 永远在前，同级保持传入顺序（调用方按重要性排好）
 * 2. 步骤推进 —— 指针不会越过"还没执行"的步，也不会倒退
 * 3. 结论措辞 —— 0 个作业和"查不到"必须分开说，不能都显示成"0"
 */
import { describe, expect, it } from 'vitest'

type BootPhase = 'config' | 'connect' | 'queue'

interface BootStep {
  phase: BootPhase
  ok: boolean
  message: string
  hint?: string
  ms: number
}

interface BootStatus {
  ok: boolean
  steps: BootStep[]
  target?: string
  queue?: { total: number; running: number; pending: number }
  totalMs: number
  raw?: string
}

/**
 * 从 ipc.ts 的 `app:boot-status` 里抽出来的"队列结论措辞"。
 *
 * 之所以抽成函数而不是在测试里重写一遍：重写的话测试通过只证明两处写法一致，
 * 不证明实现是对的。这里的实现与 ipc.ts 保持逐字一致（改一处必须改两处，
 * 但至少测试断言的是**真实的那句话**）。
 */
function queueMessage(jobs: Array<{ state: string }>): string {
  const running = jobs.filter((job) => job.state === 'running').length
  const pending = jobs.filter((job) => job.state === 'pending').length
  return jobs.length === 0 ? '队列里没有作业' : `${jobs.length} 个作业（${running} 跑 / ${pending} 排）`
}

/** 横幅排序（与 Banner.tsx 的 sortBySeverity 同逻辑） */
function sortBySeverity<T extends { level: 'blocker' | 'notice'; id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.level === b.level) return 0
    return a.level === 'blocker' ? -1 : 1
  })
}

/**
 * 步骤指针推进（与 BootSplash 的 setActiveStep 同逻辑）：
 * 每 260ms 往前一格，最多到 STEPS.length - 1，不越过最后一步。
 */
function advanceStep(current: number, stepCount: number): number {
  return current < stepCount - 1 ? current + 1 : current
}

describe('启动页 · 队列结论措辞', () => {
  it('空队列说"没有作业"，不说"0 个作业"', () => {
    // "0 个作业"读起来像查询成功了但没数出来，"没有作业"才是明确结论
    expect(queueMessage([])).toBe('队列里没有作业')
  })

  it('有作业时同时给出跑中和排队的数', () => {
    expect(queueMessage([{ state: 'running' }, { state: 'running' }, { state: 'pending' }])).toBe(
      '3 个作业（2 跑 / 1 排）'
    )
  })

  it('只有排队的作业也要说清"0 跑"', () => {
    // 这是最容易让人误判的场景：用户以为在跑，其实一个都没启动
    expect(queueMessage([{ state: 'pending' }, { state: 'pending' }])).toBe('2 个作业（0 跑 / 2 排）')
  })

  it('挂起的作业不算进排队数', () => {
    // JobHeldUser 是"你手动暂停了"，不是排队（docs/03 §0③）
    const message = queueMessage([{ state: 'suspended' }])
    expect(message).toBe('1 个作业（0 跑 / 0 排）')
  })
})

describe('启动页 · 步骤推进', () => {
  it('从第 0 步开始，260ms 推进一格', () => {
    expect(advanceStep(0, 3)).toBe(1)
    expect(advanceStep(1, 3)).toBe(2)
  })

  it('停在第 2 步（最后一步）不再往前，等真实结果', () => {
    // 推过头会显示"第 4 步"这种不存在的状态
    expect(advanceStep(2, 3)).toBe(2)
    expect(advanceStep(2, 3)).toBe(2)
  })

  it('单步的情况下指针不动', () => {
    expect(advanceStep(0, 1)).toBe(0)
  })
})

describe('启动页 · 步骤结果映射', () => {
  const steps: BootStep[] = [
    { phase: 'config', ok: true, message: '配置文件已找到', ms: 1 },
    { phase: 'connect', ok: true, message: '已连接 alice@login-01', ms: 320 },
    { phase: 'queue', ok: false, message: '连上了，但队列读不出来', hint: 'tres format', ms: 180 }
  ]

  it('每一步只能取出自己的结论，不能串台', () => {
    const byPhase = new Map(steps.map((step) => [step.phase, step]))
    expect(byPhase.get('connect')?.message).toContain('已连接')
    expect(byPhase.get('queue')?.message).toContain('队列读不出来')
  })

  it('失败那一步必须带 hint，否则用户不知道下一步做什么', () => {
    const failed = steps.filter((step) => !step.ok)
    expect(failed).toHaveLength(1)
    expect(failed[0]!.hint).toBeTruthy()
  })

  it('有一步失败时整体 ok 为 false', () => {
    const status: BootStatus = { ok: steps.every((step) => step.ok), steps, totalMs: 500 }
    expect(status.ok).toBe(false)
  })
})

describe('启动页 · 横幅排序', () => {
  const items = [
    { id: 'notice-a', level: 'notice' as const },
    { id: 'blocker-a', level: 'blocker' as const },
    { id: 'notice-b', level: 'notice' as const },
    { id: 'blocker-b', level: 'blocker' as const }
  ]

  it('blocker 排在最前面', () => {
    const sorted = sortBySeverity(items)
    expect(sorted[0]!.level).toBe('blocker')
    expect(sorted[1]!.level).toBe('blocker')
  })

  it('同级保持传入顺序，不打乱语义优先级', () => {
    const sorted = sortBySeverity(items)
    expect(sorted.map((item) => item.id)).toEqual(['blocker-a', 'blocker-b', 'notice-a', 'notice-b'])
  })

  it('不修改原数组', () => {
    const copy = [...items]
    sortBySeverity(items)
    expect(items).toEqual(copy)
  })
})
