/**
 * 字体方案。
 *
 * 这里除了测逻辑，还有一条**跨文件一致性**守卫：
 * `FONT_THEMES`（TS 清单）和 `main.css` 的 `[data-font='x']` 规则必须一一对应。
 *
 * 这类"配置里定义、代码里按名字引用"的漂移，在这个项目里已经踩过三次：
 * - Tailwind token 写错 → 类名不生成 CSS，静默无样式
 * - i18n key 不存在
 * - 环境变量名拼错
 *
 * 字体方案是同一类：加了清单忘了写 CSS → 用户选了没反应；
 * 写了 CSS 忘了加清单 → 那条规则永远匹配不到。两边都不报错。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FONT_THEME,
  FONT_STORAGE_KEY,
  FONT_THEMES,
  applyFontTheme,
  isFontThemeId,
  resolveFontTheme,
  type FontThemeId
} from '../src/renderer/src/lib/font-theme'

const ROOT = join(__dirname, '..')

/** 假的根元素，记录被写/删的属性 */
function fakeRoot(): {
  setAttribute: (name: string, value: string) => void
  removeAttribute: (name: string) => void
  attrs: Map<string, string>
  removed: string[]
} {
  const attrs = new Map<string, string>()
  const removed: string[] = []
  return {
    attrs,
    removed,
    setAttribute: (name, value) => void attrs.set(name, value),
    removeAttribute: (name) => {
      attrs.delete(name)
      removed.push(name)
    }
  }
}

describe('font-theme · 清单', () => {
  it('id 不重复', () => {
    const ids = FONT_THEMES.map((theme) => theme.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('每套都有 label 和 hint（设置页要显示，空字符串等于没说明）', () => {
    for (const theme of FONT_THEMES) {
      expect(theme.label.length, theme.id).toBeGreaterThan(0)
      expect(theme.hint.length, theme.id).toBeGreaterThan(0)
    }
  })

  it('默认方案在清单里', () => {
    expect(isFontThemeId(DEFAULT_FONT_THEME)).toBe(true)
  })
})

describe('font-theme · 解析', () => {
  it('合法 id 原样返回', () => {
    for (const theme of FONT_THEMES) {
      expect(resolveFontTheme(theme.id)).toBe(theme.id)
    }
  })

  it('无效值一律退回默认，不抛异常', () => {
    /*
     * 这是启动路径：用户的 localStorage 可能被别的东西写脏，
     * 也可能是旧版本存了已删掉的方案。那时界面必须能正常显示——
     * 不能因为一个字体偏好就让首屏白掉。
     */
    for (const bad of [null, undefined, '', 'nope', 42, {}, []]) {
      expect(resolveFontTheme(bad), JSON.stringify(bad)).toBe(DEFAULT_FONT_THEME)
    }
  })

  it('isFontThemeId 挡住乱填', () => {
    expect(isFontThemeId('modern')).toBe(true)
    expect(isFontThemeId('Macaron')).toBe(false)
    expect(isFontThemeId(null)).toBe(false)
  })
})

describe('font-theme · 应用', () => {
  it('非默认方案写 data-font', () => {
    const root = fakeRoot()
    const other = FONT_THEMES.find((theme) => theme.id !== DEFAULT_FONT_THEME)!
    applyFontTheme(other.id, root)
    expect(root.attrs.get('data-font')).toBe(other.id)
  })

  it('默认方案把属性删掉，回到 :root 的默认变量', () => {
    // 这样"从没选过"和"选了默认"在 DOM 上是同一个状态，不会有两套生效路径
    const root = fakeRoot()
    applyFontTheme('editorial', root)
    applyFontTheme(DEFAULT_FONT_THEME, root)
    expect(root.attrs.has('data-font')).toBe(false)
    expect(root.removed).toContain('data-font')
  })

  it('没有 removeAttribute 的环境退回写默认值（同样没有副作用）', () => {
    const attrs = new Map<string, string>()
    const root = { setAttribute: (n: string, v: string) => void attrs.set(n, v) }
    applyFontTheme(DEFAULT_FONT_THEME, root)
    expect(attrs.get('data-font')).toBe(DEFAULT_FONT_THEME)
  })

  it('传了非法 id 也只会得到默认方案，不会写出脏属性', () => {
    const root = fakeRoot()
    applyFontTheme('bogus' as FontThemeId, root)
    expect(root.attrs.has('data-font')).toBe(false)
  })
})

describe('font-theme · 与 main.css 一致', () => {
  const css = readFileSync(join(ROOT, 'src/renderer/src/main.css'), 'utf8')

  it('非默认方案在 CSS 里都有对应的 data-font 规则', () => {
    // 加了清单却忘了写 CSS → 用户选了没反应，而且完全不报错
    const missing = FONT_THEMES.filter((theme) => theme.id !== DEFAULT_FONT_THEME).filter(
      (theme) => !css.includes(`[data-font='${theme.id}']`)
    )
    expect(missing.map((theme) => theme.id)).toEqual([])
  })

  it('CSS 里的 data-font 规则都在清单里（反向漂移）', () => {
    // 写了规则却没登记 → 那条规则永远匹配不到，白写
    const declared = [...css.matchAll(/\[data-font='([a-z-]+)'\]/g)].map((m) => m[1])
    const orphan = declared.filter((id) => !isFontThemeId(id))
    expect(orphan).toEqual([])
  })

  it('三个字体变量都在 :root 里定义过', () => {
    // 缺一个，对应的 font-sans / font-display / font-mono 就会退回浏览器默认
    for (const name of ['--font-body', '--font-display', '--font-mono']) {
      expect(css, `${name} 没有定义`).toContain(`${name}:`)
    }
  })

  it('存储键没被改掉（改了等于把所有人的选择重置）', () => {
    expect(FONT_STORAGE_KEY).toBe('hpc.ui.fontTheme')
  })
})
