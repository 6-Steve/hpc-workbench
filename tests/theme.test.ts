/**
 * 主题系统。
 *
 * 除了逻辑，这里有一条**跨文件一致性**守卫：`THEMES`（TS 清单）和
 * `main.css` 的 `[data-theme='x']` 规则必须双向对得上。
 *
 * 这类"配置里定义、代码里按名字引用"的漂移，本项目已经踩过三次
 * （Tailwind token、i18n key、字体方案）：
 * 加了清单忘写 CSS → 用户选了没反应；
 * 写了 CSS 忘加清单 → 那段规则永远匹配不到。**两边都不报错。**
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_THEME,
  THEMES,
  THEME_STORAGE_KEY,
  applyTheme,
  isThemeId,
  resolveTheme,
  type ThemeId
} from '../src/renderer/src/lib/theme'

const ROOT = join(__dirname, '..')
const CSS = readFileSync(join(ROOT, 'src/renderer/src/main.css'), 'utf8')

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

describe('theme · 清单', () => {
  it('至少两套主题', () => {
    expect(THEMES.length).toBeGreaterThanOrEqual(2)
  })

  it('id 不重复', () => {
    const ids = THEMES.map((theme) => theme.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('三套主题都在清单里，且顺序稳定', () => {
    /*
     * 敦煌（默认）、纸墨（claude）、暖紫（classic）。
     * 顺序也断言：设置页按清单顺序渲染，把 classic 排到前面
     * 会让"默认主题"看起来不是第一个，容易误以为默认变了。
     */
    expect(THEMES.map((theme) => theme.id)).toEqual(['dunhuang', 'claude', 'classic'])
  })

  it('每套都有 label、hint 和四个色卡取样点', () => {
    for (const theme of THEMES) {
      expect(theme.label.length, theme.id).toBeGreaterThan(0)
      expect(theme.hint.length, theme.id).toBeGreaterThan(0)
      for (const key of ['accent', 'canvas', 'surface', 'macaron'] as const) {
        expect(theme.swatch[key], `${theme.id}.${key}`).toContain('var(--c-')
      }
    }
  })

  it('默认主题在清单里，且当前是敦煌', () => {
    // 没主动选过主题的人，看到的应该是敦煌（用户 2026-11-06 指定的主视觉）
    expect(isThemeId(DEFAULT_THEME)).toBe(true)
    expect(DEFAULT_THEME).toBe('dunhuang')
  })
})

describe('theme · 解析', () => {
  it('合法 id 原样返回', () => {
    for (const theme of THEMES) expect(resolveTheme(theme.id)).toBe(theme.id)
  })

  it('无效值一律退回默认，不抛异常', () => {
    // 这是启动路径：localStorage 被写脏、或旧版本存了已删掉的主题，界面仍要能显示
    for (const bad of [null, undefined, '', 'nope', 42, {}, []]) {
      expect(resolveTheme(bad), JSON.stringify(bad)).toBe(DEFAULT_THEME)
    }
  })

  it('isThemeId 挡住乱填', () => {
    expect(isThemeId('dunhuang')).toBe(true)
    expect(isThemeId('claude')).toBe(true)
    expect(isThemeId('classic')).toBe(true)
    expect(isThemeId('macaron')).toBe(false) // 已下线，不该再被认成合法主题
    expect(isThemeId('Dunhuang')).toBe(false)
    expect(isThemeId(null)).toBe(false)
  })
})

describe('theme · 应用', () => {
  it('非默认主题写 data-theme', () => {
    const root = fakeRoot()
    applyTheme('classic', root)
    expect(root.attrs.get('data-theme')).toBe('classic')
  })

  it('切回默认主题时把属性删掉（回到 :root 的默认变量）', () => {
    // 这样"从没选过"和"选了经典"在 DOM 上是同一个状态，不会有两条生效路径
    const root = fakeRoot()
    applyTheme('classic', root)
    applyTheme(DEFAULT_THEME, root)
    expect(root.attrs.has('data-theme')).toBe(false)
    expect(root.removed).toContain('data-theme')
  })

  it('没有 removeAttribute 的环境退回写默认值', () => {
    const attrs = new Map<string, string>()
    applyTheme(DEFAULT_THEME, { setAttribute: (n, v) => void attrs.set(n, v) })
    expect(attrs.get('data-theme')).toBe(DEFAULT_THEME)
  })

  it('非法 id 只得到默认主题，不会写出脏属性', () => {
    const root = fakeRoot()
    applyTheme('bogus' as ThemeId, root)
    expect(root.attrs.has('data-theme')).toBe(false)
  })
})

describe('theme · 与 main.css 一致', () => {
  /** 从 CSS 里取出所有 `[data-theme='x']` 的 id */
  const declaredIds = [...CSS.matchAll(/\[data-theme='([\w-]+)'\]/g)].map((m) => m[1]!)

  it('非默认主题在 CSS 里都有对应的变量块', () => {
    const missing = THEMES.filter((theme) => theme.id !== DEFAULT_THEME).filter(
      (theme) => !declaredIds.includes(theme.id)
    )
    expect(missing.map((theme) => theme.id)).toEqual([])
  })

  it('CSS 里的主题块都在清单里（反向漂移）', () => {
    const orphan = declaredIds.filter((id) => !isThemeId(id))
    expect(orphan).toEqual([])
  })

  it('每个主题块都定义了全部关键变量', () => {
    /*
     * 少一个变量不会报错——那个颜色会**从上一层继承**（`:root` 的默认值），
     * 于是新主题里混进一块旧主题的颜色，而且完全看不出是哪里错了。
     * 这是主题系统里最典型的一类"安静的错误"。
     */
    const REQUIRED = [
      '--c-canvas',
      '--c-surface',
      '--c-field',
      '--c-inverse',
      '--c-on-inverse',
      '--c-scrim',
      '--c-ink-500',
      '--c-ink-900',
      '--c-accent-500',
      '--c-state-ok',
      '--c-state-wait',
      '--c-state-bad',
      '--c-state-info',
      '--r-control',
      '--r-surface',
      '--shadow-card',
      '--pad-card-x'
    ]

    for (const id of declaredIds) {
      const block = new RegExp(`\\[data-theme='${id}'\\] \\{([\\s\\S]*?)\\n\\}`).exec(CSS)
      expect(block, `${id} 的变量块没解析出来`).not.toBeNull()
      for (const name of REQUIRED) {
        expect(block![1], `${id} 缺少 ${name}`).toContain(`${name}:`)
      }
    }
  })

  it('圆角和卡片内边距确实随主题变（不是两套一样）', () => {
    /*
     * 如果两套的 --r-surface 一样，那"主题改变手感"这句话就是假的。
     * 注意默认主题（dunhuang）在 `:root`，classic 在 `[data-theme]` 块里，
     * 所以要分别从两处读。
     */
    const themed = (id: string, name: string): string | null => {
      const block = new RegExp(`\\[data-theme='${id}'\\] \\{([\\s\\S]*?)\\n\\}`).exec(CSS)
      const found = block ? new RegExp(`${name}:\\s*([^;]+);`).exec(block[1]!) : null
      return found ? found[1]!.trim() : null
    }
    const rootVar = (name: string): string | null => {
      const block = /:root \{([\s\S]*?)\n\}/.exec(CSS)
      const found = block ? new RegExp(`${name}:\\s*([^;]+);`).exec(block[1]!) : null
      return found ? found[1]!.trim() : null
    }

    expect(themed('classic', '--r-surface')).not.toBeNull()
    expect(rootVar('--r-surface')).not.toBeNull()
    expect(themed('classic', '--r-surface')).not.toBe(rootVar('--r-surface'))
  })

  it('存储键没被改掉（改了等于把所有人的选择重置）', () => {
    expect(THEME_STORAGE_KEY).toBe('hpc.ui.theme')
  })
})
