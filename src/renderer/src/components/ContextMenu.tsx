import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface MenuItem {
  id: string
  label: string
  /** 快捷键提示，只做展示 */
  shortcut?: string
  /** 危险操作（删除）标红 */
  danger?: boolean
  disabled?: boolean
  /** 禁用时说明原因，鼠标悬停显示 */
  disabledReason?: string
}

interface ContextMenuProps {
  /** 相对视口的坐标 */
  x: number
  y: number
  items: MenuItem[]
  onSelect: (id: string) => void
  onClose: () => void
}

const MENU_WIDTH = 168
const ITEM_HEIGHT = 28

/**
 * 右键菜单。
 *
 * 两个必须处理的细节：
 * 1. **贴边翻转**：在窗口右下角右键时，菜单要往左上方向展开，否则会跑出可视区。
 * 2. **点外面就关**：用 `pointerdown` 而不是 `click`，否则松开鼠标时那一下会先触发
 *    底下的行点击（选中状态被改掉），菜单才关，感觉很奇怪。
 */
export function ContextMenu({ x, y, items, onSelect, onClose }: ContextMenuProps): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState({ left: x, top: y })

  // 首帧先按鼠标位置画，再用实测尺寸修正，避免闪一下
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return

    const height = items.length * ITEM_HEIGHT + 8
    const maxLeft = window.innerWidth - MENU_WIDTH - 8
    const maxTop = window.innerHeight - height - 8

    setPosition({
      left: Math.max(8, Math.min(x, maxLeft)),
      top: Math.max(8, Math.min(y, maxTop))
    })
  }, [x, y, items.length])

  useEffect(() => {
    const close = (event: Event): void => {
      if (ref.current && event.target instanceof Node && ref.current.contains(event.target)) return
      onClose()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }

    // 捕获阶段挂，保证在行的点击之前把菜单关掉
    document.addEventListener('pointerdown', close, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', close, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      role="menu"
      style={{ left: position.left, top: position.top, width: MENU_WIDTH }}
      className="fixed z-50 overflow-hidden rounded-surface border border-ink-200 bg-surface py-1 shadow-pop"
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          title={item.disabled ? item.disabledReason : undefined}
          onClick={() => {
            if (item.disabled) return
            onSelect(item.id)
            onClose()
          }}
          className={
            'flex w-full items-center gap-2 px-3 text-left text-body transition ' +
            (item.disabled
              ? 'cursor-not-allowed text-ink-300'
              : item.danger
                ? 'text-state-bad hover:bg-state-bad/[0.05]'
                : 'text-ink-700 hover:bg-ink-50')
          }
          style={{ height: ITEM_HEIGHT }}
        >
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          {item.shortcut && <span className="shrink-0 font-mono text-meta text-ink-500">{item.shortcut}</span>}
        </button>
      ))}
    </div>
  )
}
