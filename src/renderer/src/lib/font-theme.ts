/**
 * 字体方案：清单、校验、应用、持久化。
 *
 * ## 为什么在 `lib/` 而不是写在设置页里
 *
 * 这里有一份**清单**（有哪些方案），而清单放 `.tsx` 里就没法被
 * `tests/*.ts` 引用（node 侧检查 tests 但不开 jsx，报 TS6142）。
 * 这和 `dock-tabs.ts` / `title-chips.ts` 是同一个理由。
 *
 * ## 为什么是「方案」而不是「标题选一个、正文选一个」
 *
 * 中文可用字体极少：Windows 上无衬线基本只有微软雅黑，衬线只有宋体/思源宋体。
 * 放开自由组合，九成会得到"标题宋体 + 正文雅黑"这种像误操作的结果，
 * 而且衬线中文在 12.5px 上会糊——组合错了用户只会觉得字难看，不会觉得是自己选错。
 *
 * 所以给三套**搭配好的**方案。每套在 `main.css` 里对应一组 CSS 变量，
 * 切换只是给 `<html>` 改一个 `data-font` 属性。
 */

export type FontThemeId = 'modern' | 'editorial' | 'technical'

export interface FontThemeMeta {
  id: FontThemeId
  label: string
  /** 一句话说明它适合什么场景 */
  hint: string
}

export const FONT_THEMES: FontThemeMeta[] = [
  {
    id: 'modern',
    label: '现代',
    hint: '标题与正文都用系统无衬线，最清晰，日常用它'
  },
  {
    id: 'editorial',
    label: '书卷',
    hint: '标题用衬线、正文用无衬线。有阅读感，又不牺牲正文清晰度'
  },
  {
    id: 'technical',
    label: '工程',
    hint: '标题用等宽体，和日志、命令的语境一致'
  }
]

export const DEFAULT_FONT_THEME: FontThemeId = 'modern'

/** 存 localStorage 的键。改名会让所有人的选择被重置 */
export const FONT_STORAGE_KEY = 'hpc.ui.fontTheme'

export function isFontThemeId(value: unknown): value is FontThemeId {
  return typeof value === 'string' && FONT_THEMES.some((theme) => theme.id === value)
}

/**
 * 把"存着的字符串"解析成一个可用的方案 id。
 *
 * **任何无效值都退回默认**，而不是抛异常或留空：
 * 这是启动路径（首屏要用它），用户的 localStorage 可能被别的东西写脏、
 * 也可能是旧版本存的已删方案——那时候界面必须能正常显示，
 * 不能因为一个字体偏好就让整个应用白屏。
 */
export function resolveFontTheme(raw: unknown): FontThemeId {
  return isFontThemeId(raw) ? raw : DEFAULT_FONT_THEME
}

/** 只依赖属性操作，所以测试里可以传一个假对象 */
export interface FontThemeTarget {
  setAttribute(name: string, value: string): void
  removeAttribute?(name: string): void
}

/**
 * 应用到根元素。
 *
 * 默认方案**优先把 `data-font` 删掉**，让 CSS 走 `:root` 里那套变量——
 * 这样"从没选过"和"选了现代"在 DOM 上是同一个状态。
 * 不支持 `removeAttribute` 的环境（测试里的假对象）退回写默认值，
 * 效果一样，只是 DOM 上多一个属性。
 */
export function applyFontTheme(id: FontThemeId, root: FontThemeTarget): void {
  const theme = resolveFontTheme(id)

  if (theme === DEFAULT_FONT_THEME) {
    if (typeof root.removeAttribute === 'function') {
      root.removeAttribute('data-font')
    } else {
      root.setAttribute('data-font', DEFAULT_FONT_THEME)
    }
    return
  }

  root.setAttribute('data-font', theme)
}

const STORAGE_FALLBACK: FontThemeId = DEFAULT_FONT_THEME

/**
 * 读取保存的方案。
 *
 * `localStorage` 在隐私模式/被禁用时会**直接抛异常**（不是返回 null），
 * 所以必须 try/catch。读失败就用默认值——字体偏好丢了不痛，
 * 让首屏崩掉才是真的糟糕。
 */
export function loadFontTheme(): FontThemeId {
  try {
    return resolveFontTheme(window.localStorage.getItem(FONT_STORAGE_KEY))
  } catch {
    return STORAGE_FALLBACK
  }
}

export function saveFontTheme(id: FontThemeId): void {
  try {
    window.localStorage.setItem(FONT_STORAGE_KEY, resolveFontTheme(id))
  } catch {
    // 存不了就存不了，本次运行内仍然是生效的
  }
}
