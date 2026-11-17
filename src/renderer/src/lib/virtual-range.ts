/**
 * 虚拟滚动的纯计算部分。
 *
 * 单独放一个文件（不含任何 JSX）有两个实际好处：
 * 1. 能被 node 侧的 tsconfig 直接编译，测试不需要配 jsx
 * 2. 这部分是最容易出 off-by-one 的地方，抽出来才能独立单测
 */

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export interface VisibleRange {
  start: number
  end: number
  /** 可见块应该偏移多少像素（= start * rowHeight） */
  offsetY: number
}

/**
 * 算当前该渲染哪一段。
 *
 * 边界约定：
 * - 列表为空 → `{start:0, end:0}`，不能返回负数区间
 * - viewport 高度还没测出来（0）→ 空区间。首帧不渲染任何行，
 *   否则 5000 条会一次性铺满 DOM，虚拟滚动就白做了
 * - 滚到底 → end 必须正好等于 itemCount，不能越界
 * - scrollTop 超出内容高度（切目录后列表变短）→ 仍然给合法区间
 */
export function computeVisibleRange(
  itemCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan: number
): VisibleRange {
  if (itemCount <= 0 || viewportHeight <= 0 || rowHeight <= 0) {
    return { start: 0, end: 0, offsetY: 0 }
  }

  const firstVisible = Math.floor(scrollTop / rowHeight)
  const visibleCount = Math.ceil(viewportHeight / rowHeight)

  const start = clamp(firstVisible - overscan, 0, itemCount)
  const end = clamp(start + visibleCount + overscan * 2, 0, itemCount)

  return { start, end, offsetY: start * rowHeight }
}
