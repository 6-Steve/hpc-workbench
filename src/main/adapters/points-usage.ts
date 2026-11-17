/**
 * `scir-account details [-r]` → 点数消耗明细。
 *
 * 实测输出（2026-11-05，`login-01`）：
 *
 * ```
 * ╭────────┬────────────┬──────┬────────────┬────────╮
 * │ JID    ┆ Job Name   ┆ Time ┆ Time Limit ┆ Points │
 * ╞════════╪════════════╪══════╪════════════╪════════╡
 * │ 208896 ┆ train      ┆ 0.00 ┆ 2.00       ┆ 0.00   │
 * ├╌╌╌╌╌╌╌╌┼╌╌╌╌╌╌╌╌╌╌╌╌┼╌╌╌╌╌╌┼╌╌╌╌╌╌╌╌╌╌╌╌┼╌╌╌╌╌╌╌╌┤
 * │ 211439 ┆ notifytest ┆ 0.00 ┆ 0.08       ┆ 0.01   │
 * ╰────────┴────────────┴──────┴────────────┴────────╯
 * Total: 5200.00 Used: 0.02 Avail: 5199.98
 * ```
 *
 * 加 `-r` 会多一列 Resources：
 *
 * ```
 * │ JID ┆ Job Name ┆ Resources ┆ Time(H) ┆ Time Limit(H) ┆ Points │
 * ```
 *
 * ⚠️ **注意不加 `-r` 时表头仍是 `Time` / `Time Limit`，加 `-r` 才变成 `Time(H)` /
 * `Time Limit(H)`**。两者单位都是**小时**（实测：0.17 对应 10 分钟的作业）。
 * 也就是说表头不加 `(H)` 不代表单位是分钟——不要按表头猜单位。
 *
 * ## 三个必须按表头解、不能写死列号的原因
 *
 * 1. 有 5 列 / 6 列两种形态，`Points` 在最后一列但 `Resources` 是长文本
 * 2. `Resources` 列里可能有**逗号**（`billing(0)=4, cpu(0.05)=4, …`），
 *    按逗号切行会立刻炸
 * 3. `Job Name` 可能含空格
 *
 * ## 另一个坑：Resources 列顺序不固定
 *
 * 同一个作业的两次输出，`billing` / `cpu` / `mem` / `node` / `gpu` 的排列顺序**每次都不一样**
 * （实测 208896 与 208899 的顺序就不同，看起来是 HashMap 迭代序）。
 * 所以解析 Resources 必须用 `k=v` 键值对，**绝不能按位置取**。
 */
import { fail, ok, type Adapter, type ParseResult } from './types'
import { parsePoints, POINTS_PATTERN } from './points'

/** 一条消耗记录 = 一个作业 */
export interface PointsUsageRow {
  /** 作业号，字符串（scontrol 里它是数字，这里统一成 string 免得精度和类型反复转换） */
  jobId: string
  jobName: string
  /** 实际计费时长（小时）。运行中的作业是"到目前为止" */
  hours: number
  /** 申请的时长上限（小时） */
  limitHours: number
  /** 这个作业扣的点数 */
  points: number
  /** `-r` 才有的原始 Resources 串；没有 `-r` 时为 null */
  resources: string | null
  /** 从 Resources 里抠出来的 GPU 型号（拿不到为 null） */
  gpuType: string | null
  /** 从 Resources 里抠出来的 GPU 张数 */
  gpuCount: number | null
  /** Resources 里的 billing 值（SLURM 的计费权重，不是点数） */
  billing: number | null
}

export interface PointsUsage {
  rows: PointsUsageRow[]
  /** 表尾那行汇总，和 `scir-account -d` 同格式；解析不出来时为 null */
  totals: { total: number; used: number; avail: number } | null
  /**
   * 逐条相加得到的已扣点数，以及它与 `totals.used` 的差值。
   *
   * ⚠️ **差值非零是正常的，不是解析错误**。每条记录只给到 2 位小数，
   * 19 个作业逐个四舍五入后再相加，和"先求和再四舍五入"必然对不上
   * （实测：逐条相加 0.01，表尾 Used 0.02）。
   *
   * 所以界面**必须**把两个数分开展示，且不能提示"数据不一致"——
   * 那会让用户以为程序算错了，其实是平台自己的舍入。只在展开明细时
   * 用一行小字说明，不在主视图上报警。
   */
  sum: { points: number; diff: number | null }
}

export const USAGE_COMMAND = 'scir-account details -r'
export const USAGE_COMMAND_PLAIN = 'scir-account details'

/** 表头里对得上的列名 → 归一化字段。比对时统一小写、去空白 */
const HEADER_ALIASES: Record<string, keyof ColumnMap> = {
  jid: 'jobId',
  'job id': 'jobId',
  jobname: 'jobName',
  'job name': 'jobName',
  resources: 'resources',
  time: 'hours',
  'time(h)': 'hours',
  'time (h)': 'hours',
  timelimit: 'limitHours',
  'time limit': 'limitHours',
  'time limit(h)': 'limitHours',
  'time limit (h)': 'limitHours',
  points: 'points'
}

interface ColumnMap {
  jobId: number
  jobName: number
  resources: number
  hours: number
  limitHours: number
  points: number
}

/**
 * 拆一行表格。
 *
 * 分隔符实测是 `│`（U+2502）和 `┆`（U+2506）**混用**——表头里第一列用 `│`、
 * 后面用 `┆`。按 `[│┆]` 一起切，切完去掉首尾的空段（行首行尾各有一个分隔符）。
 */
function splitRow(line: string): string[] | null {
  if (!/[│┆]/.test(line)) return null
  // 行首是边框、行尾是边框，所以切完首尾各有一段空字符串
  const cells = line.split(/[│┆]/).map((cell) => cell.trim())
  if (cells.length < 2) return null
  return cells.slice(1, -1)
}

/** 边框行（`╭─┬─╮` / `├╌┼╌┤` / `╰─┴─╯` / `╞═╪═╡`）：全是框线字符和空白 */
function isBorder(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed.length === 0) return true
  return !/[0-9A-Za-z\u4e00-\u9fa5]/.test(trimmed)
}

/**
 * 从 Resources 串里抠 GPU。
 *
 * 真实形态：`billing(0)=4, cpu(0.05)=4, node(0)=1, mem(0)=16384, gpu:tesla_v100-sxm2-16gb(4)=1`
 * - 型号在 `gpu:` 之后、`(` 之前
 * - 张数是最后一个 `=` 之后
 * - **各字段顺序每次不同**，所以只能逐个 `k=v` 扫
 */
function parseResources(text: string): {
  gpuType: string | null
  gpuCount: number | null
  billing: number | null
} {
  let gpuType: string | null = null
  let gpuCount: number | null = null
  let billing: number | null = null

  for (const part of text.split(',')) {
    const trimmed = part.trim()
    const eq = trimmed.lastIndexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()

    if (key.startsWith('gpu:')) {
      // `gpu:tesla_v100-sxm2-16gb(4)` → 去掉末尾的重量系数括号
      gpuType = key.slice(4).replace(/\([^)]*\)$/, '').trim()
      const count = Number(value)
      if (Number.isFinite(count)) gpuCount = count
    } else if (key.startsWith('billing')) {
      // 实际 key 是 `billing(0)`——括号里是 SLURM 的权重系数，不能拿全等去比
      const parsed = Number(value)
      if (Number.isFinite(parsed)) billing = parsed
    }
  }

  return { gpuType, gpuCount, billing }
}

export function parseUsageTable(raw: string): ParseResult<PointsUsage> {
  if (raw.trim().length === 0) {
    return fail('命令没有输出（可能不在 PATH 里）', raw)
  }

  const lines = raw.split(/\r?\n/)
  const columns: Partial<ColumnMap> = {}
  const rows: PointsUsageRow[] = []
  let sawHeader = false
  let sawTable = false

  for (const line of lines) {
    const cells = splitRow(line)
    if (cells === null) continue
    if (isBorder(line)) continue

    if (!sawHeader) {
      // 表头：按名字对列，对不上的位置记为 -1（下面用得到的最低列数做校验）
      let matched = 0
      cells.forEach((cell, index) => {
        const key = HEADER_ALIASES[cell.toLowerCase().replace(/\s+/g, ' ')]
        if (key) {
          columns[key] = index
          matched += 1
        }
      })
      // 至少要认出 JID / Job Name / Points 三列才算表头，否则是别的输出
      if (matched >= 3 && columns.jobId !== undefined && columns.points !== undefined) {
        sawHeader = true
        sawTable = true
      }
      continue
    }

    const jobId = cells[columns.jobId!]?.trim()
    if (!jobId || !/^\d+$/.test(jobId)) continue // 保险：非作业号的行（表尾等）跳过

    const number = (index: number | undefined): number => {
      if (index === undefined) return 0
      const value = Number((cells[index] ?? '').replace(/,/g, ''))
      return Number.isFinite(value) ? value : 0
    }

    const resources = columns.resources !== undefined ? (cells[columns.resources] ?? '').trim() : null
    const gpu = resources ? parseResources(resources) : { gpuType: null, gpuCount: null, billing: null }

    rows.push({
      jobId,
      jobName: (cells[columns.jobName!] ?? '').trim(),
      hours: number(columns.hours),
      limitHours: number(columns.limitHours),
      points: number(columns.points),
      resources: resources && resources.length > 0 ? resources : null,
      gpuType: gpu.gpuType,
      gpuCount: gpu.gpuCount,
      billing: gpu.billing
    })
  }

  if (!sawTable) {
    return fail('没找到消耗明细表（表头对不上：期望 JID / Job Name / Points 这几列）', raw)
  }

  // 表尾汇总行单独取，和表格分开（它是 `Total: x Used: y Avail: z` 纯文本）
  const totalsMatch = new RegExp(`^.*${POINTS_PATTERN.source}.*$`, 'im').exec(raw)
  let totals: PointsUsage['totals'] = null
  if (totalsMatch) {
    const parsed = parsePoints(totalsMatch[0])
    if (parsed.ok) totals = parsed.data
  }

  // 逐条相加。保留两位小数是为了和表尾格式一致（不做舍入就会得到 0.010000000000000009）
  const sumPoints = Math.round(rows.reduce((acc, row) => acc + row.points, 0) * 100) / 100
  const sum = {
    points: sumPoints,
    diff: totals === null ? null : Math.round((totals.used - sumPoints) * 100) / 100
  }

  // 空表（只有表头和边框、没有任何作业）是**合法**的，不是失败：
  // 新账号还没跑过作业就是这个样子
  return ok({ rows, totals, sum })
}

export const pointsUsageAdapter: Adapter<PointsUsage> = {
  name: 'points-usage',
  command: USAGE_COMMAND,
  parse: parseUsageTable
}
