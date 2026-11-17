/**
 * `scir-account details` 解析器。
 *
 * 样本全部来自 2026-11-05 在 `login-01` 的实测输出（已按仓库约定脱敏：
 * 用户名统一成 `user01`，作业名保持实测的样子因为它们是用户自己起的测试名）。
 *
 * 重点不是"能解析正常表格"，而是**下面每一条都是踩到过或差点踩到的坑**：
 * - `│` 与 `┆` 混用
 * - Resources 里带逗号
 * - Resources 里各字段**顺序不固定**
 * - 表头 `Time` 与 `Time(H)` 两种写法，单位都是小时
 * - 逐条相加 ≠ 表尾 Used（平台自己舍入）
 */
import { describe, expect, it } from 'vitest'
import { parseUsageTable } from '../src/main/adapters/points-usage'

/** 实测的第 3、4、5 条，原样保留（含边框与分隔线） */
const PLAIN = [
  '╭────────┬────────────┬──────┬────────────┬────────╮',
  '│ JID    ┆ Job Name   ┆ Time ┆ Time Limit ┆ Points │',
  '╞════════╪════════════╪══════╪════════════╪════════╡',
  '│ 208896 ┆ train      ┆ 0.00 ┆ 2.00       ┆ 0.00   │',
  '├╌╌╌╌╌╌╌╌┼╌╌╌╌╌╌╌╌╌╌╌╌┼╌╌╌╌╌╌┼╌╌╌╌╌╌╌╌╌╌╌╌┼╌╌╌╌╌╌╌╌┤',
  '│ 211291 ┆ streamtest ┆ 0.01 ┆ 0.17       ┆ 0.00   │',
  '├╌╌╌╌╌╌╌╌┼╌╌╌╌╌╌╌╌╌╌╌╌┼╌╌╌╌╌╌┼╌╌╌╌╌╌╌╌╌╌╌╌┼╌╌╌╌╌╌╌╌┤',
  '│ 211439 ┆ notifytest ┆ 0.00 ┆ 0.08       ┆ 0.01   │',
  '╰────────┴────────────┴──────┴────────────┴────────╯',
  'Total: 5200.00 Used: 0.02 Avail: 5199.98'
].join('\n')

/** `-r` 形态：多一列 Resources，表头变成 Time(H) */
const WITH_RESOURCES = [
  '╭────────┬────────────┬───────────────────────────────────────────────────────────────────────────────────┬─────────┬───────────────┬────────╮',
  '│ JID    ┆ Job Name   ┆ Resources                                                                         ┆ Time(H) ┆ Time Limit(H) ┆ Points │',
  '╞════════╪════════════╪═══════════════════════════════════════════════════════════════════════════════════╪═════════╪═══════════════╪════════╡',
  '│ 208896 ┆ train      ┆ node(0)=1, billing(0)=4, cpu(0.05)=4, gpu:tesla_v100-sxm2-16gb(4)=1, mem(0)=16384 ┆ 0.00    ┆ 2.00          ┆ 0.00   │',
  '├╌╌╌╌╌╌╌╌┼╌╌╌╌╌╌╌╌╌╌╌╌┼╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┼╌╌╌╌╌╌╌╌╌┼╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┼╌╌╌╌╌╌╌╌┤',
  '│ 208899 ┆ train      ┆ billing(0)=4, mem(0)=16384, gpu:tesla_v100-sxm2-16gb(4)=1, node(0)=1, cpu(0.05)=4 ┆ 0.00    ┆ 2.00          ┆ 0.00   │',
  '├╌╌╌╌╌╌╌╌┼╌╌╌╌╌╌╌╌╌╌╌╌┼╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┼╌╌╌╌╌╌╌╌╌┼╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┼╌╌╌╌╌╌╌╌┤',
  '│ 210508 ┆ wbcpu      ┆ node(0)=1, mem(0)=8192, cpu(0.05)=2, billing(0)=2                                 ┆ 0.00    ┆ 0.02          ┆ 0.00   │',
  '╰────────┴────────────┴───────────────────────────────────────────────────────────────────────────────────┴─────────┴───────────────┴────────╯',
  'Total: 5200.00 Used: 0.02 Avail: 5199.98'
].join('\n')

describe('parseUsageTable · 基本形态', () => {
  it('解析出所有作业行，表头与分隔线不算数据', () => {
    const result = parseUsageTable(PLAIN)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.data.rows).toHaveLength(3)
    expect(result.data.rows.map((row) => row.jobId)).toEqual(['208896', '211291', '211439'])
  })

  it('Time 列按小时读，不带 (H) 后缀也是小时', () => {
    const result = parseUsageTable(PLAIN)
    if (!result.ok) throw new Error('应当解析成功')

    // 211291 实测 Time=0.01 / Time Limit=0.17。0.17 小时 ≈ 10 分钟，
    // 是「wbe2e」那批测试作业申请的时长；若误把 Time 当分钟读，
    // 会得到 0.01 分钟这种明显不合理的数
    const row = result.data.rows.find((item) => item.jobId === '211291')
    expect(row?.hours).toBeCloseTo(0.01, 5)
    expect(row?.limitHours).toBeCloseTo(0.17, 5)
  })

  it('表尾汇总与 rows 分开返回', () => {
    const result = parseUsageTable(PLAIN)
    if (!result.ok) throw new Error('应当解析成功')

    expect(result.data.totals).toEqual({ total: 5200, used: 0.02, avail: 5199.98 })
  })

  it('不带 -r 时 resources 为 null，但也算成功', () => {
    const result = parseUsageTable(PLAIN)
    if (!result.ok) throw new Error('应当解析成功')

    expect(result.data.rows.every((row) => row.resources === null)).toBe(true)
    expect(result.data.rows.every((row) => row.gpuType === null)).toBe(true)
  })
})

describe('parseUsageTable · Resources 列', () => {
  it('Resources 里的逗号不会把一行切成多行', () => {
    const result = parseUsageTable(WITH_RESOURCES)
    if (!result.ok) throw new Error('应当解析成功')

    // 每行有 5 个逗号，按逗号切会炸成十几行；这里必须还是 3 条
    expect(result.data.rows).toHaveLength(3)
  })

  it('字段顺序变了也能抠出 GPU 型号和张数', () => {
    const result = parseUsageTable(WITH_RESOURCES)
    if (!result.ok) throw new Error('应当解析成功')

    // 208896 是 node/billing/cpu/gpu/mem，208899 是 billing/mem/gpu/node/cpu
    // 两条顺序完全不同，必须都能抠出来
    for (const jobId of ['208896', '208899']) {
      const row = result.data.rows.find((item) => item.jobId === jobId)
      expect(row?.gpuType, `${jobId} 的 GPU 型号`).toBe('tesla_v100-sxm2-16gb')
      expect(row?.gpuCount, `${jobId} 的 GPU 张数`).toBe(1)
    }
  })

  it('billing 的 key 带括号权重（billing(0)），不能按全等比', () => {
    const result = parseUsageTable(WITH_RESOURCES)
    if (!result.ok) throw new Error('应当解析成功')

    // 这是第一版真踩到的 bug：写成 key === 'billing' 就永远是 null
    const row = result.data.rows.find((item) => item.jobId === '210508')
    expect(row?.billing).toBe(2)
  })

  it('纯 CPU 作业没有 gpu 键，gpuType 为 null 而不是空串', () => {
    const result = parseUsageTable(WITH_RESOURCES)
    if (!result.ok) throw new Error('应当解析成功')

    // 210508 是 wbcpu，Resources 里确实没有 gpu:
    const row = result.data.rows.find((item) => item.jobId === '210508')
    expect(row?.gpuType).toBeNull()
    expect(row?.gpuCount).toBeNull()
  })

  it('表头带 (H) 后缀也能对上列', () => {
    const result = parseUsageTable(WITH_RESOURCES)
    if (!result.ok) throw new Error('应当解析成功')

    // 若 (H) 别名没登记，hours 会落到默认 0，这里能抓出来
    const row = result.data.rows.find((item) => item.jobId === '208899')
    expect(row?.limitHours).toBe(2)
  })
})

describe('parseUsageTable · 汇总与舍入', () => {
  it('逐条相加与表尾 Used 不等是正常的，差值如实给出', () => {
    const result = parseUsageTable(PLAIN)
    if (!result.ok) throw new Error('应当解析成功')

    // 三条 Points 是 0.00 / 0.00 / 0.01 → 相加 0.01，表尾却是 0.02
    expect(result.data.sum.points).toBeCloseTo(0.01, 5)
    expect(result.data.sum.diff).toBeCloseTo(0.01, 5)
  })

  it('相加结果保留两位，不出现 0.010000000000000009', () => {
    const result = parseUsageTable(PLAIN)
    if (!result.ok) throw new Error('应当解析成功')

    expect(String(result.data.sum.points)).toBe('0.01')
  })

  it('拿不到表尾汇总时 diff 为 null，不硬算成 0', () => {
    const noTotals = PLAIN.split('\n').filter((line) => !line.startsWith('Total:')).join('\n')
    const result = parseUsageTable(noTotals)
    if (!result.ok) throw new Error('应当解析成功')

    expect(result.data.totals).toBeNull()
    expect(result.data.sum.diff).toBeNull()
  })
})

describe('parseUsageTable · 边界', () => {
  it('空输出带 raw，不当成空列表', () => {
    const result = parseUsageTable('   ')
    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.reason).toContain('没有输出')
    expect(result.raw.length).toBeGreaterThan(0)
  })

  it('只有表头没有作业，是成功且 rows 为空', () => {
    const empty = [
      '╭────────┬────────────┬──────┬────────────┬────────╮',
      '│ JID    ┆ Job Name   ┆ Time ┆ Time Limit ┆ Points │',
      '╰────────┴────────────┴──────┴────────────┴────────╯',
      'Total: 100.00 Used: 0.00 Avail: 100.00'
    ].join('\n')

    const result = parseUsageTable(empty)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // 新账号没跑过作业就是这个样子，不是错误
    expect(result.data.rows).toHaveLength(0)
    expect(result.data.totals).toEqual({ total: 100, used: 0, avail: 100 })
  })

  it('输出完全不是这张表时，失败并带 raw', () => {
    const result = parseUsageTable('Error: LdapError(LdapResult { rc: 49 })')
    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.reason).toContain('没找到消耗明细表')
    expect(result.raw).toContain('LdapError')
  })

  it('JID 不是数字的行被跳过（防止表尾混进数据）', () => {
    const withFooter = [
      ...PLAIN.split('\n'),
      '│ Total  ┆ -          ┆ -    ┆ -          ┆ 0.02   │'
    ].join('\n')

    const result = parseUsageTable(withFooter)
    if (!result.ok) throw new Error('应当解析成功')

    expect(result.data.rows.map((row) => row.jobId)).toEqual(['208896', '211291', '211439'])
  })
})
