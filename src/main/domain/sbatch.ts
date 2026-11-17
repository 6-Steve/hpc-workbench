/**
 * 把界面上的几个选项拼成一份 sbatch 脚本。
 *
 * 设计原则：**生成的脚本要能直接看懂、直接改**。
 * 不是在后台偷偷拼一堆参数然后提交——用户得知道交上去的到底是什么，
 * 否则出了问题（跑错分区、时限太短被砍）根本没法排查。
 *
 * 预览界面里脚本是可编辑的，所以这里只要给出一个合理的起点就行。
 *
 * ⚠️ **本文件被渲染层直接引用**（`SubmitSbatchDialog` 生成预览要即时，走 IPC 太绕）。
 * 所以这里**只能放纯函数，绝对不能 import 任何 Node / Electron API**——
 * 渲染层没有 `fs`、没有 `path`、没有 `process`，加了就是白屏。
 * 需要碰系统的地方一律往上提到 ipc 层。
 */

export interface JobSpec {
  jobName: string
  partition: string
  /** 节点数 */
  nodes: number
  /** 每个节点的任务数，一般就是 1 */
  tasksPerNode: number
  /** 每个任务的核数 */
  cpusPerTask: number
  /** **每个节点**申请几张卡（sbatch 的 --gres 是每节点语义，不是总数） */
  gpusPerNode: number
  /** 指定卡型号；null = 不限定，调度器给什么用什么 */
  gpuType?: string | null
  /**
   * 指定机器（`--nodelist`）；null = 让调度器自己挑。
   *
   * 用途：同一个型号下几台机器的剩余资源差别很大（有的卡闲着但核满了），
   * 用户看完「机器明细」往往就想钉死在某一台上。
   */
  node?: string | null
  /** 每节点内存（MB）；null = 不写 --mem，交给集群默认 */
  memoryMb?: number | null
  /** 时限（分钟） */
  timeLimitMinutes: number
  /** 输出文件名模板，默认 `%x-%j.out`（作业名-作业号） */
  outputPattern: string
  /** 工作目录；null = 不写 --chdir，用提交时所在目录 */
  workDir?: string | null
  /** 要执行的命令（命令模式） */
  command: string
  /** 环境准备片段（module load / conda activate），原样放进脚本 */
  envSetup?: string
  /** 额外的 #SBATCH 指令，一行一条，不含 `#SBATCH ` 前缀 */
  extraDirectives?: string
}

/**
 * 生成 `--gres` 参数；**0 卡时返回 null，表示根本不写这一行**。
 *
 * 三种情况：
 * - 0 张卡（纯 CPU 作业）：**不写 `--gres`**
 * - 不指定型号：`gpu:2` —— 调度器给什么卡用什么卡
 * - 指定型号：`gpu:nvidia_a100_80gb_pcie:2` —— 只跑在这种卡上
 *
 * ⚠️ 0 卡绝不能写成 `--gres=gpu:0`：实测集群直接拒绝，
 * 报 `tres format not match: gres:gpu:0 (scir extension)!`。
 * 这个错误很隐蔽——参数看着合理，但 scir 扩展不认这种写法。
 *
 * 指定型号很重要：用户从"资源"页点「租这个 A100」进来，
 * 结果跑在 V100 上，那就是功能性错误而不只是体验问题。
 */
function gresDirective(spec: JobSpec): string | null {
  const count = Math.max(0, Math.floor(spec.gpusPerNode))
  if (count === 0) return null

  const type = spec.gpuType?.trim()
  return type ? `--gres=gpu:${type}:${count}` : `--gres=gpu:${count}`
}

/**
 * 节点名的合法字符集。
 *
 * 这个值会拼进 sbatch 参数，虽然 IPC 那边每个参数都过 `shq()`，
 * 但**不要依赖下游转义**——校验放在生成这一层，非法值直接不生成，
 * 免得带进一个看不懂的 sbatch 报错。
 *
 * 实测 `-w gpu09` 和 `--nodelist=gpu09` 都被接受，统一用后者的 `=` 风格，
 * 和其它指令保持一致。
 */
export function isValidNodeName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(name)
}

function nodeDirective(spec: JobSpec): string | null {
  const node = spec.node?.trim()
  if (!node) return null
  return isValidNodeName(node) ? `--nodelist=${node}` : null
}

/** 分钟 → `D-HH:MM:SS` / `HH:MM:SS`，跟 sbatch 的 --time 语法一致 */
export function formatSbatchTime(minutes: number): string {
  const total = Math.max(1, Math.floor(minutes))
  const days = Math.floor(total / 1440)
  const hours = Math.floor((total % 1440) / 60)
  const mins = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')

  const clock = `${pad(hours)}:${pad(mins)}:00`
  return days > 0 ? `${days}-${clock}` : clock
}

/** MB → `96G` 这种人能读的形式（sbatch 接受 G/M 后缀） */
export function formatSbatchMemory(memoryMb: number): string {
  const mb = Math.max(1, Math.round(memoryMb))
  if (mb >= 1024 && mb % 1024 === 0) return `${mb / 1024}G`
  return `${mb}M`
}

/**
 * 生成脚本正文。
 *
 * 几个刻意的选择：
 * - 环境准备放在注释里（`# module load ...`）。**不默认启用**：
 *   猜错 module 名字会让作业一起手就失败，比让用户自己填更糟。
 * - 头部固定 `set -e`，脚本里某条命令失败就停下来，
 *   否则中间步骤挂了后面照样跑，最后得到一个"成功"的假象。
 * - 保留一个 `echo` 打印节点名，出问题时能立刻知道跑在哪台机器上。
 */
export function buildSbatchScript(spec: JobSpec): string {
  const lines: string[] = ['#!/bin/bash', 'set -e', '']

  const directives: string[] = [
    `--job-name=${spec.jobName}`,
    `--partition=${spec.partition}`,
    `--nodes=${spec.nodes}`,
    `--tasks-per-node=${spec.tasksPerNode}`,
    `--cpus-per-task=${spec.cpusPerTask}`,
    `--time=${formatSbatchTime(spec.timeLimitMinutes)}`,
    `--output=${spec.outputPattern}`
  ]

  // 0 卡作业没有 --gres 这一行
  const gres = gresDirective(spec)
  if (gres) directives.splice(5, 0, gres)

  // 指定机器：放在 --gres 后面，读起来是"哪个型号的哪台机器"
  const nodelist = nodeDirective(spec)
  if (nodelist) directives.splice(gres ? 6 : 5, 0, nodelist)

  if (spec.memoryMb !== null && spec.memoryMb !== undefined) {
    directives.push(`--mem=${formatSbatchMemory(spec.memoryMb)}`)
  }
  if (spec.workDir) {
    directives.push(`--chdir=${spec.workDir}`)
  }

  for (const directive of directives) {
    lines.push(`#SBATCH ${directive}`)
  }

  const extra = (spec.extraDirectives ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  for (const line of extra) {
    // 用户可能连 "#SBATCH" 一起粘进来，剥掉避免出现 "#SBATCH #SBATCH"
    lines.push(`#SBATCH ${line.replace(/^#SBATCH\s*/i, '')}`)
  }

  lines.push('')
  lines.push('# —— 环境准备（按需取消注释并改成你自己的）——')

  const env = (spec.envSetup ?? '').trim()
  if (env.length > 0) {
    lines.push(...env.split(/\r?\n/))
  } else {
    lines.push('# module load cuda/12.1')
    lines.push('# conda activate myenv')
  }

  lines.push('')
  lines.push('# —— 作业命令 ——')
  lines.push('echo "node=$(hostname)  job=${SLURM_JOB_ID}"')
  lines.push(spec.command.trim())

  return lines.join('\n') + '\n'
}

/**
 * 「用已有脚本」模式：不生成新脚本，直接用 sbatch 带着参数提交那个文件。
 *
 * 参数会和脚本里的 `#SBATCH` 合并，命令行优先级更高——这是 SLURM 的规则，
 * 所以用户在界面上填的卡数/时限会覆盖脚本里原有的设置。
 */
export function buildSbatchArguments(spec: JobSpec): string[] {
  const args = [
    `--job-name=${spec.jobName}`,
    `--partition=${spec.partition}`,
    `--nodes=${spec.nodes}`,
    `--tasks-per-node=${spec.tasksPerNode}`,
    `--cpus-per-task=${spec.cpusPerTask}`,
    `--time=${formatSbatchTime(spec.timeLimitMinutes)}`,
    `--output=${spec.outputPattern}`
  ]

  const gres = gresDirective(spec)
  if (gres) args.splice(5, 0, gres)

  const nodelist = nodeDirective(spec)
  if (nodelist) args.splice(gres ? 6 : 5, 0, nodelist)

  if (spec.memoryMb !== null && spec.memoryMb !== undefined) {
    args.push(`--mem=${formatSbatchMemory(spec.memoryMb)}`)
  }
  if (spec.workDir) {
    args.push(`--chdir=${spec.workDir}`)
  }

  return args
}

/** 唯一的命令前缀；submit 时拼在参数后面 */
export const SBATCH_COMMAND = 'sbatch'

/**
 * 从 `Submitted batch job 12345` 里取作业号。
 * 取不到就返回 null——不能瞎编一个"0"，那会让用户以为交上去了。
 */
export function parseSubmittedJobId(stdout: string): string | null {
  const match = /Submitted batch job (\d+)/i.exec(stdout)
  return match?.[1] ?? null
}

/**
 * 把 sbatch 的报错翻译成人话。
 *
 * 起因：真实提交时报了
 * `total cpus num(8) > tres total num(1) * cpu_limit(4) (scir extension)`——
 * 集群有个配比限制：**每张卡最多配 4 个核**。这行字对新用户等于没说，
 * 他不知道自己该改哪个数。
 *
 * 这里把常见几种错误（配比超限、分区不存在、QOS 超限、资源不足）
 * 翻译成"你应该改什么"。认不出来就返回 null，让界面显示原始输出——
 * 不认识的错误不要硬编一个解释，那比不解释更误导。
 */
export function explainSbatchError(stderr: string): string | null {
  if (!stderr.trim()) return null

  // 0. scir 扩展要求 --gres 必须写型号（实测 `--gres=gpu:1` 会被拒）
  const gresFormat = /tres format not match:\s*gres?:\S*\s*\(scir extension\)/i.exec(stderr)
  if (gresFormat) {
    return (
      '显卡必须写明型号，不能只写张数（本集群的 scir 扩展限制）。' +
      '在「显卡型号」里选一个具体型号，或者在资源页对某个型号点「租这个」自动带上。'
    )
  }

  // 1. 核数 / 卡数配比超限（本集群的 scir 扩展）
  const ratio = /total cpus num\((\d+)\)\s*>\s*tres total num\((\d+)\)\s*\*\s*cpu_limit\((\d+)\)/i.exec(stderr)
  if (ratio) {
    const cpus = Number(ratio[1])
    const gpus = Number(ratio[2])
    const limit = Number(ratio[3])
    const maxCpus = gpus * limit
    return (
      `申请了 ${cpus} 个核，但 ${gpus} 张卡最多只能配 ${maxCpus} 个核（每卡 ${limit} 核，这是本集群的配比限制）。` +
      `把核数改成 ${maxCpus} 或更少，或者把卡数加到 ${Math.ceil(cpus / limit)} 张以上。`
    )
  }

  // 2. 分区名写错
  if (/invalid partition name/i.test(stderr)) {
    const name = /invalid partition name\s*[:=]?\s*(\S+)/i.exec(stderr)?.[1]
    return `分区名${name ? `「${name}」` : ''}不存在。去资源页看看有哪些分区，或者用 sinfo 查一下。`
  }

  // 3. 卡不够 / 资源不足
  if (/Requested node configuration is not available|Node configuration is not available/i.test(stderr)) {
    return '集群现在凑不出你要的资源组合（卡数太多、或者这种卡刚好被占满）。把卡数调小，或者过一会儿再交。'
  }

  // 4. 超过账户配额 / QOS
  if (/AssocGrpGRES|QOSMaxGRES|AssocMaxGRESPerJob|Job violates accounting/i.test(stderr)) {
    return '超过了账户允许的上限（卡数或核数配额）。查一下你的账户配额，或者把申请量调小。'
  }

  // 5. 时限超过分区限制
  if (/Invalid time limit|time limit.*exceed/i.test(stderr)) {
    return '时限超过了这个分区允许的最大值。把时间调短一点。'
  }

  return null
}

export interface DryRunResult {
  /**
   * 预计开始时间，**保留集群返回的原始字符串**（如 `2026-11-03T08:45:28`）。
   *
   * 故意不转 Date：这个时间没有带时区，是集群本地时间。
   * 在客户端 `new Date(...)` 会按本机时区解释，差几个时区就全错了。
   * 界面上直接显示时分就够了。
   */
  startAt: string | null
  nodes: string | null
  processors: number | null
}

/**
 * 解析 `sbatch --test-only` 的输出：
 *
 * ```
 * sbatch: Job 208893 to start at 2026-11-03T08:45:28 using 2 processors on nodes gpu05 in partition compute
 * ```
 *
 * 注意：**`--test-only` 不检查集群扩展的限制**（实测 1 卡 8 核它照样放行，
 * 真实提交才被拒），所以这里给出的时间只是"资源上大概什么时候排得到"，
 * 不代表一定能提交成功。
 */
export function parseTestOnlyOutput(stdout: string): DryRunResult {
  const match = /to start at ([\d-]+T[\d:]+) using (\d+) processors? on nodes? (\S+)/i.exec(stdout)
  if (!match) return { startAt: null, nodes: null, processors: null }

  return {
    startAt: match[1] ?? null,
    processors: match[2] ? Number(match[2]) : null,
    nodes: match[3] ?? null
  }
}

/**
 * 把集群给的排程时间转成人能读的一句话。
 *
 * 起因：界面原来只显示 `slice(11,16)` 的时分，用户看到「02:26」得自己推断
 * 是今天还是明天——实际是明天凌晨，他就懵了。
 *
 * 两个信息缺一不可：
 * - **日期**：跨天时必须看得见，否则 02:26 到底是哪个 02:26 说不清
 * - **还有多久**："15 小时后"比 "02:26" 更容易判断这件事急不急
 *
 * 注意：这个时间串是**集群本地时间**（实测集群 TZ 是 Asia/Shanghai）。
 * 如果集群在别的时区，`new Date()` 会按本机时区解释，"还有多久"会偏，
 * 但绝对日期时间仍然是对的——用户自己能看出来。
 */
export function describeStartTime(startAt: string, now = Date.now()): string {
  const parsed = new Date(startAt)
  if (Number.isNaN(parsed.getTime())) return startAt

  const pad = (n: number): string => String(n).padStart(2, '0')
  const absolute = `${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`

  const diffMinutes = Math.round((parsed.getTime() - now) / 60000)
  if (diffMinutes <= 1) return `${absolute}（马上）`
  if (diffMinutes < 60) return `${absolute}（约 ${diffMinutes} 分钟后）`

  const hours = Math.floor(diffMinutes / 60)
  if (hours < 24) {
    const rest = diffMinutes % 60
    return `${absolute}（约 ${hours} 小时${rest > 0 ? ` ${rest} 分` : ''}后）`
  }

  const days = Math.floor(hours / 24)
  return `${absolute}（约 ${days} 天后）`
}
