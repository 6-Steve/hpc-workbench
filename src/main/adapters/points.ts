/**
 * `scir-account -d` → 点数额度。
 *
 * 实测输出只有一行：`Total: 5200.00 Used: 683.46 Avail: 4516.54`
 * 全项目最好解析的一个数据源，所以拿它当 Adapter 的样板。
 */
import { fail, ok, type Adapter, type ParseResult, type Points } from './types'

export const POINTS_COMMAND = 'scir-account -d'

/**
 * 允许千分位逗号与前后空白；三个字段必须齐。
 *
 * 导出是为了给 `points-usage.ts` 复用：`details` 的表尾那行汇总和 `-d` 是同一个格式，
 * 两处各写一份正则是迟早要分叉的。
 */
export const POINTS_PATTERN = /Total:\s*([\d,]+(?:\.\d+)?)\s+Used:\s*([\d,]+(?:\.\d+)?)\s+Avail:\s*([\d,]+(?:\.\d+)?)/i

function toNumber(token: string | undefined): number | null {
  if (token === undefined) return null
  const value = Number(token.replace(/,/g, ''))
  return Number.isFinite(value) ? value : null
}

export function parsePoints(raw: string): ParseResult<Points> {
  if (raw.trim().length === 0) return fail('命令没有输出（可能不在 PATH 里）', raw)

  const match = POINTS_PATTERN.exec(raw)
  if (!match) {
    return fail('没找到 Total / Used / Avail 三个字段，输出格式可能变了', raw)
  }

  const total = toNumber(match[1])
  const used = toNumber(match[2])
  const avail = toNumber(match[3])
  if (total === null || used === null || avail === null) {
    return fail('三个字段里有解析不出来的数字', raw)
  }

  return ok({ total, used, avail })
}

export const pointsAdapter: Adapter<Points> = {
  name: 'points',
  command: POINTS_COMMAND,
  parse: parsePoints
}
