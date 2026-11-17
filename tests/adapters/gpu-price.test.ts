import { describe, expect, it } from 'vitest'
import { parseGpuPrice } from '../../src/main/adapters/gpu-price'
import { fixture } from '../fixtures'

const HEADER = [
  '╭───────────────────────┬──────┬───────┬───────────┬───────────┬─────────────╮',
  '│ GPU TYPE              ┆ COST ┆ HOST  ┆ FREE GPUs ┆ FREE CPUs ┆ FREE MEMORY │',
  '╞═══════════════════════╪══════╪═══════╪═══════════╪═══════════╪═════════════╡'
]

describe('parseGpuPrice（真实夹具）', () => {
  const result = parseGpuPrice(fixture('scir-watch.txt'))

  it('解析出每一行（含合并单元格展开出来的续行）', () => {
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // 表格里 5 个机型块，其中 v100-16gb 跨 3 台机器 → 共 8 行
    expect(result.data).toHaveLength(8)
  })

  it('合并单元格的续行沿用上一行的机型与单价', () => {
    if (!result.ok) return
    const v100Rows = result.data.filter((row) => row.type === 'tesla_v100-sxm2-16gb')

    expect(v100Rows).toHaveLength(3)
    expect(v100Rows.every((row) => row.cost === 4)).toBe(true)
    expect(v100Rows.map((row) => row.host)).toEqual(['node10', 'node11', 'node12'])
  })

  it('按 [│┆] 切分，混用分隔符也能对齐列', () => {
    if (!result.ok) return
    const first = result.data[0]!
    expect(first.type).toBe('a100-pcie-40gb')
    expect(first.cost).toBe(10)
    expect(first.host).toBe('node16')
    expect(first.freeGpus).toBe(1)
    expect(first.freeCpus).toBe(20)
  })

  it('内存带单位，统一解析成 GB 数字', () => {
    if (!result.ok) return
    expect(result.data[0]!.freeMemoryGb).toBe(311)
    const h100 = result.data.find((row) => row.type === 'nvidia_h100_80gb_hbm3')!
    expect(h100.freeMemoryGb).toBe(319)
  })

  it('边框行不会被当成数据', () => {
    if (!result.ok) return
    expect(result.data.some((row) => row.host.startsWith('─') || row.type.startsWith('─'))).toBe(false)
  })
})

describe('parseGpuPrice（边界）', () => {
  it('只有表头没有数据行 = 当前没有任何机型有空卡，返回空数组而不是失败', () => {
    const raw = [...HEADER, '╰───────────────────────┴──────┴───────┴───────────┴───────────┴─────────────╯'].join('\n')
    const result = parseGpuPrice(raw)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toEqual([])
  })

  it('输出里根本没有表格时失败（多半是命令不存在）', () => {
    const raw = 'bash: scir-watch: command not found'
    const result = parseGpuPrice(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.raw).toBe(raw)
  })

  it('空输出时失败', () => {
    const result = parseGpuPrice('')
    expect(result.ok).toBe(false)
  })

  it('有数据行但缺机型且前面没有可沿用的值时失败', () => {
    const raw = [...HEADER, '│                       ┆      ┆ node99 ┆         1 ┆         4 ┆        10G │'].join('\n')
    const result = parseGpuPrice(raw)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('机型或单价')
  })

  it('内存是 N/A 时解析成 null', () => {
    const raw = [...HEADER, '│ nvidia_rtx_a6000      ┆   12 ┆ node07 ┆         1 ┆         4 ┆         N/A │'].join('\n')
    const result = parseGpuPrice(raw)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data[0]!.freeMemoryGb).toBeNull()
  })
})
