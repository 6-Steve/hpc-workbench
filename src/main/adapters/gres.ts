/**
 * GRES 字符串解析。
 *
 * 关键事实（docs/03 §2.2）：**即使走了 JSON，`gres` 字段仍然是字符串**，不是结构体：
 *   gres      = "gpu:nvidia_h100_80gb_hbm3:2(S:1)"
 *   gres_used = "gpu:nvidia_h100_80gb_hbm3:1(IDX:0)"
 * 同一套语法、两种语义——括号里一个是 socket 绑定，一个是卡的索引列表。
 * 正则把括号整体排除，所以两种都能匹配，但**数量含义不同**，调用方不能混用。
 */
import type { GpuCount } from './types'

/** `gpu:<型号>:<数量>`，型号名里允许 `-` `_`，括号后缀整体忽略 */
const GRES_PATTERN = /gpu:([^:,()\s]+):(\d+)/g

/**
 * 解析成 `[{type, count}]`，同型号会合并求和。
 * 空串、`N/A`、没有 gpu: 前缀的内容一律返回空数组（不是错误）。
 */
export function parseGres(raw: string | null | undefined): GpuCount[] {
  if (!raw) return []
  const merged = new Map<string, number>()

  // 每次调用都要重置 lastIndex，否则复用同一个正则会漏匹配
  GRES_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = GRES_PATTERN.exec(raw)) !== null) {
    const type = match[1]
    const count = Number.parseInt(match[2] ?? '0', 10)
    if (!type || Number.isNaN(count)) continue
    merged.set(type, (merged.get(type) ?? 0) + count)
  }

  return [...merged.entries()].map(([type, count]) => ({ type, count }))
}

/** 总卡数（所有型号求和）；用于"这台机器有几张卡"这种粗口径展示 */
export function totalGpus(list: GpuCount[]): number {
  return list.reduce((sum, item) => sum + item.count, 0)
}

/**
 * 从 TRES 字符串里取**通用** GPU 张数。
 *
 *   `cpu=16,mem=64G,node=1,billing=16,gres/gpu=2,gres/gpu:a100-sxm4-80gb=2`  → 2
 *
 * 注意取的是 `gres/gpu=`（不带型号的那一项），它是总数；
 * 后面那个带型号的是同样的卡按型号再列一遍，**不能相加**。
 */
export function gpusFromTres(tres: string | null | undefined): number | null {
  if (!tres) return null
  const match = /(?:^|,)gres\/gpu=(\d+)/.exec(tres)
  if (!match) return null
  const value = Number.parseInt(match[1] ?? '', 10)
  return Number.isNaN(value) ? null : value
}

/**
 * 按型号计算空闲卡数。**必须按型号分别减**，不能先合总数再摊（docs/03 §5.1）。
 * 只出现在「已用」里的型号（理论上不该有）会以 0 总量出现，这里直接忽略。
 */
export function freeByType(total: GpuCount[], used: GpuCount[]): GpuCount[] {
  const usedMap = new Map(used.map((item) => [item.type, item.count]))
  return total.map((item) => ({
    type: item.type,
    count: Math.max(0, item.count - (usedMap.get(item.type) ?? 0))
  }))
}
