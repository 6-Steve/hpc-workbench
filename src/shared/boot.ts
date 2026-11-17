/**
 * 启动页用的数据契约（shared：主进程与渲染层各自打包一份，形状必须一致）。
 *
 * 为什么单独做一份而不是复用 `ProbeResponse`：探针要跑 9 条命令、约 2–4 秒，
 * 是"深入体检"；启动页只需要**够它走完三步**的最小信息，必须快
 * （整个启动页的存在意义就是把那 1–3 秒的空白变成有用信息，不能自己成为瓶颈）。
 *
 * 所以这里只发两条命令：一条 `echo` 拿 hostname/user，一条 `squeue` 拿队列。
 * 连接本身复用连接池，通常已经在握手中，实际耗时远小于探针。
 */
export type BootPhase = 'config' | 'connect' | 'queue'

export interface BootStep {
  phase: BootPhase
  ok: boolean
  /** 一句话结论，直接显示在启动页上 */
  message: string
  /** 失败时的下一步建议。成功时为空 */
  hint?: string
  /** 从开始执行到这一步结束的毫秒数 */
  ms: number
}

export interface BootStatus {
  /** 三步全过 = true。任何一步失败都会停在那一phase，后面的不执行 */
  ok: boolean
  steps: BootStep[]
  /** 连接成功时的目标，显示成 `user@host` */
  target?: string
  /** 当前队列里的作业数（running / pending / 总数），队列阶段成功才有 */
  queue?: { total: number; running: number; pending: number }
  /** 从启动页开始到结束的总耗时 */
  totalMs: number
  /** 失败时的原始输出，供「看原始输出」折叠块使用 */
  raw?: string
}

/** 启动页最多等这么久就自动放行进主界面（用户还可以提前按 Esc） */
export const BOOT_TIMEOUT_MS = 8000
