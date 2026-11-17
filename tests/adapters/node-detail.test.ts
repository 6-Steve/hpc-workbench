import { describe, expect, it } from 'vitest'
import { freeByType } from '../../src/main/adapters/gres'
import { parseNodeDetail } from '../../src/main/adapters/node-detail'
import { fixture } from '../fixtures'

function parseFixture() {
  const result = parseNodeDetail(fixture('scontrol-node.json'))
  if (!result.ok) throw new Error(`夹具解析失败：${result.reason}`)
  return result.data
}

describe('parseNodeDetail（真实夹具）', () => {
  const nodes = parseFixture()

  it('解析出全部节点', () => {
    expect(nodes).toHaveLength(16)
    expect(nodes.every((node) => node.name.startsWith('node'))).toBe(true)
  })

  it('普通空闲节点：不阻断，卡数正确', () => {
    const node = nodes.find((n) => n.name === 'node20')!
    expect(node.states).toEqual(['idle'])
    expect(node.blocked).toBe(false)
    expect(node.gpus).toEqual([{ type: 'nvidia_a800_80gb_pcie', count: 2 }])
    expect(node.gpusUsed).toEqual([{ type: 'nvidia_a800_80gb_pcie', count: 0 }])
    expect(node.freeMemoryMb).toBe(52172)
  })

  it('ALLOCATED 不算阻断——这台机器还有空闲卡', () => {
    const node = nodes.find((n) => n.name === 'node13')!
    expect(node.states).toEqual(['alloc'])
    expect(node.blocked).toBe(false)

    // 两种卡，其中 v100s 剩 2 张、v100 用满
    expect(node.gpus).toHaveLength(2)
    expect(freeByType(node.gpus, node.gpusUsed)).toEqual([
      { type: 'tesla_v100s-pcie-32gb', count: 2 },
      { type: 'tesla_v100-sxm2-32gb', count: 0 }
    ])
  })

  it('IDLE+DRAIN 必须判为阻断（正在排空，不能再卖）', () => {
    const node = nodes.find((n) => n.name === 'node18')!
    expect(node.states).toEqual(['idle', 'drain'])
    expect(node.blocked).toBe(true)
    // 它确实有 8 张全空的 A100，这正是最危险的那种
    expect(node.gpus).toEqual([{ type: 'nvidia_a100_80gb_pcie', count: 8 }])
  })

  it('DOWN+DRAIN+NOT_RESPONDING 判为阻断', () => {
    const node = nodes.find((n) => n.name === 'node02')!
    expect(node.blocked).toBe(true)
    expect(node.states).toContain('down')
  })

  it('free_mem.set=false 解析成 null，不是 0', () => {
    const node = nodes.find((n) => n.name === 'node02')!
    expect(node.freeMemoryMb).toBeNull()
  })

  it('核数三个字段各就各位', () => {
    const node = nodes.find((n) => n.name === 'node13')!
    expect(node.cpus).toBe(40)
    expect(node.allocCpus).toBe(12)
    expect(node.idleCpus).toBe(28)
  })

  it('分区解析成数组', () => {
    expect(nodes[0]!.partitions).toEqual(['compute'])
  })
})

describe('parseNodeDetail（异常输入）', () => {
  it('非 JSON 时失败，理由指向"不是 JSON"而不是笼统的解析失败', () => {
    const raw = 'scontrol: error: Invalid option --json'
    const result = parseNodeDetail(raw)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('不是 JSON')
    expect(result.reason).not.toContain('截断')
    expect(result.raw).toBe(raw)
  })

  it('空输出时失败，理由说清楚', () => {
    const result = parseNodeDetail('   ')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('没有输出')
  })

  it('输出被截断时给出明确的理由，而不是笼统的解析失败', () => {
    const result = parseNodeDetail('{"nodes": [{"name": "node01"')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('不完整')
  })

  it('信封里 errors 非空时按失败处理，哪怕 JSON 合法', () => {
    const result = parseNodeDetail(
      JSON.stringify({ nodes: [], errors: [{ description: 'Invalid node name specified' }] })
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('调度器返回错误')
      expect(result.reason).toContain('Invalid node name')
    }
  })

  it('nodes 为空数组时失败（不是静默返回空列表）', () => {
    const result = parseNodeDetail(JSON.stringify({ nodes: [], errors: [] }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('为空')
  })

  it('节点缺 name 时失败', () => {
    const result = parseNodeDetail(JSON.stringify({ nodes: [{ state: ['IDLE'] }] }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('name')
  })
})
