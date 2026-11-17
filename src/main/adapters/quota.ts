/**
 * `mmlsquota --block-size auto` → 存储配额（容量 + 文件数双维度）。
 *
 * 三条实测得来的规则（docs/03 §3.6）：
 * 1. 一次返回**两个独立配额**，用 `|` 分隔，必须先切两段再各自按空白切
 * 2. 容量列带单位后缀（`90.72G` / `6T`），文件数列是**裸整数**，两套规则不能混
 * 3. `in_doubt` 非零是正常的（有写入未结算），不是错误
 */
import { fail, ok, type Adapter, type ParseResult, type Quota, type QuotaDimension } from './types'

/** 必须绝对路径：裸命令不在 PATH 里（docs/03 §0①） */
export const QUOTA_COMMAND = '/usr/lpp/mmfs/bin/mmlsquota --block-size auto'

const UNITS: Record<string, number> = {
  '': 1,
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
  P: 1024 ** 5
}

/**
 * 解析带单位后缀的数值：`90.72G` → 字节数，`371288` → 371288。
 * `none` / `N/A` / `-` 返回 null（表示没设限额），不是 0。
 */
export function parseSize(token: string | undefined): number | null {
  if (!token) return null
  const text = token.trim()
  if (text.length === 0) return null
  if (/^(none|n\/a|-|\*)$/i.test(text)) return null

  const match = /^([\d,]+(?:\.\d+)?)([KMGTP])?$/i.exec(text)
  if (!match) return null

  const value = Number((match[1] ?? '').replace(/,/g, ''))
  if (!Number.isFinite(value)) return null

  const unit = (match[2] ?? '').toUpperCase()
  const multiplier = UNITS[unit]
  if (multiplier === undefined) return null

  return Math.round(value * multiplier)
}

/**
 * 解析 grace 列。
 * 平时是 `none`，超额后变成 `7 days` 这种**两个 token**，过期变 `expired`——
 * 所以不能简单取"第 N 个 token"，要把剩余部分拼回来再按需拆 Remarks。
 */
function parseGrace(tokens: string[]): { grace: string; rest: string[] } {
  const first = (tokens[0] ?? '').trim()
  if (first.length === 0) return { grace: 'none', rest: [] }

  if (/^(none|expired)$/i.test(first)) return { grace: first.toLowerCase(), rest: tokens.slice(1) }

  // `7 days` / `1 day`
  const second = (tokens[1] ?? '').trim()
  if (/^\d+$/.test(first) && /^days?$/i.test(second)) {
    return { grace: `${first} ${second.toLowerCase()}`, rest: tokens.slice(2) }
  }

  return { grace: first, rest: tokens.slice(1) }
}

/**
 * 解析一个维度：`used, quota, limit, in_doubt, grace[, 备注…]`。
 * 返回剩余的 token，供调用方接着当 Remarks。
 */
function dimension(tokens: string[]): { dim: QuotaDimension; rest: string[] } | null {
  const used = parseSize(tokens[0])
  if (used === null) return null

  const { grace, rest } = parseGrace(tokens.slice(4))

  return {
    dim: {
      used,
      soft: parseSize(tokens[1]),
      hard: parseSize(tokens[2]),
      inDoubt: parseSize(tokens[3]) ?? 0,
      grace
    },
    rest
  }
}

export function parseQuota(raw: string): ParseResult<Quota[]> {
  if (raw.trim().length === 0) return fail('命令没有输出（多半是路径不对或没有权限）', raw)

  const quotas: Quota[] = []
  let sawDataLine = false

  for (const line of raw.split(/\r?\n/)) {
    if (!line.includes('|')) continue

    const [left = '', right = ''] = line.split('|')
    const leftTokens = left.trim().split(/\s+/).filter(Boolean)
    const rightTokens = right.trim().split(/\s+/).filter(Boolean)

    // 表头行：`Filesystem type blocks quota ...`，正好也是 7 个 token，必须显式排除
    if (/^(filesystem|block limits)$/i.test(leftTokens[0] ?? '')) continue
    if (leftTokens.length < 7 || rightTokens.length < 5) continue

    sawDataLine = true

    // 左侧：fs, type, 然后才是 used/quota/limit/in_doubt/grace
    const bytes = dimension(leftTokens.slice(2))
    // 右侧：used/quota/limit/in_doubt/grace + 可选 Remarks
    const files = dimension(rightTokens)
    if (!bytes || !files) {
      return fail('配额行的数字解析失败，输出格式可能变了', raw)
    }

    quotas.push({
      filesystem: leftTokens[0] ?? '',
      type: leftTokens[1] ?? '',
      bytes: bytes.dim,
      files: files.dim,
      remarks: files.rest.join(' ').trim()
    })
  }

  if (!sawDataLine) return fail('没有找到任何配额数据行', raw)
  return ok(quotas)
}

export const quotaAdapter: Adapter<Quota[]> = {
  name: 'quota',
  command: QUOTA_COMMAND,
  parse: parseQuota
}
