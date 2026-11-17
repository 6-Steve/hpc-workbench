import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { computeVisibleRange } from '../lib/virtual-range'

export interface VirtualListProps<T> {
  items: T[]
  /** 每行固定高度（px）。固定高度是这套实现的**前提**，别传动态高度 */
  rowHeight: number
  /** 视口外额外渲染的行数，防止快速滚动时露白 */
  overscan?: number
  /** 每行渲染函数；index 是全局下标，虚拟滚动不影响它 */
  renderRow: (item: T, index: number) => JSX.Element
  /** 内容变短（比如切目录）时是否回到顶部 */
  resetKey?: string | number
  /**
   * 要求把第 N 行滚进视口。只在它确实在外面时才滚——
   * 用户鼠标刚点的行如果被强制居中，会突然跳一下，很烦。
   */
  revealIndex?: number | null
  emptyPlaceholder?: JSX.Element | null
  className?: string
  /**
   * 内联样式。**只给高度用**（maxHeight 之类）：虚拟滚动靠 `clientHeight` 实测视口，
   * 高度由 class 决定也行，但要能从外面统一控制"表最多占半屏"这种约束时，
   * 内联比在每处拼一个 max-h-[..] 类更好维护。
   */
  style?: React.CSSProperties
}

/** rowHeight 写错会让整列错位，而且症状很难看出来——在入口就拦住 */
function assertFixedRowHeight(rowHeight: number): void {
  if (!Number.isFinite(rowHeight) || rowHeight <= 0) {
    throw new Error(`rowHeight 必须是正数，收到 ${rowHeight}`)
  }
}

/**
 * 固定行高的虚拟滚动列表。
 *
 * 为什么自己写而不引库：逻辑只有「按滚动位置算出可见区间」这一件事，
 * 引一个 20 KB 的依赖换 40 行代码不划算，而且拿不到对滚动容器/测量时机的精确控制。
 *
 * 三个容易写错的地方，都有注释标出来：
 * 1. 容器高度必须在 `useLayoutEffect` 里测，不能在渲染期读（首帧拿不到）
 * 2. `resetKey` 变化要同时重置 scrollTop **和**内部记录，否则列表短了会卡在空白处
 * 3. 总高度要用 `items.length * rowHeight` 撑开，否则滚动条不会出现
 */
export function VirtualList<T>({
  items,
  rowHeight,
  overscan = 8,
  renderRow,
  resetKey,
  revealIndex = null,
  emptyPlaceholder = null,
  className,
  style
}: VirtualListProps<T>): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)

  assertFixedRowHeight(rowHeight)

  // 容器高度只能实测。窗口大小会变，所以挂 ResizeObserver 而不是只测一次。
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return

    const measure = (): void => setViewportHeight(element.clientHeight)
    measure()

    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // 内容换了（切目录、刷新后变短）就回到顶部，否则可能停在一片空白里
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return
    element.scrollTop = 0
    setScrollTop(0)
  }, [resetKey])

  // 把指定行滚进视口。只在它确实在外面时才动，避免鼠标点选时整片跳动。
  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element || revealIndex === null) return

    const top = revealIndex * rowHeight
    const bottom = top + rowHeight
    const viewTop = element.scrollTop
    const viewBottom = viewTop + element.clientHeight

    if (top < viewTop) {
      element.scrollTop = top
      setScrollTop(top)
    } else if (bottom > viewBottom) {
      const next = bottom - element.clientHeight
      element.scrollTop = next
      setScrollTop(next)
    }
  }, [revealIndex, rowHeight])

  // 滚动事件很密集，但这里只是 setState 一个数字，React 批处理足够；
  // 不做节流是为了让滚动跟手（节流会明显滞后）。
  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop)
  }, [])

  const total = items.length * rowHeight
  const { start: startIndex, end: endIndex, offsetY } = computeVisibleRange(
    items.length,
    scrollTop,
    viewportHeight,
    rowHeight,
    overscan
  )

  // 首帧 viewportHeight 还是 0，此时不渲染任何行（避免一次性铺满几千个 DOM 节点），
  // 测完之后立刻补上，用户感知不到。
  const visible = items.slice(startIndex, endIndex)

  return (
    <div ref={scrollRef} onScroll={handleScroll} style={style} className={'overflow-y-auto ' + (className ?? '')}>
      {items.length === 0 ? (
        emptyPlaceholder
      ) : (
        // 内层用相对定位 + 绝对定位的偏移块：这样只需要一个包一层的 div，
        // 不用给每行算 top，行本身还是普通文档流，好调样式。
        <div style={{ height: total, position: 'relative' }}>
          <div style={{ transform: `translateY(${offsetY}px)` }}>
            {visible.map((item, index) => (
              // key 用真实下标：虚拟窗口滑动时已渲染的行 identity 保持稳定，
              // 不会因为 slice 起点变了而整片重建 DOM。
              <div key={startIndex + index} style={{ height: rowHeight }}>
                {renderRow(item, startIndex + index)}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
