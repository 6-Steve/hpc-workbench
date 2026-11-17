/**
 * 节点库存汇总。
 *
 * 把「一台台机器」聚合成「哪些卡现在能租」，这是整个 GPU 商店的地基。
 *
 * 三条不能违反的规则（都是 docs/03 实测出来的，写在 memory 里）：
 *
 * 1. **blocked 的机器整台不计入库存**（drain / down / completing / 未知状态）。
 *    它可能还显示着空闲卡，但调度器不会往那上面派活，算进去就是骗人。
 *
 * 2. **`ALLOCATED` 不等于没货**。`scontrol` 从不返回 `MIXED`，
 *    有作业的机器一律报 `ALLOCATED`，但上面照样可能空着 3 张卡。
 *    所以"能不能用"必须看 `freeByType()` 的结果，不能看状态名。
 *    用 `{idle, mixed}` 过滤的话，16 台机器会被砍到 1 台。
 *
 * 3. **多机型节点要按型号分别算**，不能先合总数再摊。
 */
import { freeByType } from '../adapters/gres'
import type { GpuCount, NodeInfo } from '../adapters/types'

/** 某型号显卡的库存汇总 */
export interface GpuTypeStock {
  /** 型号名，如 `nvidia_h100_80gb_hbm3` */
  type: string
  /** 可用节点上的总卡数（不含 blocked 的机器） */
  total: number
  used: number
  free: number
  /** 有这种卡的可用节点数量 */
  nodeCount: number
  /** 还有空闲卡的节点名，方便用户直接知道去哪台 */
  freeNodes: string[]
}

/** 库存总览 */
export interface Inventory {
  /** 按空闲卡数从多到少 */
  gpuTypes: GpuTypeStock[]
  /** 可用节点（未被 blocked） */
  usableNodes: NodeInfo[]
  /** 维护/故障的节点（展示出来，但不算库存） */
  blockedNodes: NodeInfo[]
  totals: {
    nodes: number
    usableNodes: number
    gpuTotal: number
    gpuFree: number
    idleCpus: number
  }
}

/** 单台机器的空闲卡（按型号）；没有卡就是空数组 */
export function freeGpusOf(node: NodeInfo): GpuCount[] {
  if (node.gpus.length === 0) return []
  return freeByType(node.gpus, node.gpusUsed).filter((item) => item.count > 0)
}

/**
 * 把节点列表汇总成库存。
 *
 * 注意 `usableNodes` 里既有 IDLE 也有 ALLOCATED 的机器——
 * 后者只是"部分被占用"，`freeGpusOf()` 才是判断有没有货的依据。
 */
export function buildInventory(nodes: NodeInfo[]): Inventory {
  const usableNodes = nodes.filter((node) => !node.blocked)
  const blockedNodes = nodes.filter((node) => node.blocked)

  // 型号 → 累加。用 Map 保证第一次出现的顺序稳定，后面再按空闲数排序
  const byType = new Map<string, GpuTypeStock>()

  for (const node of usableNodes) {
    const total = node.gpus
    const free = freeByType(node.gpus, node.gpusUsed)
    const freeMap = new Map(free.map((item) => [item.type, item.count]))

    for (const item of total) {
      const stock = byType.get(item.type) ?? {
        type: item.type,
        total: 0,
        used: 0,
        free: 0,
        nodeCount: 0,
        freeNodes: []
      }

      const usedCount = Math.min(item.count, item.count - (freeMap.get(item.type) ?? 0))
      const freeCount = freeMap.get(item.type) ?? 0

      stock.total += item.count
      stock.used += Math.max(0, usedCount)
      stock.free += freeCount
      stock.nodeCount += 1
      if (freeCount > 0) stock.freeNodes.push(node.name)

      byType.set(item.type, stock)
    }
  }

  const gpuTypes = [...byType.values()].sort((a, b) => {
    if (b.free !== a.free) return b.free - a.free
    return b.total - a.total
  })

  const totals = {
    nodes: nodes.length,
    usableNodes: usableNodes.length,
    gpuTotal: gpuTypes.reduce((sum, item) => sum + item.total, 0),
    gpuFree: gpuTypes.reduce((sum, item) => sum + item.free, 0),
    idleCpus: usableNodes.reduce((sum, node) => sum + Math.max(0, node.idleCpus), 0)
  }

  return { gpuTypes, usableNodes, blockedNodes, totals }
}

/**
 * 型号名转成人话，**但必须保住区分信息**。
 *
 * 这里有个真实的坑：一开始我把所有含 `v100` 的都翻成「V100」，
 * 结果真实集群上 10 个型号翻出来只有 6 个不同名字——三张卡片都叫「V100」，
 * 用户根本对不上号（16GB 和 32GB 是两个价、两种用途）。
 *
 * 所以现在按「系列 + 显存 + 形态」拼，宁可长一点也要能区分。
 * `hbm3` 这类纯显存类型不拼进去（H100 80GB 都是 HBM，拼了只是噪音）。
 * 认不出系列就原样返回，不瞎猜。
 */
export function prettyGpuType(raw: string): string {
  const lower = raw.toLowerCase()

  let series = ''
  if (lower.includes('h100')) series = 'H100'
  else if (lower.includes('a100')) series = 'A100'
  else if (lower.includes('a800')) series = 'A800'
  else if (lower.includes('v100s')) series = 'V100s'
  else if (lower.includes('v100')) series = 'V100'
  else if (lower.includes('a6000')) series = 'RTX A6000'
  else if (lower.includes('4090')) series = 'RTX 4090'
  else if (lower.includes('3090')) series = 'RTX 3090'
  else if (lower.includes('2080')) series = 'RTX 2080'
  else if (lower.includes('t4')) series = 'T4'

  if (!series) return raw

  const parts: string[] = [series]

  const memory = /(\d+)gb/.exec(lower)
  if (memory) parts.push(`${memory[1]}GB`)

  // 形态是真实差异（散热/互联方式不同），要留；hbm3 只是显存类型，不留
  if (lower.includes('sxm4')) parts.push('SXM4')
  else if (lower.includes('sxm2')) parts.push('SXM2')
  else if (lower.includes('pcie')) parts.push('PCIe')

  return parts.join(' ')
}
