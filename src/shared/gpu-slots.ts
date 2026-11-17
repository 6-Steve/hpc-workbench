/**
 * 把「一台机器对这个型号还剩几张卡」变成一排格子。
 *
 * ## 为什么值得单独抽一层
 *
 * 这段逻辑有三条容易写反的规则，全部来自集群实测（`docs/03`）：
 *
 * 1. **`blocked` 的机器整台不可用**，哪怕它还空着 8 张卡——
 *    drain / down 的节点调度器不派活，画成绿色就是在骗人。
 * 2. **有作业 ≠ 没卡**。`scontrol` 从不返回 `MIXED`，有作业就报 `ALLOCATED`，
 *    但上面照样可能空着几张。所以判断依据只能是「总卡 − 已用」，
 *    **绝不能看状态名**（用 `idle` 过滤会把 16 台砍成 1 台）。
 * 3. **按型号分别算**。一台机器可能 A100×4 + V100×4，
 *    先合总数再摊，会出现"V100 显示 8 张空闲"这种假货。
 *
 * 抽成纯函数是为了能把这三条钉在测试里——界面层写 if 是钉不住的。
 */
export type SlotState = 'free' | 'used' | 'blocked'

/**
 * 结构类型，刻意不 import 主进程的 `NodeInfo`。
 *
 * `NodeInfo` 是全局声明（来自 preload 的 d.ts），共享层依赖它会让
 * `tests/*.ts` 引用时牵出一串主进程模块。这里只要三个字段就够了。
 */
export interface SlotNode {
  blocked: boolean
  gpus: ReadonlyArray<{ type: string; count: number }>
  gpusUsed: ReadonlyArray<{ type: string; count: number }>
}

/**
 * 一台机器在某个型号下的格子。
 *
 * 顺序是「先已用、后空闲」，左边填满向右延伸——和容量条的直觉一致。
 */
export function slotsOf(node: SlotNode, type: string): SlotState[] {
  const total = Math.max(0, Math.floor(node.gpus.find((item) => item.type === type)?.count ?? 0))
  if (total === 0) return []

  if (node.blocked) return Array.from({ length: total }, () => 'blocked' as const)

  const usedRaw = node.gpusUsed.find((item) => item.type === type)?.count ?? 0
  /*
   * `used` 可能大于 `total`（节点状态和作业统计短暂不同步）。
   * 这时**不能**画出负数个格子，也不能让空闲变负——夹到 [0, total]。
   */
  const used = Math.min(total, Math.max(0, Math.floor(usedRaw)))

  return [
    ...Array.from({ length: used }, () => 'used' as const),
    ...Array.from({ length: total - used }, () => 'free' as const)
  ]
}

/** 某个型号在整批节点上的汇总，用于卡片头的比例条 */
export function slotSummary(
  nodes: ReadonlyArray<SlotNode>,
  type: string
): { total: number; free: number } {
  let total = 0
  let free = 0
  for (const node of nodes) {
    const slots = slotsOf(node, type)
    total += slots.length
    for (const slot of slots) if (slot === 'free') free += 1
  }
  return { total, free }
}
