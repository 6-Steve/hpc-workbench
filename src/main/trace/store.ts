/**
 * 命令记录的内存副本（主进程侧）。
 *
 * 这是一个**有界环形缓冲**：轮询每 20 秒就在发命令，无界存下去迟早吃光内存。
 * 满了就丢最旧的，界面上永远看到"最近 N 条"。
 *
 * 完整输出只在主进程留一份（渲染层拿到的是预览），这样界面上点「看完整」
 * 才有东西可看，同时不必把几十 KB 的 JSON 全塞进 IPC。
 */
import {
  MAX_FIELD_CHARS,
  previewOf,
  TRACE_LIMIT,
  type TraceEntry,
  type TraceInput,
  type TraceRecord
} from '../../shared/trace'

export type { TraceRecord } from '../../shared/trace'

function capText(text: string): string {
  return text.length > MAX_FIELD_CHARS ? text.slice(0, MAX_FIELD_CHARS) : text
}

export class TraceStore {
  private seq = 0
  private records: TraceRecord[] = []
  private readonly listeners = new Set<(entry: TraceEntry) => void>()
  private readonly limit: number

  constructor(options: { limit?: number } = {}) {
    this.limit = Math.max(1, Math.floor(options.limit ?? TRACE_LIMIT))
  }

  /**
   * 记一条。**这个方法永远不抛**：它在 `Session.exec` 的收尾路径上，
   * 一旦抛出去，正常的命令结果会被记录组件带崩——观测绝对不能反噬被观测的东西。
   */
  push(input: TraceInput): TraceEntry | null {
    try {
      const fullStdout = capText(input.stdout)
      const fullStderr = capText(input.stderr)
      const out = previewOf(fullStdout)
      const err = previewOf(fullStderr)

      this.seq += 1
      const record: TraceRecord = {
        id: this.seq,
        at: input.at,
        profileId: input.profileId,
        host: input.host,
        // 命令本身也截断：sbatch 的 heredoc 可以有几千字，留着没意义还占地方
        command: capText(input.command),
        code: input.code,
        durationMs: input.durationMs,
        stdout: out.text,
        stderr: err.text,
        stdoutChars: input.stdout.length,
        stderrChars: input.stderr.length,
        truncated: input.truncated,
        error: input.error,
        fullStdout,
        fullStderr
      }

      this.records.push(record)
      if (this.records.length > this.limit) {
        this.records.splice(0, this.records.length - this.limit)
      }

      const entry = this.toEntry(record)
      for (const listener of this.listeners) {
        try {
          listener(entry)
        } catch {
          // 单个订阅者出错不能影响其它订阅者和命令本身
        }
      }
      return entry
    } catch {
      return null
    }
  }

  list(): TraceEntry[] {
    return this.records.map((record) => this.toEntry(record))
  }

  detail(id: number): TraceRecord | null {
    const record = this.records.find((item) => item.id === id)
    return record ? { ...record } : null
  }

  clear(): void {
    this.records = []
  }

  subscribe(listener: (entry: TraceEntry) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private toEntry(record: TraceRecord): TraceEntry {
    const { fullStdout: _out, fullStderr: _err, ...entry } = record
    return { ...entry }
  }
}
