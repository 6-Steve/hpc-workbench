/**
 * `squeue --me --json` → 我的作业队列。
 *
 * 相比表格形态，JSON 最大的好处是 `state` 和 `state_reason` 是独立字段——
 * 不用再从 `NODELIST(REASON)` 那一列的括号里抠（docs/03 §3.5）。
 */
import { describeReason, isHeldByUser, normalizeJobState } from '../domain/job-state'
import {
  dataArray,
  envelopeErrors,
  isInfinite,
  optNumber,
  optString,
  parseJsonObject
} from './json'
import { fail, ok, type Adapter, type Job, type ParseResult } from './types'

export const SQUEUE_COMMAND = 'squeue --me --json'

/** 从 `cpu=8,mem=96G,node=2,billing=8,gres/gpu=4,gres/gpu:a100-pcie-40gb=4` 里取通用 GPU 数 */
const GPU_TRES_PATTERN = /(?:^|,)gres\/gpu=(\d+)/

function gpusRequested(tresReq: string | null): number | null {
  if (!tresReq) return null
  const match = GPU_TRES_PATTERN.exec(tresReq)
  if (!match) return null
  const value = Number.parseInt(match[1] ?? '', 10)
  return Number.isNaN(value) ? null : value
}

export function parseSqueue(raw: string): ParseResult<Job[]> {
  const parsed = parseJsonObject(raw)
  if (!parsed.ok) return parsed

  const envelope = parsed.data
  const error = envelopeErrors(envelope)
  if (error) return fail(`调度器返回错误：${error}`, raw)

  // 队列为空是正常状态（不是错误），返回空数组 + 由 UI 给引导文案
  const jobs = dataArray(envelope, 'jobs')

  const result: Job[] = []
  for (const item of jobs) {
    const id = optNumber(item['job_id'])
    const name = optString(item['name'])
    if (id === null || name === null) {
      return fail('有作业缺少 job_id 或 name，输出结构可能变了', raw)
    }

    const rawState = optString(item['job_state']) ?? ''
    const reason = optString(item['state_reason'])
    const tresReq = optString(item['tres_req_str'])

    result.push({
      id: String(id),
      name,
      user: optString(item['user_name']) ?? '',
      partition: optString(item['partition']) ?? '',
      state: normalizeJobState(rawState),
      rawState,
      reason,
      reasonText: describeReason(reason).text,
      nodes: optString(item['nodes']),
      nodeCount: optNumber(item['node_count']),
      cpus: optNumber(item['cpus']),
      // infinite 与"没设置"对界面都是"不显示上限"，统一成 null
      timeLimitMinutes: isInfinite(item['time_limit']) ? null : optNumber(item['time_limit']),
      submitTime: optNumber(item['submit_time']),
      startTime: optNumber(item['start_time']),
      gpusRequested: gpusRequested(tresReq),
      heldByUser: isHeldByUser(reason)
    })
  }

  // 排序：运行中优先，其次按作业号倒序（新的在前）
  result.sort((a, b) => {
    const weight = (job: Job): number => (job.state === 'running' ? 0 : job.state === 'pending' ? 1 : 2)
    const diff = weight(a) - weight(b)
    if (diff !== 0) return diff
    return Number(b.id) - Number(a.id)
  })

  return ok(result)
}

export const squeueAdapter: Adapter<Job[]> = {
  name: 'squeue',
  command: SQUEUE_COMMAND,
  parse: parseSqueue
}
