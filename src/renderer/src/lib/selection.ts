/**
 * 文件列表的多选模型。
 *
 * 为什么单独抽成模块：多选看起来只是"记住哪些名字被点了"，实际有四套语义
 * 交叉在一起，全写在组件的 `onClick` 里必然错漏——
 *
 * | 操作 | 结果 |
 * | --- | --- |
 * | 单击 | 只留这一个 |
 * | 再点同一个（唯一的选中项） | 取消选择 |
 * | Ctrl / Cmd + 单击 | 加一个 / 减一个 |
 * | Shift + 单击 | 从"锚点"到这里的整段，**替换**已有选择 |
 * | Ctrl + Shift + 单击 | 同上，也是替换——和 Windows 资源管理器一致 |
 * | 方向键 | 移动焦点，**同时**改变选择（和资源管理器一致） |
 * | Ctrl + A | 全选 |
 *
 * 还有一个容易被忽略的东西：**锚点（anchor）**。Shift 点击的起点不是"当前选中项"，
 * 而是"上一次不带 Shift 的那次点击"。没有它的话，连续 Shift 点击会一段段漂移，
 * 用户永远选不到自己想要的区间。
 *
 * 焦点（focus）和选择（selected）是两回事：键盘移动需要有"我现在在哪一行"的概念，
 * 即使那一行没被选中。所以这里同时维护两者，锚点跟着焦点走。
 */

export interface SelectionState {
  /** 选中的名字。用数组而不是 Set，因为要能被 React 的 state 直接比较、也要保序 */
  selected: string[]
  /** Shift 点击的起点 */
  anchor: string | null
  /** 键盘焦点所在的行 */
  focus: string | null
}

export const EMPTY_SELECTION: SelectionState = { selected: [], anchor: null, focus: null }

export interface ClickModifiers {
  /** Ctrl 或 Cmd */
  toggle: boolean
  shift: boolean
}

/** 名字到下标。列表已经排好序了，区间选择靠它换算 */
export function indexOfName(names: readonly string[], name: string): number {
  return names.indexOf(name)
}

/**
 * 区间 `[a, b]` 内的所有名字（含两端，顺序按列表顺序，不按点击顺序）。
 * 任何一个找不到就返回空数组——那时候列表已经变了，硬算会给出错的区间。
 */
export function rangeNames(names: readonly string[], a: string, b: string): string[] {
  const i = indexOfName(names, a)
  const j = indexOfName(names, b)
  if (i < 0 || j < 0) return []
  const [start, end] = i <= j ? [i, j] : [j, i]
  return names.slice(start, end + 1)
}

/** 选中项按**列表顺序**排列（而不是点击顺序），这样批量操作看起来才是"从上到下" */
export function sortByList(names: readonly string[], selected: readonly string[]): string[] {
  const order = new Map(names.map((name, index) => [name, index]))
  return [...selected].sort((x, y) => (order.get(x) ?? 0) - (order.get(y) ?? 0))
}

/**
 * 处理一次点击。
 *
 * `names` 是**当前列表里所有条目名**（按显示顺序），不是全部文件——
 * 拿它来算 Shift 区间。传进来的 `name` 必须在这批里。
 */
export function applyClick(
  names: readonly string[],
  state: SelectionState,
  name: string,
  modifiers: ClickModifiers
): SelectionState {
  // Shift：从锚点拉一段，**替换**掉原来的选择。
  // 注意 Ctrl+Shift 也是一样的语义——Windows 资源管理器里 Ctrl 对 Shift 区间不起
  // 追加作用；想让两段同时选中，得先把第二段 Shift 出来再 Ctrl 补几个。
  // 第一版写成了"Ctrl+Shift 追加"，和资源管理器对不上，测试抓出来了。
  if (modifiers.shift) {
    const anchor = state.anchor && indexOfName(names, state.anchor) >= 0 ? state.anchor : name
    return { selected: rangeNames(names, anchor, name), anchor, focus: name }
  }

  // Ctrl：单个加减，锚点跟着挪到这一行——否则接下来的 Shift 会从很远的地方拉
  if (modifiers.toggle) {
    const has = state.selected.includes(name)
    const next = has ? state.selected.filter((item) => item !== name) : [...state.selected, name]
    return { selected: sortByList(names, next), anchor: name, focus: name }
  }

  // 普通单击：本来就是"只选中这一个" → 再点一次取消（资源管理器也是这样）
  const onlyThis = state.selected.length === 1 && state.selected[0] === name
  return {
    selected: onlyThis ? [] : [name],
    anchor: name,
    focus: name
  }
}

/**
 * 键盘上下移动。`delta` 为 +1 / -1；`extend` 对应 Shift（扩大选区）。
 *
 * 焦点从"当前 focus"走；没有 focus 时，向下从第一行开始、向上从最后一行开始。
 * 到头了就不动——**不循环**，循环会让"按到底反而跳到顶部"这种意外选中很难察觉。
 */
export function moveFocus(
  names: readonly string[],
  state: SelectionState,
  delta: number,
  extend: boolean
): SelectionState {
  if (names.length === 0) return state

  const current = state.focus ? indexOfName(names, state.focus) : -1
  let next: number
  if (current < 0) {
    next = delta > 0 ? 0 : names.length - 1
  } else {
    next = current + delta
    if (next < 0 || next >= names.length) return state
  }

  const target = names[next]!
  if (!extend) return { selected: [target], anchor: target, focus: target }

  const anchor = state.anchor && indexOfName(names, state.anchor) >= 0 ? state.anchor : target
  return { selected: rangeNames(names, anchor, target), anchor, focus: target }
}

/** 全选 */
export function selectAll(names: readonly string[]): SelectionState {
  return {
    selected: [...names],
    anchor: names[0] ?? null,
    focus: names[names.length - 1] ?? null
  }
}

/** 列表变了（刷新、切目录）之后，把已经不存在的名字剔掉 */
export function pruneSelection(names: readonly string[], state: SelectionState): SelectionState {
  const alive = new Set(names)
  const selected = state.selected.filter((name) => alive.has(name))
  const anchor = state.anchor && alive.has(state.anchor) ? state.anchor : null
  const focus = state.focus && alive.has(state.focus) ? state.focus : null
  // 引用不变，React 才不会白白重渲染
  if (selected.length === state.selected.length && anchor === state.anchor && focus === state.focus) {
    return state
  }
  return { selected, anchor, focus }
}
