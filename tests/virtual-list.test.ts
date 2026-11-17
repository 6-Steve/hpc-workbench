import { describe, expect, it } from 'vitest'
import { computeVisibleRange } from '../src/renderer/src/lib/virtual-range'

const ROW = 24

describe('computeVisibleRange：首帧与空列表', () => {
  it('列表为空时给空区间，不越界', () => {
    expect(computeVisibleRange(0, 0, 600, ROW, 8)).toEqual({ start: 0, end: 0, offsetY: 0 })
  })

  it('视口高度还没测出来（0）时不渲染任何行', () => {
    // 首帧必须空着：否则 5000 条会一次性铺满 DOM，虚拟滚动就白做了
    expect(computeVisibleRange(5000, 0, 0, ROW, 8)).toEqual({ start: 0, end: 0, offsetY: 0 })
  })
})

describe('computeVisibleRange：可见区间', () => {
  it('在顶部时从 0 开始，且只渲染视口 + overscan 的行数', () => {
    // 视口 600 / 24 = 25 行，overscan 8 → 顶部只往下多渲染 16 行
    const range = computeVisibleRange(1000, 0, 600, ROW, 8)
    expect(range.start).toBe(0)
    expect(range.end).toBe(25 + 16)
    expect(range.offsetY).toBe(0)
  })

  it('滚到中间时，start 往前让出 overscan 行', () => {
    // scrollTop 2400 → 第一条可见是第 100 行，往前让 8 行
    const range = computeVisibleRange(1000, 2400, 600, ROW, 8)
    expect(range.start).toBe(92)
    expect(range.offsetY).toBe(92 * ROW)
    expect(range.end).toBe(92 + 25 + 16)
  })

  it('渲染的行数约等于视口行数加 overscan，和数据量无关', () => {
    const small = computeVisibleRange(100, 0, 600, ROW, 8)
    const huge = computeVisibleRange(100000, 0, 600, ROW, 8)
    expect(huge.end - huge.start).toBe(small.end - small.start)
    // 十万条也只渲染四十来行，这才是虚拟滚动的意义
    expect(huge.end - huge.start).toBeLessThan(50)
  })

  it('滚到底时 end 正好等于总数，不越界', () => {
    const itemCount = 1000
    const totalHeight = itemCount * ROW
    const lastScrollTop = totalHeight - 600
    const range = computeVisibleRange(itemCount, lastScrollTop, 600, ROW, 8)
    expect(range.end).toBe(itemCount)
    expect(range.start).toBeLessThan(itemCount)
  })

  it('scrollTop 超出范围（内容刚变短）时不会算错', () => {
    // 切目录后列表从 5000 条变 10 条，scrollTop 还是旧的大值
    const range = computeVisibleRange(10, 120000, 600, ROW, 8)
    expect(range.start).toBeLessThanOrEqual(10)
    expect(range.end).toBe(10)
  })

  it('行数少于一个视口时不重复渲染', () => {
    const range = computeVisibleRange(3, 0, 600, ROW, 8)
    expect(range.start).toBe(0)
    expect(range.end).toBe(3)
  })
})
