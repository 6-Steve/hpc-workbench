/**
 * 命令记录（界面上的「命令台」）：把应用背后发出的每一条 SSH 命令摊开给人看。
 *
 * 为什么值得单独做这个东西
 * ------------------------
 * 这个应用的本质是"把 `squeue` / `scontrol` / `scir-watch` 的输出翻译成界面"。
 * 一旦界面上的数字不对，第一反应永远是"它到底发了什么、远端回了什么"——
 * 没有这层记录时，只能靠翻代码猜，或者去开一个终端手动敲一遍。
 *
 * 有了它，任何一个数字都能当场对账：哪条命令、什么时候发的、花了多久、
 * 退出码多少、原文长什么样。
 *
 * 三条约束
 * --------
 * 1. **只读**。这里是"看"，不是"执行"——渲染层没有任何办法通过它发命令。
 * 2. **不能拖慢或打断被观测的命令**。记录失败一律吞掉（见 `TraceStore.push` 与
 *    `Session.exec` 的 onTrace 调用），绝不让"日志组件自己报错"变成"作业提交失败"。
 * 3. **有界**。轮询每 20 秒就在发命令，一天能攒出几万条。所以主进程只留最近
 *    `TRACE_LIMIT` 条，单条输出超过 `MAX_FIELD_CHARS` 就截断。
 */

/** 一条命令的**摘要**。完整输出留在主进程，按 id 再取（`trace:detail`） */
export interface TraceEntry {
  /** 单调递增，用作 React key 和"取完整"的参数 */
  id: number
  /** 开始执行的时间戳（epoch ms） */
  at: number
  profileId: string
  host: string
  /** 发出去的原文，可能多行（sbatch heredoc 那种） */
  command: string
  /** 远端退出码。连接层失败 / 超时 / 没拿到时是 null */
  code: number | null
  durationMs: number
  /** 预览，最多 `TRACE_PREVIEW_CHARS` 字 */
  stdout: string
  stderr: string
  /** 原始输出长度（字符数），用来判断"是不是被截了" */
  stdoutChars: number
  stderrChars: number
  /** 远端输出超过 exec 的字节上限，被丢掉了一部分（和预览截断不是一回事） */
  truncated: boolean
  /** 连接层错误的一句话：没发出去、通道断了、超时 */
  error: string | null
}

/** 命令刚跑完时的原始数据；主进程用它构造 `TraceEntry` + 完整副本 */
export interface TraceInput {
  profileId: string
  host: string
  command: string
  at: number
  code: number | null
  durationMs: number
  stdout: string
  stderr: string
  truncated: boolean
  error: string | null
}

/**
 * 完整记录：比 `TraceEntry` 多两份原文。
 *
 * 完整输出只在主进程留一份，渲染层拿到的是预览；点「看完整输出」时按 id 再取。
 * 放在 shared 里是因为两侧都要用同一个形状（渲染层只读，不参与存储）。
 */
export interface TraceRecord extends TraceEntry {
  fullStdout: string
  fullStderr: string
}

/** 列表里一条预览最多显示多少字。再长就用「取完整」看 */
export const TRACE_PREVIEW_CHARS = 4000
/** 主进程最多留多少条。轮询 20 秒一次，200 条约等于最近一小时 */
export const TRACE_LIMIT = 200
/** 单条输出在主进程最多留多少字。超出部分直接丢，避免内存被一条巨输出吃光 */
export const MAX_FIELD_CHARS = 16 * 1024

export interface Preview {
  text: string
  chars: number
  clipped: boolean
}

/** 取开头一段做预览，同时如实报出原始长度 */
export function previewOf(text: string, limit = TRACE_PREVIEW_CHARS): Preview {
  const chars = text.length
  if (chars <= limit) return { text, chars, clipped: false }
  return { text: text.slice(0, limit), chars, clipped: true }
}

/**
 * 把多行命令压成一行给列表用。
 *
 * 换行必须显式标出来（用 `⏎`）而不是简单替换成空格：sbatch 的 heredoc 压成空格后
 * 会变成一长串看着像乱码的东西，标出换行位置才能一眼认出"哦这是那个多行脚本"。
 */
export function commandSummary(command: string, limit = 160): string {
  const flat = command
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ⏎ ')
  if (flat.length <= limit) return flat
  return `${flat.slice(0, limit)}…`
}

/** 一条记录算不算"失败"。连接层错误、非 0 退出、被信号杀掉都算 */
export function isFailed(entry: Pick<TraceEntry, 'code' | 'error'>): boolean {
  if (entry.error) return true
  return entry.code !== null && entry.code !== 0
}

/** 毫秒转成人看的时长：128 ms / 1.4 s */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

/** HH:MM:SS，本地时区。只用来"对账"，不需要日期 */
export function formatClock(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
