import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseNodeDetail } from '../src/main/adapters/node-detail'
import { buildInventory, freeGpusOf, prettyGpuType } from '../src/main/domain/inventory'

const raw = readFileSync(join(__dirname, '..', 'fixtures', 'scontrol-node.json'), 'utf8')

function loadNodes(): ReturnType<typeof parseNodeDetail> {
  return parseNodeDetail(raw)
}

describe('buildInventory：把节点聚合成库存', () => {
  it('夹具里的 16 台机器分得清可用和不可用', () => {
    const parsed = loadNodes()
    if (!parsed.ok) throw new Error(parsed.reason)

    const inventory = buildInventory(parsed.data)
    expect(inventory.totals.nodes).toBe(16)
    // node02 / node15（DOWN+DRAIN+NOT_RESPONDING）、node18（IDLE 但 DRAIN）
    expect(inventory.blockedNodes.map((node) => node.name).sort()).toEqual(['node02', 'node15', 'node18'])
    expect(inventory.totals.usableNodes).toBe(13)
  })

  it('维护中的机器整台不计入库存——哪怕它是 IDLE 且卡全空', () => {
    const parsed = loadNodes()
    if (!parsed.ok) throw new Error(parsed.reason)

    const inventory = buildInventory(parsed.data)
    const a100 = inventory.gpuTypes.find((item) => item.type === 'nvidia_a100_80gb_pcie')

    // node18 有 8 张空卡但状态是 DRAIN；node05 有 7 张用了 2 张
    // 只看 idle 会把 node18 算进去，得到 15 张，那是错的
    expect(a100?.total).toBe(7)
    expect(a100?.used).toBe(2)
    expect(a100?.free).toBe(5)
    expect(a100?.freeNodes).toEqual(['node05'])
  })

  it('ALLOCATED 的机器照样算库存：有作业不等于没空卡', () => {
    const parsed = loadNodes()
    if (!parsed.ok) throw new Error(parsed.reason)

    const inventory = buildInventory(parsed.data)
    const v100 = inventory.gpuTypes.find((item) => item.type === 'tesla_v100-sxm2-16gb')

    // node10 / node11 / node12 全是 ALLOCATED，但各自空着 1 / 8 / 7 张
    // 按 {idle, mixed} 过滤的话这里会是 0
    expect(v100?.total).toBe(24)
    expect(v100?.used).toBe(8)
    expect(v100?.free).toBe(16)
    expect(v100?.freeNodes.sort()).toEqual(['node10', 'node11', 'node12'])
  })

  it('多机型节点按型号分别算，不合并', () => {
    const parsed = loadNodes()
    if (!parsed.ok) throw new Error(parsed.reason)

    const inventory = buildInventory(parsed.data)
    // node13 同时有「v100s-pcie-32gb:3」和「v100-sxm2-32gb:2」，
    // 两个名字只差几个字母，合并成 5 张就错了
    const pcie32 = inventory.gpuTypes.find((item) => item.type === 'tesla_v100s-pcie-32gb')
    const sxm32 = inventory.gpuTypes.find((item) => item.type === 'tesla_v100-sxm2-32gb')

    expect(pcie32?.total).toBe(3)
    expect(pcie32?.free).toBe(2)
    expect(sxm32?.total).toBe(2)
    expect(sxm32?.free).toBe(0)
  })

  it('总量与明细对得上', () => {
    const parsed = loadNodes()
    if (!parsed.ok) throw new Error(parsed.reason)

    const inventory = buildInventory(parsed.data)
    const sumTotal = inventory.gpuTypes.reduce((sum, item) => sum + item.total, 0)
    const sumFree = inventory.gpuTypes.reduce((sum, item) => sum + item.free, 0)

    expect(inventory.totals.gpuTotal).toBe(sumTotal)
    expect(inventory.totals.gpuFree).toBe(sumFree)
    // 每个型号的 used + free 必须等于 total
    for (const item of inventory.gpuTypes) {
      expect(item.used + item.free).toBe(item.total)
    }
  })

  it('按空闲卡数从多到少排，好卡在前', () => {
    const parsed = loadNodes()
    if (!parsed.ok) throw new Error(parsed.reason)

    const inventory = buildInventory(parsed.data)
    for (let i = 1; i < inventory.gpuTypes.length; i += 1) {
      expect(inventory.gpuTypes[i - 1]!.free).toBeGreaterThanOrEqual(inventory.gpuTypes[i]!.free)
    }
  })

  it('空节点列表不炸', () => {
    const inventory = buildInventory([])
    expect(inventory.gpuTypes).toEqual([])
    expect(inventory.totals).toEqual({ nodes: 0, usableNodes: 0, gpuTotal: 0, gpuFree: 0, idleCpus: 0 })
  })
})

describe('freeGpusOf：单机空闲卡', () => {
  it('只返回还有空的型号', () => {
    const parsed = loadNodes()
    if (!parsed.ok) throw new Error(parsed.reason)

    const node01 = parsed.data.find((node) => node.name === 'node01')!
    const free = freeGpusOf(node01)
    expect(free).toEqual([{ type: 'nvidia_h100_80gb_hbm3', count: 1 }])

    // node04 两张卡都占了，不该出现在"有空闲"的列表里
    const node04 = parsed.data.find((node) => node.name === 'node04')!
    expect(freeGpusOf(node04)).toEqual([])
  })

  it('没卡的节点返回空数组', () => {
    const inventoryNode = {
      name: 'cpu-only',
      states: ['idle' as const],
      rawStates: ['IDLE'],
      blocked: false,
      gpus: [],
      gpusUsed: [],
      cpus: 64,
      allocCpus: 0,
      idleCpus: 64,
      realMemoryMb: 128000,
      allocMemoryMb: 0,
      freeMemoryMb: 128000,
      partitions: ['cpu']
    }
    expect(freeGpusOf(inventoryNode)).toEqual([])
  })
})

describe('prettyGpuType：型号转人话', () => {
  it('认得出常见型号，并带上显存和形态', () => {
    expect(prettyGpuType('nvidia_h100_80gb_hbm3')).toBe('H100 80GB')
    expect(prettyGpuType('nvidia_h100')).toBe('H100')
    expect(prettyGpuType('nvidia_a100_80gb_pcie')).toBe('A100 80GB PCIe')
    expect(prettyGpuType('a100-sxm4-80gb')).toBe('A100 80GB SXM4')
    expect(prettyGpuType('a100-pcie-40gb')).toBe('A100 40GB PCIe')
    expect(prettyGpuType('nvidia_a800_80gb_pcie')).toBe('A800 80GB PCIe')
    expect(prettyGpuType('tesla_v100-sxm2-16gb')).toBe('V100 16GB SXM2')
    expect(prettyGpuType('nvidia_rtx_a6000')).toBe('RTX A6000')
  })

  it('**不同型号绝不能翻成同一个名字**（真实集群踩过的坑）', () => {
    // 第一版把所有 v100 都翻成「V100」，界面上三张卡片同名，用户对不上号
    const realTypes = [
      'nvidia_h100_80gb_hbm3',
      'nvidia_h100',
      'nvidia_a100_80gb_pcie',
      'a100-sxm4-80gb',
      'a100-pcie-40gb',
      'nvidia_a800_80gb_pcie',
      'tesla_v100-sxm2-16gb',
      'tesla_v100-sxm2-32gb',
      'tesla_v100s-pcie-32gb',
      'nvidia_rtx_a6000'
    ]
    const labels = realTypes.map(prettyGpuType)
    expect(new Set(labels).size).toBe(realTypes.length)
  })

  it('认不出来就原样返回，不瞎猜', () => {
    expect(prettyGpuType('some_unknown_card_9000')).toBe('some_unknown_card_9000')
  })
})
