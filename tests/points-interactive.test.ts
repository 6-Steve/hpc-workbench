/**
 * 「跑一条会问密码的命令」这一层。
 *
 * 这里测的两件事都能花掉真钱，所以断言写得比别处狠：
 *
 * 1. **成功判定绝不能依赖 PTY 的退出码**。`openShell` 开的是 bash，
 *    命令跑完 bash 不退出，`onClose` 根本不触发。早期实现拿 `onClose.code`
 *    判成功，结果是「转账成功 → 等 25 秒超时 → 判失败」，
 *    用户看到失败会再转一次。见 `interactive.ts` 顶部那一节。
 * 2. **密码必须等提示串出现才写**，且写完不能出现在输出里。
 *
 * 用假的 `Session`（只要有 `openShell` 就行），不碰网络。
 */
import { describe, expect, it } from 'vitest'
import { runWithPassword, extractCommandOutput, isPasswordRunSuccess } from '../src/main/ssh/interactive'
import type { PasswordPromptResult } from '../src/main/ssh/interactive'

/** 造一个能用手推的假 Session：`feed()` 模拟远端吐字节，`finish()` 模拟 bash 退出 */
function fakeSession(): {
  session: { openShell: unknown }
  write: (data: string) => void
  feed: (text: string) => void
  finish: (code: number | null) => void
  written: string[]
} {
  const written: string[] = []
  let onData: (text: string) => void = () => undefined
  let onClose: ((result: { code: number | null; signal: string | null }) => void) | undefined

  const session = {
    openShell: async (_size: unknown, handlers: { onData: typeof onData; onClose: typeof onClose }) => {
      onData = handlers.onData
      onClose = handlers.onClose
      return {
        write: (data: string) => written.push(data),
        resize: () => undefined,
        close: () => onClose?.({ code: null, signal: null })
      }
    }
  }

  return {
    session,
    write: (data) => written.push(data),
    feed: (text) => onData(text),
    finish: (code) => onClose?.({ code, signal: null }),
    written
  }
}

/** 从发出的命令里抠出哨兵串（`printf` 里那个前缀 + nonce） */
function extractMarker(command: string): string {
  const match = /__HPC_DONE_[a-z0-9]+__:/.exec(command)
  if (!match) throw new Error(`命令里没有哨兵：${command}`)
  return match[0]
}

const PASSWORD = 'hunter2-SECRET'

describe('runWithPassword · 哨兵', () => {
  it('命令后面必须追加哨兵，且用 ; 而不是 &&（失败也要打）', async () => {
    const fake = fakeSession()
    void runWithPassword(fake.session as never, 'scir-account transfer --points=1', PASSWORD, {
      timeoutMs: 50
    })
    await new Promise((r) => setTimeout(r, 5))

    const sent = fake.written.join('')
    expect(sent).toContain('scir-account transfer --points=1')
    // `&&` 在命令失败时不会执行哨兵 → 只能等超时，这里必须是否定的
    expect(sent).not.toContain('&& printf')
    expect(sent).toContain('__HPC_DONE_')
    expect(sent).toContain('$?')
  })

  it('看到哨兵立刻结束，不等 bash 退出', async () => {
    const fake = fakeSession()
    const pending = runWithPassword(fake.session as never, 'scir-account transfer', PASSWORD, {
      timeoutMs: 5000
    })
    await new Promise((r) => setTimeout(r, 5))

    const marker = extractMarker(fake.written.join(''))
    fake.feed('转移成功\n')
    fake.feed(`${marker}0\n`)

    const result = await pending
    expect(result.finished).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(result.code).toBe(0)
  })

  it('退出码从哨兵里读，是**命令**的而不是 bash 的', async () => {
    const fake = fakeSession()
    const pending = runWithPassword(fake.session as never, 'scir-account transfer', PASSWORD, {
      timeoutMs: 5000
    })
    await new Promise((r) => setTimeout(r, 5))

    const marker = extractMarker(fake.written.join(''))
    fake.feed(`${marker}2\n`)

    const result = await pending
    expect(result.code).toBe(2)
    expect(result.finished).toBe(true)
  })

  it('哨兵被 chunk 切开也能认出来', async () => {
    const fake = fakeSession()
    const pending = runWithPassword(fake.session as never, 'scir-account transfer', PASSWORD, {
      timeoutMs: 5000
    })
    await new Promise((r) => setTimeout(r, 5))

    const marker = extractMarker(fake.written.join(''))
    // 从中间劈开
    fake.feed(marker.slice(0, 6))
    fake.feed(marker.slice(6))
    fake.feed('1\n')

    const result = await pending
    expect(result.finished).toBe(true)
    expect(result.code).toBe(1)
  })

  it('哨兵本身不会出现在给用户看的输出里', async () => {
    const fake = fakeSession()
    const pending = runWithPassword(fake.session as never, 'scir-account transfer', PASSWORD, {
      timeoutMs: 5000
    })
    await new Promise((r) => setTimeout(r, 5))

    const marker = extractMarker(fake.written.join(''))
    fake.feed(`Success! 已转出 100 点\n`)
    fake.feed(`${marker}0\n`)

    const result = await pending
    expect(result.output).not.toContain('__HPC_DONE_')
    expect(result.output).toContain('Success!')
  })

  it('没见到哨兵就超时：finished=false，code=null，绝不能当成成功', async () => {
    const fake = fakeSession()
    const pending = runWithPassword(fake.session as never, 'scir-account transfer', PASSWORD, {
      timeoutMs: 30
    })
    await new Promise((r) => setTimeout(r, 5))
    fake.feed('Your Password: ') // 只出提示串，命令永远不返回

    const result = await pending
    expect(result.timedOut).toBe(true)
    expect(result.finished).toBe(false)
    expect(result.code).toBeNull()
    expect(isPasswordRunSuccess(result).ok).toBe(false)
  })

  it('bash 中途退出（没哨兵）也算没结束', async () => {
    const fake = fakeSession()
    const pending = runWithPassword(fake.session as never, 'scir-account transfer', PASSWORD, {
      timeoutMs: 5000
    })
    await new Promise((r) => setTimeout(r, 5))
    fake.finish(0) // bash 自己 exit 0，但命令没跑完

    const result = await pending
    expect(result.finished).toBe(false)
    expect(result.code).toBeNull()
    expect(isPasswordRunSuccess(result).ok).toBe(false)
  })
})

describe('runWithPassword · 密码', () => {
  it('没看到提示串就不写密码', async () => {
    const fake = fakeSession()
    void runWithPassword(fake.session as never, 'scir-account transfer', PASSWORD, { timeoutMs: 30 })
    await new Promise((r) => setTimeout(r, 5))
    fake.feed('some banner\n')

    await new Promise((r) => setTimeout(r, 5))
    expect(fake.written.join('')).not.toContain(PASSWORD)
  })

  it('提示串被 chunk 切开（Your Pass / word:）也能认出来', async () => {
    const fake = fakeSession()
    void runWithPassword(fake.session as never, 'scir-account transfer', PASSWORD, {
      timeoutMs: 5000,
      settleMs: 1
    })
    await new Promise((r) => setTimeout(r, 5))

    fake.feed('Your Pass')
    fake.feed('word: ')
    await new Promise((r) => setTimeout(r, 20))

    expect(fake.written.join('')).toContain(`${PASSWORD}\n`)
  })

  it('密码只写一次，重复的提示串不会喂第二遍', async () => {
    const fake = fakeSession()
    void runWithPassword(fake.session as never, 'scir-account transfer', PASSWORD, {
      timeoutMs: 5000,
      settleMs: 1
    })
    await new Promise((r) => setTimeout(r, 5))

    fake.feed('Your Password: ')
    fake.feed('Your Password: ')
    await new Promise((r) => setTimeout(r, 20))

    const sent = fake.written.join('')
    expect(sent.split(PASSWORD).length - 1).toBe(1)
  })

  it('中文冒号也认（本地化版本）', async () => {
    const fake = fakeSession()
    void runWithPassword(fake.session as never, 'scir-account transfer', PASSWORD, {
      timeoutMs: 5000,
      settleMs: 1
    })
    await new Promise((r) => setTimeout(r, 5))
    fake.feed('密码：')
    await new Promise((r) => setTimeout(r, 20))

    expect(fake.written.join('')).toContain(PASSWORD)
  })
})

describe('isPasswordRunSuccess · 成功判定', () => {
  const base: PasswordPromptResult = {
    output: 'Success',
    code: 0,
    sentPassword: true,
    timedOut: false,
    finished: true,
    durationMs: 100
  }

  it('哨兵 + 退出码 0 → 成功', () => {
    expect(isPasswordRunSuccess(base).ok).toBe(true)
  })

  it('退出码非 0 → 失败，理由里带码', () => {
    const verdict = isPasswordRunSuccess({ ...base, code: 1 })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('1')
  })

  it('exit 0 但输出里有 Error → 仍然算失败（CLI 退化保护）', () => {
    const verdict = isPasswordRunSuccess({ ...base, output: 'Error: LdapError(rc: 49)' })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('Error')
  })

  it('超时优先报超时，不被退出码盖过', () => {
    const verdict = isPasswordRunSuccess({ ...base, timedOut: true, code: null, finished: false })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('没有回应')
  })

  it('成功时 reason 是 null，不留半截提示', () => {
    expect(isPasswordRunSuccess(base).reason).toBeNull()
  })
})

describe('extractCommandOutput · 切掉干扰', () => {
  it('切掉登录横幅、命令回显和结尾提示符', () => {
    const raw = [
      'Last login: Thu Nov 5 21:00:00 2026 from 10.0.0.1',
      'alice@login-01:~$ scir-account transfer --points=10 --target=u1 --month=1',
      'Transfer 10 points to u1 successfully.',
      'alice@login-01:~$ '
    ].join('\r\n')

    const text = extractCommandOutput(raw)
    expect(text).toBe('Transfer 10 points to u1 successfully.')
    expect(text).not.toContain('Last login')
    expect(text).not.toContain('alice@login-01')
  })

  it('命令回显带多行输出时全部保留', () => {
    const raw = [
      'alice@login-01:~$ scir-account transfer -p 5 -t u1 -m 1',
      'line one',
      'line two',
      'alice@login-01:~$ '
    ].join('\n')
    expect(extractCommandOutput(raw)).toBe('line one\nline two')
  })

  it('没有命令回显时保留全文，不返回空串', () => {
    // 提示符被重绘覆盖是真实会发生的，此时宁可多给也不要给空
    expect(extractCommandOutput('Something went wrong')).toBe('Something went wrong')
  })

  it('空输入返回空串而不是崩', () => {
    expect(extractCommandOutput('')).toBe('')
  })
})
