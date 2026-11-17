/**
 * 标题栏浮层的守护测试。
 *
 * ## 这条测试守的是一个**真实发生过**的 bug
 *
 * `TitleBar` 上有 `backdrop-blur`。CSS 规范里带滤镜/背景模糊的元素会创建
 * **层叠上下文（stacking context）**，于是标题栏内所有元素的 z-index
 * 只在标题栏内部排序，**整体永远低于文档流后面的元素**。
 *
 * 结果：跳板机下拉、通知面板明明写了 `z-40`，却**被左侧 Dock 盖住**。
 * 加 z-index 治不了——`z-[9999]` 也一样被盖。唯一出路是 `createPortal` 到 body。
 *
 * ## 为什么必须用测试守
 * 这个 bug 的特征是：**编译通过、类型通过、单测通过、build 通过**，
 * 只有真的把面板打开并拖到 Dock 上方才看得见。而"给浮层加 z-index"
 * 是所有人第一反应，所以下次有人做新浮层时几乎必然重演。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')

/**
 * 这些组件是"挂在标题栏里的浮层"。它们必须 portal 到 body，
 * 因为就地定位会被标题栏的层叠上下文困住。
 *
 * 新增一个标题栏浮层时把它加到这里——漏加不会报错，但加进来才会有保护。
 */
const TITLEBAR_OVERLAYS = [
  'src/renderer/src/components/ProfileSwitcher.tsx',
  'src/renderer/src/components/NotificationCenter.tsx'
]

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8')
}

describe('标题栏浮层 · 必须跳出层叠上下文', () => {
  it('TitleBar 确实带 backdrop-blur（前提没变）', () => {
    // 如果哪天把毛玻璃去掉了，下面那些 portal 就不再是必须的，
    // 这条断言会先红，提醒重新评估，而不是让守卫变成无意义的教条
    expect(read('src/renderer/src/components/TitleBar.tsx')).toContain('backdrop-blur')
  })

  it('每个标题栏浮层都用了 createPortal 到 body', () => {
    const offenders = TITLEBAR_OVERLAYS.filter((file) => {
      const source = read(file)
      return !(source.includes('createPortal') && source.includes('document.body'))
    })
    expect(offenders).toEqual([])
  })

  it('标题栏浮层里不再有"贴在标题栏上"的 absolute 浮层', () => {
    /*
     * 注意区分两种 `absolute`：
     * - ✅ 铃铛上的未读红点（`absolute -right-0.5 -top-0.5`）——它相对 24px 的
     *   按钮定位，任何 z-index 都够用，也没有跨容器遮挡问题
     * - ❌ `absolute right-… top-…`（不带负号、成对给出）——这就是"贴在标题栏
     *   里的浮层"，会被 backdrop-blur 的层叠上下文困住
     *
     * 所以规则是：成对出现、且都不是负偏移的 absolute。负偏移说明它是贴在
     * 一个小元素边角的装饰，不是浮层。
     */
    const offenders = TITLEBAR_OVERLAYS.filter((file) => {
      const source = read(file)
      const matches = source.match(/className="[^"]*\babsolute\b[^"]*"/g) ?? []
      return matches.some((cls) => {
        // `(?<!-)` 是关键：`-right-0.5` 是负偏移（贴角装饰），不是浮层定位
        const hasRight = /(?<!-)\bright-(?!-)/.test(cls)
        const hasTop = /(?<!-)\btop-(?!-)/.test(cls)
        return hasRight && hasTop
      })
    })
    expect(offenders).toEqual([])
  })
})
