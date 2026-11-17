/**
 * 主题：清单、校验、应用、持久化。
 *
 * ## 主题到底是什么
 *
 * 不是"换几个颜色"，而是 `main.css` 里**一整组 CSS 变量**：
 * 颜色（30 个）+ 圆角 + 阴影 + 卡片内边距 + 动效时长与曲线。
 * 所以切主题会同时改变颜色的**气质**和界面的**手感**——
 * 圆角从 10px 变成 12px、动效从线性变成带回弹，这些比换色更能让人感觉到"换了主题"。
 *
 * ## 为什么清单必须和 CSS 双向对齐
 *
 * 加了清单忘写 CSS → 用户选了没反应；
 * 写了 CSS 忘加清单 → 那段规则永远匹配不到。
 * **两边都不报错**，`tests/theme.test.ts` 有双向守卫。
 * 这和字体方案、Tailwind token 是同一类坑（配置里定义、代码里按名字引用）。
 */
export type ThemeId = 'dunhuang' | 'claude' | 'classic'

export interface ThemeMeta {
  id: ThemeId
  label: string
  /** 一句话风格定位 */
  hint: string
  /**
   * 建议搭配的字体方案。
   *
   * **不会自动切换**——字体是独立的选择器，主题擅自改别人的选择是"隐藏行为"，
   * 用户会觉得"我明明选过字体，怎么自己变了"。
   * 这里只在主题卡片上标一句"建议搭配"，点不点由用户决定。
   */
  recommendedFont?: 'modern' | 'editorial' | 'technical'
  /** 色卡预览用的色值，直接给 CSS 变量名，避免和 main.css 里的值二次维护 */
  swatch: {
    accent: string
    canvas: string
    surface: string
    macaron: string
  }
}

/**
 * 默认主题 = 敦煌。
 *
 * 它挂在 `:root` 上（不是 `[data-theme='dunhuang']`），所以"没选过"和
 * "选了敦煌"在 DOM 上是同一个状态，不会有两套生效路径。
 */
export const DEFAULT_THEME: ThemeId = 'dunhuang'

export const THEMES: ThemeMeta[] = [
  {
    id: 'dunhuang',
    label: '敦煌 · 矿物',
    hint: '沙金底 + 赭红 + 翡翠 + 黛紫 + 深棕。小圆角、近乎无阴影，像壁画上的一层矿物颜料。',
    swatch: {
      accent: 'var(--c-accent-500)',
      canvas: 'var(--c-canvas)',
      surface: 'var(--c-surface)',
      macaron: 'var(--c-decor-butter)'
    }
  },
  {
    id: 'claude',
    label: '纸墨 · Claude',
    hint: '米白纸 + 赤陶橙 + 深墨棕。方角、几乎无阴影，层次靠描边和留白，像印刷品。',
    recommendedFont: 'editorial',
    swatch: {
      accent: 'var(--c-accent-500)',
      canvas: 'var(--c-canvas)',
      surface: 'var(--c-surface)',
      macaron: 'var(--c-decor-mint)'
    }
  },
  {
    id: 'classic',
    label: '暖紫 · 经典',
    hint: '低饱和暖紫灰，圆角克制，阴影几乎看不见。长时间盯着不累。',
    swatch: {
      accent: 'var(--c-accent-500)',
      canvas: 'var(--c-canvas)',
      surface: 'var(--c-surface)',
      macaron: 'var(--c-decor-lilac)'
    }
  }
]

/** 存 localStorage 的键。改名会让所有人的选择被重置 */
export const THEME_STORAGE_KEY = 'hpc.ui.theme'

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && THEMES.some((theme) => theme.id === value)
}

/**
 * 把"存着的字符串"解析成可用主题。
 *
 * **任何无效值都退回默认**，不抛异常：这是启动路径（首屏要用它），
 * localStorage 可能被写脏，也可能是旧版本存了已删掉的主题。
 * 不能因为一个外观偏好就让应用白屏。
 */
export function resolveTheme(raw: unknown): ThemeId {
  return isThemeId(raw) ? raw : DEFAULT_THEME
}

/** 只依赖属性操作，测试里可以传假对象 */
export interface ThemeTarget {
  setAttribute(name: string, value: string): void
  removeAttribute?(name: string): void
}

/**
 * 应用到根元素。
 *
 * 默认主题**删掉** `data-theme`（让 CSS 走 `:root` 的默认变量）；
 * 不支持 `removeAttribute` 的环境退回写默认值，效果一样。
 */
export function applyTheme(id: ThemeId, root: ThemeTarget): void {
  const theme = resolveTheme(id)

  if (theme === DEFAULT_THEME) {
    if (typeof root.removeAttribute === 'function') {
      root.removeAttribute('data-theme')
    } else {
      root.setAttribute('data-theme', DEFAULT_THEME)
    }
    return
  }

  root.setAttribute('data-theme', theme)
}

export function loadTheme(): ThemeId {
  try {
    return resolveTheme(window.localStorage.getItem(THEME_STORAGE_KEY))
  } catch {
    // 隐私模式 / localStorage 被禁用时会直接抛，不是返回 null
    return DEFAULT_THEME
  }
}

export function saveTheme(id: ThemeId): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, resolveTheme(id))
  } catch {
    // 存不了就算了，本次运行内仍然生效
  }
}
