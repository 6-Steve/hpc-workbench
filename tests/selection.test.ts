import { describe, expect, it } from 'vitest'
import {
  EMPTY_SELECTION,
  applyClick,
  moveFocus,
  pruneSelection,
  rangeNames,
  selectAll,
  sortByList,
  type SelectionState
} from '../src/renderer/src/lib/selection'

/** 一个固定的小目录，顺序就是显示顺序 */
const NAMES = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']

const click = (
  state: SelectionState,
  name: string,
  modifiers: { toggle?: boolean; shift?: boolean } = {}
): SelectionState => applyClick(NAMES, state, name, { toggle: modifiers.toggle ?? false, shift: modifiers.shift ?? false })

describe('selection · 单击', () => {
  it('单击只选中一个', () => {
    const result = click(EMPTY_SELECTION, 'b.txt')
    expect(result.selected).toEqual(['b.txt'])
    expect(result.focus).toBe('b.txt')
    expect(result.anchor).toBe('b.txt')
  })

  it('单击另一个会把之前的换掉（不是累加）', () => {
    const result = click(click(EMPTY_SELECTION, 'a.txt'), 'c.txt')
    expect(result.selected).toEqual(['c.txt'])
  })

  it('再点唯一的选中项会取消选择', () => {
    const result = click(click(EMPTY_SELECTION, 'b.txt'), 'b.txt')
    expect(result.selected).toEqual([])
    // 焦点和锚点留着：用户取消后马上 Shift 点别处，应该还能从 b 拉一段
    expect(result.focus).toBe('b.txt')
  })

  it('多选状态下点其中一个，只留那一个（不是取消它）', () => {
    /**
     * 这条容易写错成"从多选里减掉它"。资源管理器的行为是：
     * 不带修饰键的点击 = 重新开始一个选择。
     */
    const multi = click(click(EMPTY_SELECTION, 'a.txt'), 'c.txt', { toggle: true })
    expect(multi.selected).toEqual(['a.txt', 'c.txt'])
    expect(click(multi, 'c.txt').selected).toEqual(['c.txt'])
  })
})

describe('selection · Ctrl 加选', () => {
  it('Ctrl 点击把没选的加进来', () => {
    const result = click(click(EMPTY_SELECTION, 'a.txt'), 'c.txt', { toggle: true })
    expect(result.selected).toEqual(['a.txt', 'c.txt'])
  })

  it('Ctrl 点已选的把它去掉', () => {
    const two = click(click(EMPTY_SELECTION, 'a.txt'), 'b.txt', { toggle: true })
    expect(click(two, 'a.txt', { toggle: true }).selected).toEqual(['b.txt'])
  })

  it('Ctrl 点击之后锚点跟着挪（下一次 Shift 从新位置拉）', () => {
    const result = click(click(EMPTY_SELECTION, 'a.txt'), 'c.txt', { toggle: true })
    expect(result.anchor).toBe('c.txt')
  })
})

describe('selection · Shift 区间', () => {
  it('往下拉一段', () => {
    const result = click(click(EMPTY_SELECTION, 'b.txt'), 'd.txt', { shift: true })
    expect(result.selected).toEqual(['b.txt', 'c.txt', 'd.txt'])
  })

  it('往上拉一段（顺序按列表，不是按点击方向）', () => {
    const result = click(click(EMPTY_SELECTION, 'd.txt'), 'b.txt', { shift: true })
    expect(result.selected).toEqual(['b.txt', 'c.txt', 'd.txt'])
  })

  it('连续 Shift 点击不会漂移（锚点钉在第一次的起点）', () => {
    /**
     * 这是最容易写错的地方：如果锚点取"上次选中的最后一个"，
     * b → e → c 会变成 e..c 这一段，把用户想要的 b..c 丢掉。
     */
    let state = click(EMPTY_SELECTION, 'b.txt')
    state = click(state, 'e.txt', { shift: true })
    expect(state.selected).toEqual(['b.txt', 'c.txt', 'd.txt', 'e.txt'])
    state = click(state, 'c.txt', { shift: true })
    expect(state.selected).toEqual(['b.txt', 'c.txt'])
    expect(state.anchor).toBe('b.txt')
  })

  it('Ctrl+Shift 也是替换区间（和资源管理器一致，不是追加）', () => {
    /**
     * 第一版把这条写成"追加"，和 Windows 行为对不上。资源管理器里 Ctrl 不改
     * Shift 区间的语义；想选两段要分开操作。这条断言是为那次改错留的。
     */
    const base = click(click(EMPTY_SELECTION, 'a.txt'), 'e.txt', { toggle: true })
    expect(base.selected).toEqual(['a.txt', 'e.txt'])
    // 锚点此刻是 e.txt（最后一次 Ctrl 点击的位置），从 e 拉到 b 就是 b..e
    const result = click(base, 'b.txt', { shift: true, toggle: true })
    expect(result.selected).toEqual(['b.txt', 'c.txt', 'd.txt', 'e.txt'])
    expect(result.anchor).toBe('e.txt')
  })

  it('锚点已经不在列表里时，退化成只选这一行', () => {
    const stale: SelectionState = { selected: [], anchor: 'z.txt', focus: null }
    expect(click(stale, 'c.txt', { shift: true }).selected).toEqual(['c.txt'])
  })

  it('没有锚点时 Shift 点自己，等于只选自己', () => {
    expect(click(EMPTY_SELECTION, 'c.txt', { shift: true }).selected).toEqual(['c.txt'])
  })
})

describe('selection · 键盘', () => {
  it('向下移动焦点并改选择', () => {
    const result = moveFocus(NAMES, click(EMPTY_SELECTION, 'b.txt'), 1, false)
    expect(result.focus).toBe('c.txt')
    expect(result.selected).toEqual(['c.txt'])
  })

  it('没有焦点时向下从第一行开始、向上从最后一行开始', () => {
    expect(moveFocus(NAMES, EMPTY_SELECTION, 1, false).focus).toBe('a.txt')
    expect(moveFocus(NAMES, EMPTY_SELECTION, -1, false).focus).toBe('e.txt')
  })

  it('到头了不动（不循环）', () => {
    const atEnd = click(EMPTY_SELECTION, 'e.txt')
    expect(moveFocus(NAMES, atEnd, 1, false)).toBe(atEnd)
  })

  it('Shift+方向键扩大选区', () => {
    let state = click(EMPTY_SELECTION, 'b.txt')
    state = moveFocus(NAMES, state, 1, true)
    state = moveFocus(NAMES, state, 1, true)
    expect(state.selected).toEqual(['b.txt', 'c.txt', 'd.txt'])
    // 往回缩
    expect(moveFocus(NAMES, state, -1, true).selected).toEqual(['b.txt', 'c.txt'])
  })

  it('空列表上按方向键不出错', () => {
    expect(moveFocus([], EMPTY_SELECTION, 1, false)).toBe(EMPTY_SELECTION)
  })
})

describe('selection · 工具函数', () => {
  it('全选按显示顺序', () => {
    expect(selectAll(NAMES).selected).toEqual(NAMES)
  })

  it('sortByList 按列表顺序排，而不是点击顺序', () => {
    expect(sortByList(NAMES, ['d.txt', 'a.txt', 'c.txt'])).toEqual(['a.txt', 'c.txt', 'd.txt'])
  })

  it('rangeNames 反向也能算', () => {
    expect(rangeNames(NAMES, 'd.txt', 'b.txt')).toEqual(['b.txt', 'c.txt', 'd.txt'])
  })

  it('rangeNames 任一端不存在就返回空', () => {
    expect(rangeNames(NAMES, 'a.txt', 'zzz')).toEqual([])
  })
})

describe('selection · 列表变化', () => {
  it('刷新后剔掉已经不存在的名字', () => {
    const state: SelectionState = { selected: ['a.txt', 'gone.txt'], anchor: 'gone.txt', focus: 'a.txt' }
    const result = pruneSelection(NAMES, state)
    expect(result.selected).toEqual(['a.txt'])
    expect(result.anchor).toBeNull()
    expect(result.focus).toBe('a.txt')
  })

  it('没有变化时返回同一个对象（避免无谓重渲染）', () => {
    const state = click(EMPTY_SELECTION, 'a.txt')
    expect(pruneSelection(NAMES, state)).toBe(state)
  })

  it('全部消失时清空', () => {
    const state: SelectionState = { selected: ['x', 'y'], anchor: 'x', focus: 'y' }
    expect(pruneSelection(NAMES, state)).toEqual({ selected: [], anchor: null, focus: null })
  })
})
