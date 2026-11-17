/**
 * `sacct --json` → 历史作业。
 *
 * ⚠️ 这个 adapter **不能照抄 squeue 的字段表**，实测两者结构差别很大
 * （docs/03 §3.6 特意警告过，这次实测验证了）：
 *
 * | 字段 | squeue | sacct |
 * |---|---|---|
 * | `state` | 字符串 `"PENDING"` | **对象** `{current, reason}` |
 * | `exit_code` | 不存在 | **对象** `{status, return_code}` |
 * | 时间 | `submit_time` / `start_time` 平铺 | `time: {elapsed, start, end, submission}` |
 * | 资源 | `tres_req_str` 字符串 | `tres.allocated[]` 数组 |
 * | 节点数 | `node_count` | `allocation_nodes` |
 *
 * 另一个坑（实测发现）：**state 是 FAILED 时 `exit_code` 可能仍是 SUCCESS**。
 * 因为 `-X` 只取主作业，真正失败的是 `script` 步骤，主作业的退出码是 0。
 * 所以界面上不能拿 exit_code 断定失败原因，得如实把两者都摆出来。
 */
import { normalizeJobState } from '../domain/job-state'
import { dataArray, envelopeErrors, optNumber, optString, parseJsonObject } from './json'
import { fail, ok, type JobState, type ParseResult } from './types'

/**
 * 历史查询命令。
 *
 * **这个版本的 sacct 不认 `--me`**（实测报 `unrecognized option '--me'`），
 * 只能用 `-u "$USER"`。`$USER` 必须留给远端 shell 展开，
 * 所以整个命令是按 shell 语法拼的，不能走 `shq()` 单独包参数。
 */
export function sacctCommand(days = 7): string {
  return `sacct --json -X --starttime=now-${days}days -u "$USER"`
}

export interface JobHistory {
  id: string
  name: string
  partition: string
  state: JobState
  rawState: string
  /** `state.reason`，实测是字符串 `"None"` 而不是 null，统一转成 null */
  stateReason: string | null
  /** 退出码；sacct 会给对象，解析不出来就是 null */
  exitStatus: string | null
  exitReturnCode: number | null
  elapsedSeconds: number | null
  startTime: number | null
  endTime: number | null
  submitTime: number | null
  nodes: string | null
  nodeCount: number | null
  cpus: number | null
  gpus: number | null
  timeLimitMinutes: number | null
  qos: string | null
  /**
   * 作业提交时的工作目录。用来推断日志文件在哪——
   * ⚠️ `sacct` **不提供 `StdOut` 字段**（实测报 Invalid field），
   * 只能拿 workDir 再按 `<作业名>-<作业号>.out` 的约定猜。
   */
  workDir: string | null
  /**
   * 状态说失败、但退出码是 0。
   * 这种情况没法从 sacct 看出根因（失败在 batch 步骤里），界面要引导去看 .out 日志。
   */
  exitCodeMisleading: boolean
}

/** `{current:"COMPLETED", reason:"None"}` → 拆开；兼容传字符串的老格式 */
function readState(value: unknown): { current: string; reason: string | null } {
  if (typeof value === 'string') return { current: value, reason: null }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const current = typeof record['current'] === 'string' ? record['current'] : ''
    const rawReason = typeof record['reason'] === 'string' ? record['reason'] : ''
    // 实测 reason 会给字符串 "None"，别当成有意义的原因
    const reason = rawReason && rawReason !== 'None' ? rawReason : null
    return { current, reason }
  }
  return { current: '', reason: null }
}

/** `tres.allocated[]` 里按类型取数量 */
function tresCount(list: unknown, type: string, name?: string): number | null {
  if (!Array.isArray(list)) return null
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (record['type'] !== type) continue
    if (name !== undefined && record['name'] !== name) continue
    const count = optNumber(record['count'])
    if (count === null) continue
    // JSON 里 count 是裸数字（不是 {set,infinite,number}），这里兼容两种
    return typeof record['count'] === 'number' ? (record['count'] as number) : count
  }
  return null
}

export function parseSacct(raw: string): ParseResult<JobHistory[]> {
  const parsed = parseJsonObject(raw)
  if (!parsed.ok) return parsed

  const envelope = parsed.data
  const error = envelopeErrors(envelope)
  if (error) return fail(`调度器返回错误：${error}`, raw)

  const jobs = dataArray(envelope, 'jobs')
  const result: JobHistory[] = []

  for (const item of jobs) {
    const id = optNumber(item['job_id'])
    if (id === null) continue

    const state = readState(item['state'])
    const normalized = normalizeJobState(state.current)

    const time = (item['time'] ?? {}) as Record<string, unknown>
    const limit = (time['limit'] ?? {}) as Record<string, unknown>

    const exit = (item['exit_code'] ?? {}) as Record<string, unknown>
    const exitStatus = typeof exit['status'] === 'string' ? exit['status'] : null
    const exitReturnCode = typeof exit['return_code'] === 'number' ? (exit['return_code'] as number) : null

    const allocated = (item['tres'] as Record<string, unknown> | undefined)?.['allocated']

    result.push({
      id: String(id),
      name: optString(item['name']) ?? '(未命名)',
      partition: optString(item['partition']) ?? '',
      state: normalized,
      rawState: state.current,
      stateReason: state.reason,
      exitStatus,
      exitReturnCode,
      elapsedSeconds: typeof time['elapsed'] === 'number' ? (time['elapsed'] as number) : null,
      startTime: typeof time['start'] === 'number' && time['start'] > 0 ? (time['start'] as number) : null,
      endTime: typeof time['end'] === 'number' && time['end'] > 0 ? (time['end'] as number) : null,
      submitTime:
        typeof time['submission'] === 'number' && time['submission'] > 0 ? (time['submission'] as number) : null,
      nodes: optString(item['nodes']),
      nodeCount:
        typeof item['allocation_nodes'] === 'number' ? (item['allocation_nodes'] as number) : null,
      cpus: tresCount(allocated, 'cpu'),
      gpus: tresCount(allocated, 'gres', 'gpu'),
      timeLimitMinutes: limit['infinite'] === true ? null : optNumber(limit['number']),
      qos: optString(item['qos']),
      workDir: optString(item['working_directory']),
      // 失败但退出码是 0 —— 主作业成功、脚本失败，sacct 这里看不出根因
      exitCodeMisleading: normalized === 'failed' && exitReturnCode === 0
    })
  }

  return ok(result)
}
