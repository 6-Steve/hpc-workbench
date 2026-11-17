/**
 * 显卡单价与费用试算。
 *
 * `scir-watch -s` 的一个型号可能对应多行（每台机器一行），价格一般相同，
 * 但不排除不同机器定价不同。所以聚合时取**区间**而不是随便挑一个，
 * 否则用户看到"4 点/小时"，实际那台机器是 6 点，就坑了。
 */

/**
 * 价格入参。
 *
 * 只声明这里真正用到的三个字段，不引全局的 `GpuPrice`——
 * 这样这个模块不依赖任何 Electron/preload 类型，纯逻辑能单独测。
 */
export interface PriceInput {
  type: string
  /** 点/小时 */
  cost: number
  host?: string
}

export interface PriceRange {
  /** 最低单价（点/小时） */
  min: number
  /** 最高单价；和 min 相同表示全网统一价 */
  max: number
  /** 这个价格覆盖的机器数 */
  hostCount: number
  /** 有哪几台机器是这个价，方便用户挑 */
  hosts: string[]
}

/**
 * 按型号聚合成价格区间。
 *
 * 空价格列表返回空 Map（不是报错）——集群可能压根没装 scir-watch，
 * 那时候界面只是不显示价格，库存照样能用。
 */
export function priceByType(prices: PriceInput[]): Map<string, PriceRange> {
  const result = new Map<string, PriceRange>()

  for (const item of prices) {
    if (!Number.isFinite(item.cost) || item.cost < 0) continue

    const current = result.get(item.type)
    if (!current) {
      result.set(item.type, {
        min: item.cost,
        max: item.cost,
        hostCount: 1,
        hosts: item.host ? [item.host] : []
      })
      continue
    }

    current.min = Math.min(current.min, item.cost)
    current.max = Math.max(current.max, item.cost)
    current.hostCount += 1
    if (item.host) current.hosts.push(item.host)
  }

  return result
}

/** 价格区间转成一句话：`4 点/小时` 或 `4–6 点/小时` */
export function formatPrice(range: PriceRange | undefined): string {
  if (!range) return '—'
  if (range.min === range.max) return `${range.min} 点/小时`
  return `${range.min}–${range.max} 点/小时`
}

export interface CostEstimate {
  /** 单价（点/卡/小时） */
  unitCost: number
  gpus: number
  hours: number
  /** 总点数 */
  total: number
}

/**
 * 费用试算：单价 × 卡数 × 小时。
 *
 * 只做乘法，不掺任何"折扣/阶梯价"的想象——集群怎么算钱我们不知道，
 * 乱加规则比不给结论更糟。
 * 参数非法时返回 null，让界面显示"—"而不是 0（0 会被当成"免费"）。
 */
export function estimateCost(
  unitCost: number | null | undefined,
  gpus: number,
  hours: number
): CostEstimate | null {
  if (unitCost === null || unitCost === undefined) return null
  if (!Number.isFinite(unitCost) || unitCost < 0) return null
  if (!Number.isFinite(gpus) || gpus <= 0) return null
  if (!Number.isFinite(hours) || hours <= 0) return null

  return {
    unitCost,
    gpus: Math.floor(gpus),
    hours,
    total: Math.round(unitCost * Math.floor(gpus) * hours * 100) / 100
  }
}

/** 总点数格式化：整数不带小数点，小数保留两位 */
export function formatPoints(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}
