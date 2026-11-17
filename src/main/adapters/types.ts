/**
 * Adapter 层的类型契约。
 *
 * 唯一铁律（docs/03 开头、docs/04 §2.2）：**解析失败必须带 raw，绝不静默返回空**。
 * 用户能在界面上展开原始输出，是这个项目在"没有 API"前提下唯一的自救手段。
 */

/** 解析结果。失败时 raw 一定非空 */
export type ParseResult<T> = { ok: true; data: T } | { ok: false; reason: string; raw: string }

/** 每个数据源一个 Adapter：一条命令 + 一个纯函数 */
export interface Adapter<T> {
  /** 稳定标识，用于日志、错误提示、能力缓存 */
  readonly name: string
  /** 获取原始输出要跑的命令 */
  readonly command: string
  /** 纯函数，不碰网络、不读文件，方便直接喂夹具 */
  parse(raw: string): ParseResult<T>
}

export function ok<T>(data: T): ParseResult<T> {
  return { ok: true, data }
}

export function fail<T>(reason: string, raw: string): ParseResult<T> {
  // raw 为空时也要给个占位，避免 UI 上"查看原始输出"展开成一片空白
  return { ok: false, reason, raw: raw && raw.length > 0 ? raw : '（命令没有任何输出）' }
}

// —————————————————————— 统一模型 ——————————————————————

/** 点数余额（scir-account -d） */
export interface Points {
  total: number
  used: number
  avail: number
}

/**
 * 配额的一个维度。
 * bytes 维度单位是字节，files 维度单位是"个"——两套单位不能混用（docs/03 §3.6）。
 */
export interface QuotaDimension {
  used: number
  /** 软额度；`none` 表示没设 */
  soft: number | null
  /** 硬额度；`none` 表示没设 */
  hard: number | null
  /** 尚未结算的量，非零是正常的，只标注"数据略有滞后" */
  inDoubt: number
  /** `none` / `7 days` / `expired` */
  grace: string
}

export interface Quota {
  filesystem: string
  /** USR / FILESET / … */
  type: string
  bytes: QuotaDimension
  files: QuotaDimension
  remarks: string
}

/** 一台机器上一种卡的卡数 */
export interface GpuCount {
  /** 原始 GRES 型号名，如 `nvidia_h100_80gb_hbm3`，归一化在 domain 层做 */
  type: string
  count: number
}

/** 节点状态规范枚举（docs/03 §5.5） */
export type NodeState =
  | 'idle'
  | 'mixed'
  | 'alloc'
  | 'drain'
  | 'draining'
  | 'down'
  | 'completing'
  | 'fail'
  | 'unknown'

export interface NodeInfo {
  name: string
  /** 规范化后的全部状态，可能多个（`["IDLE","DRAIN"]`） */
  states: NodeState[]
  /** 原始状态字符串，出问题时给人看 */
  rawStates: string[]
  /**
   * 是否处于维护/故障状态（drain / down / completing / 未知）。
   * `true` 时整台机器不计入库存。
   *
   * **注意**：`false` 不等于"有货"。`ALLOCATED` 的机器通常还有空闲卡，
   * 库存要看 `freeByType(gpus, gpusUsed)` 的结果。
   */
  blocked: boolean
  /** 总卡，按型号 */
  gpus: GpuCount[]
  /** 已用卡，按型号 */
  gpusUsed: GpuCount[]
  cpus: number
  allocCpus: number
  idleCpus: number
  realMemoryMb: number
  allocMemoryMb: number
  /** null = 集群没给（`free_mem.set === false`），不是 0 */
  freeMemoryMb: number | null
  partitions: string[]
}

/** 作业状态规范枚举 */
export type JobState =
  | 'pending'
  | 'running'
  | 'suspended'
  | 'completing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'node-fail'
  | 'preempted'
  | 'out-of-memory'
  | 'requeued'
  | 'configuring'
  | 'unknown'

export interface Job {
  id: string
  name: string
  user: string
  partition: string
  state: JobState
  rawState: string
  /** squeue 的 state_reason 原文，可能为 null */
  reason: string | null
  /** 排队原因的人话版本 */
  reasonText: string
  /** 运行中才有节点名；排队时为 null */
  nodes: string | null
  nodeCount: number | null
  cpus: number | null
  /** null 表示无上限或未知 */
  timeLimitMinutes: number | null
  submitTime: number | null
  startTime: number | null
  /** 申请的 GPU 张数，从 tres_req_str 里抠 */
  gpusRequested: number | null
  /** 是否是"用户自己挂起"——必须与普通排队严格区分（docs/03 §0③） */
  heldByUser: boolean
}

/**
 * 单个作业的详情（`scontrol show job <id> --json`）。
 *
 * 和 `Job` / `JobHistory` 的区别：这份带**精确的输出文件路径**（`stdoutPath`），
 * 所以运行中的作业也能看日志，而且不用拿作业名去猜 `.out`。
 */
export interface JobDetail {
  id: string
  name: string
  state: JobState
  rawState: string
  /** 排队/结束原因原文（`"None"` 归一为 null） */
  stateReason: string | null
  /** 原因的人话版本 */
  stateReasonText: string
  user: string
  partition: string
  nodes: string | null
  nodeCount: number | null
  cpus: number | null
  memoryMb: number | null
  /** 分配到的 GPU 张数，从 `tres_alloc_str` 抠，拿不到再看 `tres_req_str` */
  gpus: number | null
  /** `gres_detail` 原文，如 `gpu:a100-sxm4-80gb:2(IDX:4-5)` */
  gpuDetail: string[]
  timeLimitMinutes: number | null
  submitTime: number | null
  startTime: number | null
  /** 运行中是"预计结束"，结束后是"实际结束"——两者都来自这同一个字段 */
  endTime: number | null
  workDir: string | null
  /** 输出/stdin 文件的绝对路径；集群没给时为 null */
  stdoutPath: string | null
  stderrPath: string | null
  command: string | null
  /** 展示用字符串：`0:0` 或 `1`。**不要当数字算**，SLURM 的 status 语义和 shell 退出码不同 */
  exitCode: string | null
  derivedExitCode: string | null
  tresAlloc: string | null
  tresReq: string | null
}

/** 某台机器上某种卡的单价（scir-watch -s，只取价） */
export interface GpuPrice {
  host: string
  type: string
  /** 点/小时 */
  cost: number
  /** 该行给出的空闲卡数；仅供参考，不当库存真值 */
  freeGpus: number | null
  freeCpus: number | null
  freeMemoryGb: number | null
}
