/**
 * `scir-watch -s` → 单价表。**只取价，不当库存真值**（docs/03 §5.0）。
 *
 * 这个输出是 Unicode 画的表格，两个坑：
 * 1. 分隔符混用：第一列用 `│`，后面用 `┆`，边框线用 `├╌╌┼╌╌┤`（不含竖线，正好可以靠这个跳过）
 * 2. 合并单元格：一个机型占多行，后续行的 GPU TYPE 与 COST 是空白，要 carry-forward
 */
import { fail, ok, type Adapter, type GpuPrice, type ParseResult } from './types'

export const GPU_PRICE_COMMAND = 'scir-watch -s'

/** 只按竖线切；边框行（├╌╌┼╌╌┤）里没有竖线，天然被排除 */
const CELL_SEPARATOR = /[│┆║]/

function parseCount(token: string | undefined): number | null {
  if (!token) return null
  const text = token.trim().replace(/,/g, '')
  if (!/^\d+$/.test(text)) return null
  const value = Number.parseInt(text, 10)
  return Number.isNaN(value) ? null : value
}

/** `102G` → 102，`1.5T` → 1536，`N/A` → null */
function parseMemoryGb(token: string | undefined): number | null {
  if (!token) return null
  const match = /^([\d.]+)\s*([KMGTP])?$/i.exec(token.trim())
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value)) return null
  const unit = (match[2] ?? 'G').toUpperCase()
  const toGb: Record<string, number> = { K: 1 / 1024 ** 2, M: 1 / 1024, G: 1, T: 1024, P: 1024 ** 2 }
  const factor = toGb[unit]
  return factor === undefined ? null : Math.round(value * factor * 100) / 100
}

export function parseGpuPrice(raw: string): ParseResult<GpuPrice[]> {
  if (raw.trim().length === 0) return fail('命令没有输出（可能不在 PATH 里）', raw)

  const lines = raw.split(/\r?\n/).filter((line) => CELL_SEPARATOR.test(line))
  if (lines.length === 0) return fail('输出里没有表格结构，格式可能变了', raw)

  const rows: GpuPrice[] = []
  let currentType = ''
  let currentCost: number | null = null
  let sawHeader = false
  let sawDataRow = false

  for (const line of lines) {
    const cells = line.split(CELL_SEPARATOR).map((cell) => cell.trim())
    // 行首与行尾各有一个空单元格（表格边框），去掉
    if (cells.length > 0 && cells[0] === '') cells.shift()
    if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop()
    if (cells.length < 6) continue

    if (cells[0]?.toUpperCase().includes('GPU TYPE')) {
      sawHeader = true
      continue
    }

    // 合并单元格：空值沿用上一行
    const type = cells[0] ?? ''
    if (type.length > 0) currentType = type

    const costText = cells[1] ?? ''
    if (costText.length > 0) {
      const parsed = Number(costText.replace(/,/g, ''))
      if (Number.isFinite(parsed)) currentCost = parsed
    }

    const host = cells[2] ?? ''
    if (host.length === 0) continue
    if (currentType.length === 0 || currentCost === null) {
      return fail('有名机但缺少机型或单价，且前面没有可沿用的值', raw)
    }

    sawDataRow = true
    rows.push({
      host,
      type: currentType,
      cost: currentCost,
      freeGpus: parseCount(cells[3]),
      freeCpus: parseCount(cells[4]),
      freeMemoryGb: parseMemoryGb(cells[5])
    })
  }

  if (!sawHeader) return fail('没找到表头 GPU TYPE，输出格式可能变了', raw)

  // 有表头但没有数据行 = 当前没有任何机型有空卡。这是正常状态，不是解析失败。
  if (!sawDataRow) return ok([])

  return ok(rows)
}

export const gpuPriceAdapter: Adapter<GpuPrice[]> = {
  name: 'gpu-price',
  command: GPU_PRICE_COMMAND,
  parse: parseGpuPrice
}
