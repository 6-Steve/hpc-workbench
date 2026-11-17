/**
 * 终端会话管理。
 *
 * 重点是**输出合并**：终端一刷屏就是成百上千个 chunk，一条一块地走 IPC
 * 会把渲染层打死；但合并窗口太大又会有输入延迟。16ms 这个数字要有测试兜住，
 * 否则以后有人"顺手"改成 200ms，打字就会明显发涩而没人知道为什么。
 */
import { describe, expect, it } from 'vitest'
import { TerminalService } from '../src/main/terminal/service'
import type { ShellHandle, ShellHandlers, ShellSize, Session } from '../src/main/ssh/session'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface FakeShell {
  session: Session
  written: string[]
  resized: ShellSize[]
  /** 模拟远端吐出输出 */
  emit: (text: string) => void
  /** 模拟远端自己退出 */
  exit: () => void
  wasClosed: () => boolean
}

function fakeShell(): FakeShell {
  const written: string[] = []
  const resized: ShellSize[] = []
  let handlers: ShellHandlers | null = null
  let closed = false

  const handle: ShellHandle = {
    write: (data) => written.push(data),
    resize: (size) => resized.push(size),
    close: () => {
      closed = true
      handlers?.onClose?.({ code: null, signal: null })
    }
  }

  const session = {
    async openShell(_size: ShellSize, incoming: ShellHandlers): Promise<ShellHandle> {
      handlers = incoming
      return handle
    }
  } as unknown as Session

  return {
    session,
    written,
    resized,
    emit: (text) => handlers?.onData(text),
    exit: () => handlers?.onClose?.({ code: 0, signal: null }),
    wasClosed: () => closed
  }
}

function makeService(): {
  service: TerminalService
  chunks: Array<{ sessionId: string; text: string }>
  closed: Array<{ sessionId: string; reason: string; code: number | null }>
} {
  const chunks: Array<{ sessionId: string; text: string }> = []
  const closed: Array<{ sessionId: string; reason: string; code: number | null }> = []
  const service = new TerminalService({
    onData: (sessionId, text) => chunks.push({ sessionId, text }),
    onClose: (info) => closed.push({ sessionId: info.sessionId, reason: info.reason, code: info.code })
  })
  return { service, chunks, closed }
}

describe('TerminalService', () => {
  it('开终端返回 id，键盘输入原样交给 handle', async () => {
    const shell = fakeShell()
    const { service } = makeService()

    const id = await service.open(shell.session, 1, { cols: 80, rows: 24 })
    expect(id).toMatch(/^term-/)
    expect(service.list()).toEqual([id])

    service.write(id, 'ls -la\n')
    expect(shell.written).toEqual(['ls -la\n'])
  })

  it('16ms 内的多段输出合并成一次推送', async () => {
    const shell = fakeShell()
    const { service, chunks } = makeService()
    const id = await service.open(shell.session, 1, { cols: 80, rows: 24 })

    // 模拟一次刷屏：同一条同步循环里吐 5 段
    for (const piece of ['a', 'b', 'c', 'd', 'e']) shell.emit(piece)
    expect(chunks).toHaveLength(0) // 还没到刷新点

    await sleep(40)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toEqual({ sessionId: id, text: 'abcde' })
  })

  it('隔开时间的输出会分开推（不会一直攒着）', async () => {
    const shell = fakeShell()
    const { service, chunks } = makeService()
    await service.open(shell.session, 1, { cols: 80, rows: 24 })

    shell.emit('first')
    await sleep(40)
    shell.emit('second')
    await sleep(40)

    expect(chunks.map((chunk) => chunk.text)).toEqual(['first', 'second'])
  })

  it('远端自己退出时如实报退出码', async () => {
    const shell = fakeShell()
    const { service, closed } = makeService()
    const id = await service.open(shell.session, 1, { cols: 80, rows: 24 })

    shell.exit()
    expect(closed).toEqual([{ sessionId: id, reason: '远端进程退出了（退出码 0）', code: 0 }])
    expect(service.list()).toHaveLength(0)
  })

  it('本地关闭时理由是「已关闭」，不会说成远端退出', async () => {
    const shell = fakeShell()
    const { service, closed } = makeService()
    const id = await service.open(shell.session, 1, { cols: 80, rows: 24 })

    service.close(id)
    expect(shell.wasClosed()).toBe(true)
    expect(closed[0]?.reason).toBe('已关闭')
  })

  it('关掉之前先把没发出去的输出推掉（否则最后一行会丢）', async () => {
    const shell = fakeShell()
    const { service, chunks } = makeService()
    const id = await service.open(shell.session, 1, { cols: 80, rows: 24 })

    shell.emit('last line')
    service.close(id) // 不等定时器
    expect(chunks.map((chunk) => chunk.text)).toContain('last line')
  })

  it('resize 转给 handle', async () => {
    const shell = fakeShell()
    const { service } = makeService()
    const id = await service.open(shell.session, 1, { cols: 80, rows: 24 })

    service.resize(id, { cols: 132, rows: 40 })
    expect(shell.resized).toEqual([{ cols: 132, rows: 40 }])
  })

  it('同一个窗口再开一个会把上一个关掉（界面上只有一个终端视图）', async () => {
    const first = fakeShell()
    const second = fakeShell()
    const { service } = makeService()

    const firstId = await service.open(first.session, 7, { cols: 80, rows: 24 })
    const secondId = await service.open(second.session, 7, { cols: 80, rows: 24 })

    expect(first.wasClosed()).toBe(true)
    expect(service.list()).toEqual([secondId])
    expect(service.list()).not.toContain(firstId)
  })

  it('closeForOwner 只关这个窗口的', async () => {
    const mine = fakeShell()
    const other = fakeShell()
    const { service } = makeService()

    await service.open(mine.session, 1, { cols: 80, rows: 24 })
    const otherId = await service.open(other.session, 2, { cols: 80, rows: 24 })

    service.closeForOwner(1)
    expect(mine.wasClosed()).toBe(true)
    expect(service.list()).toEqual([otherId])
  })

  it('closeAll 把剩下的都关掉（应用退出时靠它）', async () => {
    const shell = fakeShell()
    const { service } = makeService()
    await service.open(shell.session, 1, { cols: 80, rows: 24 })

    service.closeAll()
    expect(shell.wasClosed()).toBe(true)
    expect(service.list()).toHaveLength(0)
  })

  it('往不存在的会话写数据不炸', () => {
    const { service } = makeService()
    expect(() => service.write('nope', 'x')).not.toThrow()
    expect(service.close('nope')).toBe(false)
  })
})
