/**
 * 命令记录（命令台）。
 *
 * 分两层测：
 * - 纯函数与环形缓冲：截断、去重、淘汰、订阅隔离——这些决定了"会不会记错/记漏"。
 * - Session 挂钩：命令是我发出去的**唯一**出口，必须在那一处就挂上，
 *   而不是指望每个页面自觉上报；这里用假集群验证"成功 / 非 0 退出"都能被记到。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  commandSummary,
  formatClock,
  formatDuration,
  isFailed,
  MAX_FIELD_CHARS,
  previewOf,
  TRACE_PREVIEW_CHARS,
  type TraceInput
} from '../src/shared/trace'
import { TraceStore } from '../src/main/trace/store'
import { validateProfiles } from '../src/main/profiles'
import { KnownHostsStore } from '../src/main/ssh/known-hosts'
import { Session } from '../src/main/ssh/session'
import { createFakeCluster, type FakeCluster } from './helpers/fake-cluster'
import { makeTestKey } from './helpers/test-key'

function input(overrides: Partial<TraceInput> = {}): TraceInput {
  return {
    profileId: 'fake',
    host: 'login-01',
    command: 'squeue --me --json',
    at: 1_700_000_000_000,
    code: 0,
    durationMs: 128,
    stdout: '{"jobs":[]}',
    stderr: '',
    truncated: false,
    error: null,
    ...overrides
  }
}

describe('previewOf：预览与真实长度', () => {
  it('短文本原样返回，不算截断', () => {
    expect(previewOf('hello')).toEqual({ text: 'hello', chars: 5, clipped: false })
  })

  it('长文本按上限切，但 chars 报的是**原始**长度', () => {
    // 界面靠 chars 才能说清"共 12 万字，只显示了开头 4000"
    const long = 'x'.repeat(TRACE_PREVIEW_CHARS + 500)
    const preview = previewOf(long)
    expect(preview.text).toHaveLength(TRACE_PREVIEW_CHARS)
    expect(preview.chars).toBe(TRACE_PREVIEW_CHARS + 500)
    expect(preview.clipped).toBe(true)
  })

  it('刚好等于上限不算截断', () => {
    const exact = 'y'.repeat(TRACE_PREVIEW_CHARS)
    expect(previewOf(exact).clipped).toBe(false)
  })
})

describe('commandSummary：多行命令压成一行', () => {
  it('换行标成 ⏎，而不是简单抹平成空格', () => {
    // 抹平之后 sbatch 的 heredoc 会变成一长串看不出结构的字符
    expect(commandSummary('sbatch <<EOF\n#SBATCH -n 4\necho hi\nEOF')).toBe(
      'sbatch <<EOF ⏎ #SBATCH -n 4 ⏎ echo hi ⏎ EOF'
    )
  })

  it('空行丢掉，不产生连续的 ⏎', () => {
    expect(commandSummary('a\n\n\nb')).toBe('a ⏎ b')
  })

  it('超长截断并加省略号', () => {
    const summary = commandSummary('z'.repeat(400), 20)
    expect(summary).toHaveLength(21)
    expect(summary.endsWith('…')).toBe(true)
  })
})

describe('isFailed：什么算失败', () => {
  it('退出码 0 不算', () => {
    expect(isFailed({ code: 0, error: null })).toBe(false)
  })
  it('非 0 退出算', () => {
    expect(isFailed({ code: 2, error: null })).toBe(true)
  })
  it('连接层错误算，哪怕没有退出码', () => {
    expect(isFailed({ code: null, error: '通道已关闭' })).toBe(true)
  })
  it('code 为 null 但没有 error（被信号杀掉）不算"错误"，但也不是成功', () => {
    expect(isFailed({ code: null, error: null })).toBe(false)
  })
})

describe('时长与时钟格式', () => {
  it('小于一秒用毫秒，超过用秒', () => {
    expect(formatDuration(128)).toBe('128 ms')
    expect(formatDuration(1400)).toBe('1.4 s')
  })
  it('补零到 HH:MM:SS', () => {
    const at = new Date(2026, 10, 4, 9, 5, 3).getTime()
    expect(formatClock(at)).toBe('09:05:03')
  })
})

describe('TraceStore：环形缓冲', () => {
  it('按顺序编号，list 拿到同样的内容', () => {
    const store = new TraceStore()
    store.push(input({ command: 'a' }))
    store.push(input({ command: 'b' }))
    expect(store.list().map((entry) => entry.command)).toEqual(['a', 'b'])
    expect(store.list().map((entry) => entry.id)).toEqual([1, 2])
  })

  it('超过上限丢最旧的，不是丢最新的', () => {
    // 丢错方向等于"永远看不到刚发生的事"，是最坏的一种错
    const store = new TraceStore({ limit: 3 })
    for (const command of ['c1', 'c2', 'c3', 'c4', 'c5']) store.push(input({ command }))
    expect(store.list().map((entry) => entry.command)).toEqual(['c3', 'c4', 'c5'])
  })

  it('被淘汰的记录取不到 detail——不能返回一个看着像成功的空对象', () => {
    const store = new TraceStore({ limit: 1 })
    const first = store.push(input({ command: 'gone' }))
    store.push(input({ command: 'kept' }))
    expect(store.detail(first!.id)).toBeNull()
  })

  it('detail 带完整输出，列表只带预览', () => {
    const store = new TraceStore()
    const long = 'o'.repeat(TRACE_PREVIEW_CHARS + 100)
    const entry = store.push(input({ stdout: long }))!
    expect(entry.stdout).toHaveLength(TRACE_PREVIEW_CHARS)
    expect(entry.stdoutChars).toBe(TRACE_PREVIEW_CHARS + 100)
    const record = store.detail(entry.id)!
    expect(record.fullStdout).toHaveLength(TRACE_PREVIEW_CHARS + 100)
  })

  it('单条输出超过硬上限就丢，避免一条巨输出吃光内存', () => {
    const store = new TraceStore()
    const huge = 'h'.repeat(MAX_FIELD_CHARS * 3)
    const entry = store.push(input({ stdout: huge }))!
    // 报给界面的仍然是**真实**长度，用户才知道自己被截了
    expect(entry.stdoutChars).toBe(MAX_FIELD_CHARS * 3)
    expect(store.detail(entry.id)!.fullStdout).toHaveLength(MAX_FIELD_CHARS)
  })

  it('clear 之后列表为空，且编号继续往前走', () => {
    const store = new TraceStore()
    store.push(input())
    store.clear()
    expect(store.list()).toHaveLength(0)
    const next = store.push(input({ command: 'after' }))!
    expect(next.id).toBe(2)
  })

  it('新记录会推给订阅者', () => {
    const store = new TraceStore()
    const seen: string[] = []
    store.subscribe((entry) => seen.push(entry.command))
    store.push(input({ command: 'x' }))
    store.push(input({ command: 'y' }))
    expect(seen).toEqual(['x', 'y'])
  })

  it('一个订阅者抛异常，不影响其它订阅者，也不影响 push 本身', () => {
    // 这个订阅者就是往窗口发 IPC 的那条线：它炸了绝不能让命令跟着炸
    const store = new TraceStore()
    const seen: string[] = []
    store.subscribe(() => {
      throw new Error('窗口没了')
    })
    store.subscribe((entry) => seen.push(entry.command))
    expect(() => store.push(input({ command: 'ok' }))).not.toThrow()
    expect(seen).toEqual(['ok'])
  })

  it('退订之后不再收到', () => {
    const store = new TraceStore()
    const seen: string[] = []
    const off = store.subscribe((entry) => seen.push(entry.command))
    store.push(input({ command: 'first' }))
    off()
    store.push(input({ command: 'second' }))
    expect(seen).toEqual(['first'])
  })
})

describe('Session 挂钩：命令出口只此一处', () => {
  let cluster: FakeCluster
  let workDir: string
  let session: Session
  let traces: TraceInput[]

  beforeAll(async () => {
    cluster = await createFakeCluster({
      commands: {
        'echo hi': { stdout: 'hi\n', code: 0 },
        'exit 3': { stdout: 'partial\n', stderr: 'boom\n', code: 3 }
      }
    })

    workDir = mkdtempSync(join(tmpdir(), 'hpc-trace-'))
    writeFileSync(join(workDir, 'id_ed25519'), makeTestKey())

    const loaded = validateProfiles(
      {
        defaultProfile: 'fake',
        profiles: [
          {
            id: 'fake',
            host: '127.0.0.1',
            port: cluster.port,
            username: 'user01',
            auth: { method: 'key', privateKeyPath: join(workDir, 'id_ed25519') }
          }
        ]
      },
      join(workDir, 'profiles.json')
    )

    traces = []
    session = await Session.open(loaded.profiles[0]!, {
      knownHosts: new KnownHostsStore(null),
      onTrace: (entry) => traces.push(entry)
    })
  })

  afterAll(async () => {
    await session?.close()
    await cluster?.close()
    rmSync(workDir, { recursive: true, force: true })
  })

  it('成功的命令连输出一起记下来', async () => {
    traces.length = 0
    await session.exec('echo hi')
    expect(traces).toHaveLength(1)
    const entry = traces[0]!
    expect(entry.command).toBe('echo hi')
    expect(entry.stdout).toBe('hi\n')
    expect(entry.code).toBe(0)
    expect(entry.error).toBeNull()
    // 主机名要带上：多 profile 时靠它区分这条命令发给了谁
    expect(entry.host).toBe('127.0.0.1')
    expect(entry.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('非 0 退出照样记，而且 stderr 单独存', async () => {
    traces.length = 0
    const result = await session.exec('exit 3')
    expect(result.code).toBe(3)
    expect(traces).toHaveLength(1)
    expect(traces[0]!.code).toBe(3)
    expect(traces[0]!.stderr).toBe('boom\n')
    expect(traces[0]!.stdout).toBe('partial\n')
    expect(traces[0]!.error).toBeNull()
  })

  it('onTrace 自己抛异常时，命令结果不受影响', async () => {
    const loaded = validateProfiles(
      {
        defaultProfile: 'fake',
        profiles: [
          {
            id: 'fake',
            host: '127.0.0.1',
            port: cluster.port,
            username: 'user01',
            auth: { method: 'key', privateKeyPath: join(workDir, 'id_ed25519') }
          }
        ]
      },
      join(workDir, 'profiles.json')
    )
    const fragile = await Session.open(loaded.profiles[0]!, {
      knownHosts: new KnownHostsStore(null),
      onTrace: () => {
        throw new Error('记录组件炸了')
      }
    })
    try {
      // 这条断言是整个特性的底线：观测代码不许反噬被观测的东西
      await expect(fragile.exec('echo hi')).resolves.toMatchObject({ code: 0, stdout: 'hi\n' })
    } finally {
      await fragile.close()
    }
  })
})
