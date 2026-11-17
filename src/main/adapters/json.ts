/**
 * SLURM `--json` 输出的通用处理（docs/03 §3.0）。
 *
 * 四条命令的信封是同一个形状：`{ meta, <数据>, warnings, errors }`。
 * 数值字段普遍包一层 `{ set, infinite, number }`——这一层是本文件存在的主要理由。
 */
import { fail, ok, type ParseResult } from './types'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 解析成对象；失败时把出错位置附近的内容带出来，别只说"JSON 解析失败" */
export function parseJsonObject(raw: string): ParseResult<Record<string, unknown>> {
  const text = raw.trim()
  if (text.length === 0) return fail('命令没有输出', raw)

  // 压根不是 JSON：多半是命令不认识 --json，或者直接报错了。
  // 这种情况要说清楚，不能笼统报"解析失败"，更不能误报"被截断"。
  if (!text.startsWith('{') && !text.startsWith('[')) {
    return fail('输出不是 JSON（命令可能不支持 --json，或直接报错了）', raw)
  }

  // 以 { 开头却没收尾，才是真的被截断（sacct 可能几 MB，超过 maxBytes 会被客户端截掉）
  if (!text.endsWith('}') && !text.endsWith(']')) {
    return fail('输出不完整，可能被截断或命令中途退出', raw)
  }

  try {
    const value: unknown = JSON.parse(text)
    if (!isRecord(value)) return fail('输出不是 JSON 对象', raw)
    return ok(value)
  } catch (err) {
    return fail(`JSON 解析失败：${(err as Error).message}`, raw)
  }
}

/**
 * 解包 `{ set, infinite, number }`。
 * `set: false` 是旧格式里的 `N/A`——返回 null，绝不能当 0。
 */
export function optNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (!isRecord(value)) return null
  if (value['set'] !== true) return null
  const n = value['number']
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/** 这个数值字段是不是"无上限"（例如 time_limit=UNLIMITED） */
export function isInfinite(value: unknown): boolean {
  return isRecord(value) && value['infinite'] === true
}

export function optString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

export function asStringArray(value: unknown): string[] {
  return asArray<unknown>(value)
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

/**
 * 信封里的 `errors` 非空就是失败，哪怕退出码是 0（docs/03 §3.0 ①）。
 * 返回给人看的一行摘要；没有错误时返回 null。
 */
export function envelopeErrors(object: Record<string, unknown>): string | null {
  const errors = asArray<unknown>(object['errors'])
  if (errors.length === 0) return null
  const messages = errors.map((item) => {
    if (typeof item === 'string') return item
    if (isRecord(item)) {
      const description = optString(item['description']) ?? optString(item['message'])
      if (description) return description
      const code = item['error_code']
      if (typeof code === 'number') return `错误码 ${code}`
    }
    return JSON.stringify(item)
  })
  return messages.join('；')
}

/** 取数据数组，key 因命令而异（sinfo / nodes / jobs） */
export function dataArray(object: Record<string, unknown>, key: string): Record<string, unknown>[] {
  return asArray<unknown>(object[key]).filter(isRecord)
}
