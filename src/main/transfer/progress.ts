/**
 * 进度聚合与节流。
 *
 * 为什么必须有这一层：传输时若每收到一块就发一次 IPC，10 MB/s 意味着每秒数百条跨进程消息，
 * 渲染进程会被淹没，界面直接失去响应（docs/04 E1）。**统一按 100 ms 合并**。
 */
export interface ProgressSample {
  bytes: number
  elapsedMs: number
  /** 平均速率，字节/秒 */
  bytesPerSecond: number
  /** 已知总大小时的百分比；否则 null */
  percent: number | null
}

export type ProgressListener = (sample: ProgressSample) => void

export class ProgressMeter {
  private readonly startedAt = Date.now()
  private lastEmittedAt = 0
  private readonly totalBytes: number | null

  constructor(
    private readonly listener: ProgressListener,
    totalBytes?: number,
    private readonly intervalMs = 100
  ) {
    this.totalBytes = totalBytes && totalBytes > 0 ? totalBytes : null
  }

  /** 传入累计已写字节；不足间隔的直接丢弃，不做任何计算 */
  update(bytes: number): void {
    const now = Date.now()
    if (now - this.lastEmittedAt < this.intervalMs) return
    this.lastEmittedAt = now
    this.listener(this.sample(bytes, now))
  }

  /** 结束时强制吐最后一条，保证 UI 停在 100% 而不是 97% */
  finish(bytes: number): void {
    const now = Date.now()
    this.lastEmittedAt = now
    this.listener(this.sample(bytes, now))
  }

  private sample(bytes: number, now: number): ProgressSample {
    const elapsedMs = Math.max(1, now - this.startedAt)
    return {
      bytes,
      elapsedMs,
      bytesPerSecond: Math.round((bytes / elapsedMs) * 1000),
      percent: this.totalBytes ? Math.min(100, Math.round((bytes / this.totalBytes) * 1000) / 10) : null
    }
  }
}

/** 人读的速率：`82.4 MB/s` */
export function formatRate(bytesPerSecond: number): string {
  const mb = bytesPerSecond / 1024 ** 2
  if (mb >= 1) return `${mb.toFixed(1)} MB/s`
  return `${(bytesPerSecond / 1024).toFixed(0)} KB/s`
}

/** 人读的容量：`1.02 GB` */
export function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(2)} GB`
  const mb = bytes / 1024 ** 2
  if (mb >= 1) return `${mb.toFixed(1)} MB`
  return `${(bytes / 1024).toFixed(0)} KB`
}
