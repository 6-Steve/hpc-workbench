/**
 * 节点状态的归一化与可售判定。
 *
 * 为什么单独一个文件：这是全项目最典型的"能跑但结果错"的地方。
 * sinfo 给 `mix`，scontrol 给 `MIXED`，JSON 给 `["IDLE","DRAIN"]`——
 * 如果过滤条件写成 `state === 'idle'`，GPU 商店会一片空白**而且不报错**。
 *
 * 两条规则：
 * 1. 所有来源都映射到同一套规范枚举，映射函数只有这一份
 * 2. 过滤只吃规范枚举，不吃原始字符串
 */
import type { NodeState } from '../adapters/types'

const ALIASES: Record<string, NodeState> = {
  idle: 'idle',
  mixed: 'mixed',
  mix: 'mixed',
  allocated: 'alloc',
  alloc: 'alloc',
  drain: 'drain',
  draining: 'draining',
  drng: 'draining',
  down: 'down',
  completing: 'completing',
  comp: 'completing',
  fail: 'fail',
  failing: 'fail',
  failed: 'fail',
  'node-fail': 'fail',
  'node_fail': 'fail'
}

/** 可售集合：只有这两种状态算"有货"（docs/03 §3.1）
 *
 * 注意：这个集合是给 **sinfo** 的语义用的。`scontrol` 实测从不返回 `MIXED`，
 * 见下面的 `isBlocked`。 */
const SELLABLE: ReadonlySet<NodeState> = new Set<NodeState>(['idle', 'mixed'])

/** 会让节点彻底不可用的状态：维护、故障、说不清 */
const BLOCKED: ReadonlySet<NodeState> = new Set<NodeState>([
  'drain',
  'draining',
  'down',
  'completing',
  'fail',
  'unknown'
])

/**
 * 归一单个状态串。
 * `scontrol` 的文本格式会写成 `IDLE+DRAIN`，所以先按 `+` 切开取第一个再归一——
 * 但**判定可售时不能只看第一个**，要用 `normalizeNodeStates` 保留全部。
 */
export function normalizeNodeState(raw: string): NodeState {
  const head = raw.split('+')[0] ?? ''
  const key = head.trim().toLowerCase().replace(/\s+/g, '_')
  return ALIASES[key] ?? 'unknown'
}

/**
 * 归一一组状态，保留全部并去重。
 * JSON 里 `state` 直接就是数组（`["DOWN","DRAIN","NOT_RESPONDING"]`），
 * 文本格式里可能是 `IDLE+DRAIN` 这种复合串，两种都吃。
 */
export function normalizeNodeStates(raws: string[]): NodeState[] {
  const out: NodeState[] = []
  for (const raw of raws) {
    for (const piece of raw.split('+')) {
      if (!piece.trim()) continue
      const state = normalizeNodeState(piece)
      if (!out.includes(state)) out.push(state)
    }
  }
  return out
}

/**
 * 可售判定：**所有**状态都必须属于 {idle, mixed}。
 *
 * ⚠️ 这个函数只适用于 **sinfo** 的语义。`scontrol show node` 实测从不返回 `MIXED`：
 * 16 台机器里 11 台是 `ALLOCATED`，而这 11 台里大部分仍有空闲卡（`gres_used < gres`）。
 * 用这个函数过滤 scontrol 数据，会把 16 台砍到 1 台，商店几乎全空——正是这类 bug。
 * 判 scontrol 数据请用 `isBlocked`。
 */
export function isSellable(states: NodeState[]): boolean {
  if (states.length === 0) return false
  return states.every((state) => SELLABLE.has(state))
}

/**
 * 是否处于维护/故障状态（`scontrol` 路径用这个）。
 *
 * 语义是"这台机器还能不能接新作业"，**不是**"现在有没有空闲卡"。
 * 有没有货要看 `freeByType(gpus, gpusUsed)` 的结果，两者分开算。
 *
 * 只要出现任何一个阻断状态，整台机器就排除——`["IDLE","DRAIN"]` 必须判为阻断，
 * 否则正在排空的机器会被当成库存卖出去（docs/03 §0②）。
 */
export function isBlocked(states: NodeState[]): boolean {
  if (states.length === 0) return true
  return states.some((state) => BLOCKED.has(state))
}

/** 展示用中文标签；同样的映射只写一份 */
export function nodeStateLabel(state: NodeState): string {
  switch (state) {
    case 'idle':
      return '空闲'
    case 'mixed':
      return '部分占用'
    case 'alloc':
      return '已占满'
    case 'drain':
      return '排空中'
    case 'draining':
      return '排空中'
    case 'down':
      return '不可用'
    case 'completing':
      return '收尾中'
    case 'fail':
      return '故障'
    default:
      return '未知'
  }
}
