/**
 * 交互式终端会话管理。
 *
 * 主进程里唯一要做的额外事情就是**合并输出**：`ls -R` 或者 `tail -f` 一刷，
 * 一秒能吐出上千个 chunk。一条一块地走 IPC 会把渲染层打死
 * （和传输进度、日志跟随是同一个教训）。
 *
 * 但终端和日志不一样：**必须保持低延迟**。用户敲一个键要立刻看到回显，
 * 所以合并窗口取一帧（16ms）——人眼分辨不出来，又足以把突发输出攒成一批。
 */
import type { ShellHandle, ShellSize, Session } from '../ssh/session'

/** 一帧的时长。再大就会有可感知的输入延迟 */
const FLUSH_INTERVAL_MS = 16

/** 攒到这么多就立刻发，不等下一帧（避免一次甩一个巨大的字符串给渲染层） */
const FLUSH_THRESHOLD_CHARS = 64 * 1024

export interface TerminalCloseInfo {
  sessionId: string
  code: number | null
  signal: string | null
  /** 给人看的结束原因 */
  reason: string
}

interface TerminalRecord {
  id: string
  /** 哪个窗口开的。一个窗口只留一个终端 */
  ownerId: number
  handle: ShellHandle
  buffer: string
  timer: NodeJS.Timeout | null
  /** 主动关闭时用来区分"我关的"和"远端退出了" */
  closingByLocal: boolean
}

export class TerminalService {
  private readonly sessions = new Map<string, TerminalRecord>()
  private seq = 0

  constructor(
    private readonly options: {
      onData: (sessionId: string, text: string) => void
      onClose: (info: TerminalCloseInfo) => void
    }
  ) {}

  list(): string[] {
    return [...this.sessions.keys()]
  }

  /**
   * 开一个终端。同一个窗口之前开的会被关掉——
   * 界面上只有一个终端视图，多开会白占服务端的 `MaxSessions`。
   */
  async open(session: Session, ownerId: number, size: ShellSize): Promise<string> {
    this.closeForOwner(ownerId)

    this.seq += 1
    const id = `term-${this.seq}-${Date.now().toString(36)}`

    const record: TerminalRecord = {
      id,
      ownerId,
      handle: null as unknown as ShellHandle,
      buffer: '',
      timer: null,
      closingByLocal: false
    }

    const handle = await session.openShell(size, {
      onData: (text) => this.push(record, text),
      onClose: ({ code, signal }) => {
        this.flush(record)
        this.cleanup(record)
        this.options.onClose({
          sessionId: id,
          code,
          signal,
          reason: record.closingByLocal
            ? '已关闭'
            : code === null
              ? '连接已断开'
              : `远端进程退出了（退出码 ${code}${signal ? ` / ${signal}` : ''}）`
        })
      }
    })

    record.handle = handle
    this.sessions.set(id, record)
    return id
  }

  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.handle.write(data)
  }

  resize(sessionId: string, size: ShellSize): void {
    this.sessions.get(sessionId)?.handle.resize(size)
  }

  close(sessionId: string): boolean {
    const record = this.sessions.get(sessionId)
    if (!record) return false
    this.closeRecord(record)
    return true
  }

  /** 窗口关了 / 刷新了，把它的终端都收掉，别在远端留一堆 shell 进程 */
  closeForOwner(ownerId: number): void {
    for (const record of [...this.sessions.values()]) {
      if (record.ownerId === ownerId) this.closeRecord(record)
    }
  }

  closeAll(): void {
    for (const record of [...this.sessions.values()]) this.closeRecord(record)
  }

  private closeRecord(record: TerminalRecord): void {
    record.closingByLocal = true
    this.flush(record)
    this.cleanup(record)
    record.handle.close()
  }

  private push(record: TerminalRecord, text: string): void {
    record.buffer += text
    if (record.buffer.length >= FLUSH_THRESHOLD_CHARS) {
      this.flush(record)
      return
    }
    if (record.timer !== null) return
    record.timer = setTimeout(() => {
      record.timer = null
      this.flush(record)
    }, FLUSH_INTERVAL_MS)
  }

  private flush(record: TerminalRecord): void {
    if (record.timer !== null) {
      clearTimeout(record.timer)
      record.timer = null
    }
    if (record.buffer.length === 0) return
    const text = record.buffer
    record.buffer = ''
    this.options.onData(record.id, text)
  }

  private cleanup(record: TerminalRecord): void {
    if (record.timer !== null) {
      clearTimeout(record.timer)
      record.timer = null
    }
    this.sessions.delete(record.id)
  }
}
