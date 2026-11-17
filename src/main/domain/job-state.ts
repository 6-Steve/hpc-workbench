/**
 * 作业状态映射与排队原因翻译。
 *
 * 核心诉求（docs/03 §0③）：`JobHeldUser` **不是资源不够，是用户自己挂起了作业**。
 * 把它和 `Resources` 混在一起，用户会一直等一个永远不会启动的作业。
 */
import type { JobState } from '../adapters/types'

const ALIASES: Record<string, JobState> = {
  pending: 'pending',
  configuring: 'configuring',
  running: 'running',
  suspended: 'suspended',
  completing: 'completing',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  timeout: 'timeout',
  node_fail: 'node-fail',
  'node-fail': 'node-fail',
  out_of_memory: 'out-of-memory',
  'out-of-memory': 'out-of-memory',
  preempted: 'preempted',
  requeued: 'requeued',
  requeue_fed: 'requeued',
  requeue_hold: 'pending',
  special_exit: 'failed',
  boot_fail: 'failed'
}

/** SLURM 的 job_state 是 `"PENDING"` 这种全大写，去掉首尾空白后小写归一 */
export function normalizeJobState(raw: string): JobState {
  const key = raw.trim().toLowerCase().replace(/\s+/g, '_')
  return ALIASES[key] ?? 'unknown'
}

export interface ReasonDescription {
  /** 界面上直接显示的文案 */
  text: string
  /** 用户可以做什么；null 表示只能等 */
  action: string | null
}

/**
 * 排队原因翻译表（顺序按用户实际遇到的概率，docs/03 §3.5）。
 * 认不出的原因**原样显示**，不吞掉——用户至少能看到调度器说了什么。
 */
const REASONS: Record<string, ReasonDescription> = {
  JobHeldUser: { text: '已挂起（你手动暂停，不是排队）', action: '一键恢复' },
  Priority: { text: '前面有更高优先级的作业在跑', action: null },
  Resources: { text: '暂时没有满足条件的空闲资源', action: '换机型或缩短时长' },
  QOSMaxJobsPerUser: { text: '同时运行的作业已达上限', action: '结束一个' },
  QOSMaxGRESPerUser: { text: '同时占用的 GPU 已达上限', action: '结束一个' },
  PartitionTimeLimit: { text: '申请时长超过该分区上限', action: '改时长' },
  ReqNodeNotAvail: { text: '指定节点不可用或维护中', action: '取消 -w 指定' },
  Dependency: { text: '等待前置作业完成', action: '查看上游作业' },
  AssOCGrpGRES: { text: '账户的 GPU 额度已用尽', action: null },
  launcher: { text: '正在启动', action: null },
  None: { text: '等待调度', action: null }
}

export function describeReason(raw: string | null | undefined): ReasonDescription {
  if (!raw || raw.trim().length === 0) return { text: '等待调度', action: null }
  const key = raw.trim()
  const hit = REASONS[key]
  if (hit) return hit
  return { text: `排队中（${key}）`, action: null }
}

/** 是否是"用户自己挂起"——这个判断在好几处要用，别各写各的 */
export function isHeldByUser(reason: string | null | undefined): boolean {
  return (reason ?? '').trim() === 'JobHeldUser'
}
