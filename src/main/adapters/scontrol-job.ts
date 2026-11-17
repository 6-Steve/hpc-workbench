/**
 * `scontrol show job <id> --json` → 单个作业的详情。
 *
 * ## 为什么需要它
 *
 * 两个 sacct 给不了的东西：
 *
 * 1. **精确的输出文件路径**（`standard_output`）。sacct 只有 `working_directory`，
 *    输出文件名得靠猜（`<名>-<号>.out` / `<名>.out` / `slurm-<号>.out`）。
 *    实测别人的作业用的是 `qvit-train-all-203815.log`——**`.log` 不是 `.out`**，
 *    猜名字必然失败。任何自己写了 `--output` 的作业都猜不中。
 * 2. **运行中的作业**。sacct 只记已经结束的作业，`squeue` 不给工作目录，
 *    所以它是"作业还在跑时想看日志"的唯一途径。
 *
 * ## 三个必踩的坑
 *
 * 1. 作业被控制器清理后（`MinJobAge`，默认结束后 5 分钟）命令**仍然 exit 0**，
 *    只是 `jobs: []` + `warnings: ["Zero jobs to dump"]`。
 *    这不是错误，但**绝不能当成"成功"**——要如实返回失败，让调用方去查 sacct。
 * 2. `job_id` 是**数字**不是字符串（`203815`）。类型上必须 `String()`，
 *    否则后面 `/^\d+$/` 之类的校验会在 number 上挂掉。
 * 3. **时间字段和数值字段的包装不一致**：`submit_time`/`start_time`/`end_time`
 *    是裸 epoch 秒；而 `cpus`/`node_count`/`time_limit`/`memory_per_node`
 *    是 `{set,infinite,number}`。两者混起来写是这类解析最容易出错的地方。
 */
import { describeReason, normalizeJobState } from '../domain/job-state'
import { gpusFromTres } from './gres'
import {
  dataArray,
  envelopeErrors,
  isInfinite,
  optNumber,
  optString,
  parseJsonObject
} from './json'
import { fail, ok, type Adapter, type JobDetail, type ParseResult } from './types'

export function scontrolJobCommand(jobId: string): string {
  return `scontrol show job ${jobId} --json`
}

/** `state_reason` 在没事的时候是字符串 `"None"`，归一成 null */
function normalReason(value: unknown): string | null {
  const text = optString(value)
  if (text === null || text === 'None' || text === 'none') return null
  return text
}

/**
 * 退出码转成**展示用字符串**。
 *
 * 23.02 的 JSON 里 `exit_code` 是裸数字；某些构建会给 `{status, return_code}`。
 * 两种都要能吃，但不要试图把它算成 shell 退出码——SLURM 的 `status` 是
 * "被信号杀掉时的信号号"，语义和 `$?` 不同。
 */
function exitCodeText(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    const status = record['status']
    const returnCode = record['return_code']
    if (typeof status === 'number' && typeof returnCode === 'number') {
      return `${status}:${returnCode}`
    }
  }
  return null
}

/** 相对路径的输出文件按工作目录补全；集群一般给绝对路径，但别假设 */
function absolutePath(raw: string | null, workDir: string | null): string | null {
  if (raw === null) return null
  if (raw.startsWith('/')) return raw
  if (workDir === null) return null
  return `${workDir.replace(/\/+$/, '')}/${raw}`
}

/** 排队中的作业 `nodes` 是 `"(null)"` 这种占位符，不是真节点名 */
function realNodes(raw: string | null): string | null {
  if (raw === null) return null
  if (raw === '(null)' || raw === 'n/a' || raw === 'None') return null
  return raw
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

export function parseScontrolJob(raw: string): ParseResult<JobDetail> {
  const parsed = parseJsonObject(raw)
  if (!parsed.ok) return parsed

  const envelope = parsed.data
  const error = envelopeErrors(envelope)
  if (error) return fail(`调度器返回错误：${error}`, raw)

  const jobs = dataArray(envelope, 'jobs')
  if (jobs.length === 0) {
    // 最常见的两种情况：作业号写错了，或者作业已结束并被控制器清理。
    // 都不是"解析失败"，但也都不能返回空数据冒充成功。
    return fail('调度器里已经没有这个作业的信息了（可能已结束并被清理，或作业号不存在）', raw)
  }

  const item = jobs[0]!
  const id = optNumber(item['job_id'])
  const name = optString(item['name'])
  if (id === null || name === null) {
    return fail('作业缺少 job_id 或 name，输出结构可能变了', raw)
  }

  const rawState = optString(item['job_state']) ?? ''
  const reason = normalReason(item['state_reason'])
  const workDir = optString(item['current_working_directory'])
  const tresAlloc = optString(item['tres_alloc_str'])
  const tresReq = optString(item['tres_req_str'])

  return ok({
    id: String(id),
    name,
    state: normalizeJobState(rawState),
    rawState,
    stateReason: reason,
    stateReasonText: describeReason(reason).text,
    user: optString(item['user_name']) ?? '',
    partition: optString(item['partition']) ?? '',
    nodes: realNodes(optString(item['nodes'])),
    nodeCount: optNumber(item['node_count']),
    cpus: optNumber(item['cpus']),
    memoryMb: optNumber(item['memory_per_node']),
    // 分配优先于申请：运行中的作业看实际拿到的，排队中的只有申请值
    gpus: gpusFromTres(tresAlloc) ?? gpusFromTres(tresReq),
    gpuDetail: stringArray(item['gres_detail']),
    // infinite 与"没设置"对界面都是"不显示上限"
    timeLimitMinutes: isInfinite(item['time_limit']) ? null : optNumber(item['time_limit']),
    submitTime: optNumber(item['submit_time']),
    startTime: optNumber(item['start_time']),
    endTime: optNumber(item['end_time']),
    workDir,
    stdoutPath: absolutePath(optString(item['standard_output']), workDir),
    stderrPath: absolutePath(optString(item['standard_error']), workDir),
    command: optString(item['command']),
    exitCode: exitCodeText(item['exit_code']),
    derivedExitCode: exitCodeText(item['derived_exit_code']),
    tresAlloc,
    tresReq
  })
}

export const scontrolJobAdapter: Adapter<JobDetail> = {
  name: 'scontrol-job',
  command: scontrolJobCommand('<jobId>'),
  parse: parseScontrolJob
}
