/**
 * 设计基准（tokens）的守护测试。
 *
 * 背景：Tailwind 有个很隐蔽的失效方式——**类名打错或没注册，样式就是不生成，
 * 但编译器一声不吭**。`text-emph` 写成 `text-emps`，页面照常渲染，只是字号没变。
 * 这种错误靠肉眼在 8000 行代码里找一个拼写是不可能发现的。
 *
 * 所以这里做两件事：
 * 1. 断言 `tailwind.config.js` 里确实注册了我们依赖的每一档 token；
 * 2. 断言源码里用到的 `text-{page,emph,body,sub,meta}` / `max-w-page` /
 *    `rounded-{control,surface}` / `shadow-{card,pop}` 都能在配置里找到对应项。
 *
 * 第 2 条尤其重要：它是"收敛"能否长期成立的唯一保障。没有它，
 * 半年后又会有人随手写 `text-[11.2px]`，然后一切从头再来。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')

/** 从配置源码里抠出某个 extend 段的键名。不 import 配置是因为它是 ESM 且含注释外的裸对象 */
function configSource(): string {
  return readFileSync(join(ROOT, 'tailwind.config.js'), 'utf8')
}

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out)
    } else if (entry.endsWith('.tsx') || entry.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

describe('tailwind tokens · 配置完整性', () => {
  const source = configSource()

  it('注册了五档字号', () => {
    for (const key of ['page', 'emph', 'body', 'sub', 'meta']) {
      expect(source).toContain(`${key}: ['`)
    }
  })

  it('注册了两档圆角（值指向主题变量）', () => {
    // 主题化之后圆角是 --r-control / --r-surface，具体 px 在 main.css 里按主题给
    expect(source).toContain("control: 'var(--r-control)'")
    expect(source).toContain("surface: 'var(--r-surface)'")
  })

  it('注册了两套阴影', () => {
    expect(source).toContain('card:')
    expect(source).toContain('pop:')
  })

  it('注册了页面栅格宽度', () => {
    expect(source).toContain("page: '1120px'")
  })

  it('注册了状态语义色（值指向主题变量）', () => {
    for (const key of ['ok', 'wait', 'bad', 'info', 'idle']) {
      // 具体色值按主题走，配置里只登记"这个名字存在"
      expect(source).toContain(`${key}: c('state-${key}')`)
    }
  })
})

describe('tailwind tokens · 源码里用到的类名都有定义', () => {
  const files = collectSourceFiles(join(ROOT, 'src', 'renderer', 'src'))
  const all = files.map((file) => readFileSync(file, 'utf8')).join('\n')
  const config = configSource()

  /** 抓出所有 `text-xxx` 里属于我们自定义字号档的那些 */
  const FONT_TOKENS = ['page', 'emph', 'body', 'sub', 'meta']

  it('用到的字号 token 都在配置里', () => {
    const used = new Set<string>()
    for (const token of FONT_TOKENS) {
      // 前面必须是 `text-` 或引号/空格边界，避免把 text-body-alias 之类算进来
      const pattern = new RegExp(`\\btext-${token}\\b`, 'g')
      if (pattern.test(all)) used.add(token)
    }
    expect(used.size).toBeGreaterThan(0)
    for (const token of used) {
      expect(config, `text-${token} 没有在 tailwind.config.js 注册`).toContain(`${token}: ['`)
    }
  })

  it('用到的 max-w-page 在配置里', () => {
    if (/\bmax-w-page\b/.test(all)) {
      expect(config).toContain("page: '1120px'")
    }
  })

  it('用到的 rounded-control / rounded-surface 在配置里', () => {
    if (/\brounded-control\b/.test(all)) expect(config).toContain("control: 'var(--r-control)'")
    if (/\brounded-surface\b/.test(all)) expect(config).toContain("surface: 'var(--r-surface)'")
  })

  it('用到的 shadow-card / shadow-pop 在配置里', () => {
    if (/\bshadow-card\b/.test(all)) expect(config).toContain('card:')
    if (/\bshadow-pop\b/.test(all)) expect(config).toContain('pop:')
  })
})

describe('tailwind tokens · 收敛没有走回头路', () => {
  const files = collectSourceFiles(join(ROOT, 'src', 'renderer', 'src'))

  it('页面标题不再用内联 22px（统一走 text-page）', () => {
    // 允许存在极少数例外，但这个数一旦涨回两位数就说明收敛失效了
    const offenders = files.filter((file) => /text-\[22px\]/.test(readFileSync(file, 'utf8')))
    expect(offenders.map((file) => file.split(/[\\/]/).pop())).toEqual([])
  })

  it('页面栅格不再各写各的 max-w-[720px|880px|980px|1100px]', () => {
    /**
     * 只查**页面骨架**（`mx-auto` + `px-8` 那层），不查弹窗。
     * 弹窗宽度本来就是各自定的（日志弹窗要 880、确认框要 460），
     * 那不是"栅格不统一"，是不同内容的合理尺寸。
     */
    const offenders = files.filter((file) => {
      const text = readFileSync(file, 'utf8')
      return /mx-auto[^"]*max-w-\[(720|880|980|1100)px\]/.test(text)
    })
    expect(offenders.map((file) => file.split(/[\\/]/).pop())).toEqual([])
  })

  it('页面骨架必须用 PageShell，不许手写 mx-auto 那一层', () => {
    /**
     * 这一条补的是**抽取了但没人用**的情况。
     *
     * 2026-11 我写了 `PageShell`，然后在 5 个页面里都留着原来的手写骨架，
     * 一天都没发现——因为编译器不会报"你有个组件没人用"。
     * 组件躺在 `ui.tsx` 里看着很整齐，实际上一行没生效。
     *
     * 例外：终端页（`TerminalView`）和文件页（`FileView`）是**满屏不滚动**的布局，
     * 骨架是 `flex-col` 而不是 `overflow-y-auto`，宽上限也不同（1440 而不是 1120）。
     * 它们不是"忘了改"，是本来就不该套滚动骨架。
     */
    const ALLOWED = new Set(['TerminalView.tsx', 'FileView.tsx', 'ui.tsx'])
    const offenders = files
      .filter((file) => !ALLOWED.has(file.split(/[\\/]/).pop() as string))
      .filter((file) => /mx-auto[^"]*max-w-page/.test(readFileSync(file, 'utf8')))
    expect(offenders.map((file) => file.split(/[\\/]/).pop())).toEqual([])
  })

  it('页面骨架都通过 PageShell 出现（组件真的被引用了）', () => {
    // 反向断言：PageShell 必须至少被一个页面 import，否则它不是"公共骨架"而是死代码
    const users = files.filter((file) => /<PageShell[\s>]/.test(readFileSync(file, 'utf8')))
    expect(users.length).toBeGreaterThanOrEqual(4)
  })

  it('页面标题统一走 PageHeader，不手写 h1 + 说明两件套', () => {
    /**
     * 同上：`PageHeader` 抽出来了就得用。
     * 手写的典型样子是 `<h1 className="text-page font-semibold text-ink-900">`，
     * 紧跟着一个 `<p className="mt-1 text-emph ...">`——间距每次都是现编的（mt-1 / mt-1.5 / 没有）。
     */
    const offenders = files
      .filter((file) => !file.endsWith('ui.tsx'))
      .filter((file) => /text-page font-semibold text-ink-900/.test(readFileSync(file, 'utf8')))
    expect(offenders.map((file) => file.split(/[\\/]/).pop())).toEqual([])
  })

  it('没有拼错的类名残骸（Tailwind 会静默吞掉它们）', () => {
    /**
     * 抓的是一类具体事故：正则批量改类名时，把 `bg-state-ok/60`
     * 改成了 `bg-state-ok/[0.06]0` —— 多留了个 `0`。
     *
     * 这个类名在 Tailwind 里匹配不到，于是**不生成任何 CSS**：
     * 状态圆点、进度条、通知徽标全部变成没有背景色的空 span。
     * 编译通过、类型检查通过、单测通过，只有肉眼能看出来——而当时我没有肉眼。
     *
     * 通用规则：`/` 后面只能是数字、`[...]` 方括号、或调色板档位，
     * 不可能出现 `]0` 这种"方括号后面还有字符"的组合。
     */
    const offenders: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      const matches = text.match(/[a-z-]+-(?:state|ink|accent)-[a-z0-9]+\/\[[^\]]*\][a-z0-9]/gi)
      if (matches) offenders.push(...matches.map((m) => `${file.split(/[\\/]/).pop()}: ${m}`))
    }
    expect(offenders).toEqual([])
  })

  /**
   * 下面五条是"四个维度收敛"的锁。
   *
   * 为什么用 `toEqual([])` 这种硬断言而不是"数量不超过 N"：
   * 十一档字号里相邻两档只差 0.5px，肉眼根本分不出，但代码里能数清。
   * 只要允许"再写一个特例"，半年后必然重新散成十几档——这正是审查前的状态。
   * 真要加新档，请去 tailwind.config.js 注册语义 token，而不是在页面里写死像素。
   */
  it('字号不再写死像素（只用 text-page/emph/body/sub/meta）', () => {
    const pattern = /text-\[\d+(?:\.\d+)?px\]/
    const offenders = files
      .map((file) => ({ file, text: readFileSync(file, 'utf8') }))
      .filter((entry) => pattern.test(entry.text))
      .map((entry) => entry.file.split(/[\\/]/).pop())
    expect(offenders).toEqual([])
  })

  it('颜色不再直接用调色板（只用 ink/accent/state 语义色）', () => {
    // 同一个"可用"曾在四处分别写成 emerald-600 / emerald-700 / sky-500 / green-500
    const pattern =
      /\b(?:text|bg|border|ring|from|to|hover:bg|hover:text|hover:border|focus:border)-(?:red|sky|emerald|amber|violet|orange|rose|teal|green|blue|gray|slate|yellow|indigo|purple|pink)-\d{2,3}\b/
    const offenders = files
      .map((file) => ({ file, text: readFileSync(file, 'utf8') }))
      .filter((entry) => pattern.test(entry.text))
      .map((entry) => entry.file.split(/[\\/]/).pop())
    expect(offenders).toEqual([])
  })

  it('圆角只用两档（rounded-control / rounded-surface，外加胶囊 rounded-full）', () => {
    // rounded-md / lg / xl 数值本来就互相重叠，名字却不同，属于纯噪声
    const pattern = /\brounded-(?:sm|md|lg|xl|2xl|3xl)\b/
    const offenders = files
      .map((file) => ({ file, text: readFileSync(file, 'utf8') }))
      .filter((entry) => pattern.test(entry.text))
      .map((entry) => entry.file.split(/[\\/]/).pop())
    expect(offenders).toEqual([])
  })

  it('阴影只用两档（shadow-card / shadow-pop）', () => {
    // shadow-sm/lg/xl 与自定义值视觉几乎一致，混用只会让层次失准
    const pattern = /\bshadow-(?:sm|md|lg|xl|2xl|inner)\b/
    const offenders = files
      .map((file) => ({ file, text: readFileSync(file, 'utf8') }))
      .filter((entry) => pattern.test(entry.text))
      .map((entry) => entry.file.split(/[\\/]/).pop())
    expect(offenders).toEqual([])
  })

  /**
   * ⚠️ 这一条拦的是"**不存在的 token**"，不是"不推荐的 token"。
   *
   * 上面两条拦 `rounded-md` / `shadow-lg` —— 它们是 Tailwind 自带的，
   * 写了有样式、只是不符合我们的收敛规则。而这里拦的名字
   * (`rounded-card` / `shadow-panel`) **在 tailwind.config.js 里根本没注册**，
   * Tailwind 匹配不到就**静默不生成 CSS**：编译通过、类型检查通过、单测通过，
   * 表现是"这一块既没有圆角也没有阴影"。
   *
   * 这是实际发生的 bug：跳板机下拉面板写的就是这两个名字，用户看到
   * "和通知面板风格不一样"——不是风格不同，是**样式压根没生效**。
   * 这类错误唯一可靠的抓法是拿源码里出现的 token 名去配置里对。
   */
  it('不许用未注册的圆角/阴影 token（Tailwind 会静默吞掉）', () => {
    const config = configSource()
    // 值可能是 `10px` 也可能是 `var(--r-control)`（主题化后），两种都要认
    const registeredRadius = [
      ...config.matchAll(/^\s{8}(\w+):\s*'(?:[\d.]+px|var\(--[\w-]+\))'/gm)
    ].map((m) => m[1])
    const registeredShadow = [...config.matchAll(/^\s{8}(\w+):\s*'[\d\sa-z(]/gm)].map((m) => m[1])
    // 配置里确实有两档，否则下面的检查会因为列表为空而变成永远通过
    expect(registeredRadius).toEqual(expect.arrayContaining(['control', 'surface']))
    expect(registeredShadow).toEqual(expect.arrayContaining(['card', 'pop']))

    const offenders: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      const name = file.split(/[\\/]/).pop() as string
      for (const match of text.matchAll(/\brounded-([a-z][a-z0-9]*)\b/g)) {
        const token = match[1] as string
        // full / none 是 Tailwind 内置的语义（胶囊、直角），不是自定义档
        if (token === 'full' || token === 'none') continue
        if (!registeredRadius.includes(token)) offenders.push(`${name}: rounded-${token}`)
      }
      for (const match of text.matchAll(/\bshadow-([a-z][a-z0-9]*)\b/g)) {
        const token = match[1] as string
        if (!registeredShadow.includes(token)) offenders.push(`${name}: shadow-${token}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('用到的语义色都在配置里注册过', () => {
    const text = files.map((file) => readFileSync(file, 'utf8')).join('\n')
    const config = configSource()
    for (const key of ['ok', 'wait', 'bad', 'info']) {
      if (new RegExp(`\\b(?:text|bg|border|ring)-state-${key}\\b`).test(text)) {
        expect(config, `state.${key} 没有在 tailwind.config.js 注册`).toContain(
          `${key}: c('state-${key}')`
        )
      }
    }
  })

  /**
   * 断点只认三档语义：compact(1040) / normal(1180) / wide(1480)。
   *
   * 默认断点是给网页的多设备适配设计的，桌面应用里用起来是错的：
   * 960 宽的窗口会命中 lg(1024) 以上，但那时两栏根本放不下。
   * 配置里虽然把 sm/md/lg/xl 重映射到了同一组数值（防止有人写默认断点时
   * 悄悄引入第四套语义），但源码本身应该只用语义名，让人一眼看出意图。
   */
  it('断点只用 compact/normal/wide，不写默认的 sm:/md:/lg:/xl:', () => {
    const pattern = /(?:^|[\s"'])(?:sm|md|lg|xl|2xl):/
    const offenders = files
      .map((file) => ({ file, text: readFileSync(file, 'utf8') }))
      .filter((entry) => pattern.test(entry.text))
      .map((entry) => entry.file.split(/[\\/]/).pop())
    expect(offenders).toEqual([])
  })

  it('三档断点的数值在配置里是 1040/1180/1480', () => {
    const config = configSource()
    expect(config).toContain("compact: '1040px'")
    expect(config).toContain("normal: '1180px'")
    expect(config).toContain("wide: '1480px'")
  })
})

/**
 * 对比度：改色板时最容易悄悄退化的地方。
 *
 * 起因是一个真实 bug：第一版 `state-ok` 取 #059669、`state-info` 取 #0284c7，
 * 看着"挺绿挺蓝"，但作为文字衬在同色 tint 背景上只有 **3.51:1 / 3.81:1**，
 * 都低于 WCAG AA 的 4.5:1——而这些颜色在界面上大量用作正文色（172 处）。
 * 更糟的是当时还有 `text-state-bad/70` 这类写法，叠加透明度后只剩 **2.95:1**。
 *
 * 所以这里做两件事：
 * 1. 断言四个状态色在三种常见衬托下都 ≥ 4.5:1；
 * 2. 断言源码里**不存在**带透明度的语义文字色（那等于把对比度交给了运气）。
 */
/** `"15 118 110"` → `"#0f766e"`。CSS 变量里存的是 RGB 三元组 */
function rgbToHex(rgb: string): string {
  const parts = rgb.trim().split(/\s+/).map((n) => Number(n))
  return '#' + parts.map((n) => n.toString(16).padStart(2, '0')).join('')
}

interface ThemeStates {
  name: string
  state: Record<string, string>
  ink500?: string
}

/**
 * 从 `main.css` 里解析出**每一套主题**的状态色。
 *
 * ## 为什么不再用硬编码常量
 *
 * 上一版这里写的是 `const STATE = { ok: '#047857', ... }`，然后断言
 * "配置里的值和这个常量一致"。只有一个主题时够用，但它有个致命盲点：
 * **加了新主题之后，新主题的色值完全没人检查**——而新主题恰恰是
 * 最容易配错的地方（马卡龙粉彩做文字必然不达标）。
 *
 * 现在直接从 CSS 里读：`:root` 是默认主题，每个 `[data-theme='x']` 是一套。
 * 加主题不需要改测试，测试自动覆盖——这才是主题系统该有的样子。
 *
 * 代价是正则解析 CSS。这里能接受：变量块的格式由 `main.css` 固定
 * （每行一个 `--c-xxx: R G B;`，块内不嵌套），正则足够可靠；
 * 而且**解析不出来会直接红**（下面有"至少两套主题"和"四个状态色齐全"兜底），
 * 不会出现"静默放过"。
 */
function readThemeStates(): ThemeStates[] {
  const css = readFileSync(join(ROOT, 'src/renderer/src/main.css'), 'utf8')
  const blocks: { name: string; body: string }[] = []

  // 默认主题挂在 :root 上
  const rootMatch = /:root \{([\s\S]*?)\n\}/.exec(css)
  if (rootMatch) blocks.push({ name: 'dunhuang', body: rootMatch[1]! })

  for (const match of css.matchAll(/\[data-theme='([\w-]+)'\] \{([\s\S]*?)\n\}/g)) {
    blocks.push({ name: match[1]!, body: match[2]! })
  }

  return blocks.map(({ name, body }) => {
    const state: Record<string, string> = {}
    for (const key of ['ok', 'wait', 'bad', 'info']) {
      const found = new RegExp(`--c-state-${key}:\\s*([\\d\\s]+);`).exec(body)
      if (found) state[key] = rgbToHex(found[1]!)
    }
    const ink = /--c-ink-500:\s*([\d\s]+);/.exec(body)
    return { name, state, ink500: ink ? rgbToHex(ink[1]!) : undefined }
  })
}

describe('tailwind tokens · 状态色对比度', () => {
  function luminance(hex: string): number {
    const value = hex.replace('#', '')
    const channels = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255)
    const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
  }

  function contrast(a: string, b: string): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (hi! + 0.05) / (lo! + 0.05)
  }

  /** 把颜色以 alpha 叠在白底上，得到实际的 tint 背景 */
  function tint(hex: string, alpha: number): string {
    const value = hex.replace('#', '')
    const fg = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16))
    const mixed = fg.map((c) => Math.round(c * alpha + 255 * (1 - alpha)))
    return '#' + mixed.map((c) => c.toString(16).padStart(2, '0')).join('')
  }

  it('至少有两套主题（主题化之后这条必须成立）', () => {
    const themes = readThemeStates()
    expect(themes.map((theme) => theme.name)).toEqual(expect.arrayContaining(['classic']))
    expect(themes.length).toBeGreaterThanOrEqual(2)
  })

  it('每套主题都定义了全部四个状态色', () => {
    for (const theme of readThemeStates()) {
      expect(Object.keys(theme.state).sort(), `${theme.name} 缺状态色`).toEqual([
        'bad',
        'info',
        'ok',
        'wait'
      ])
    }
  })

  it('每套主题的四个状态色都过三道对比度', () => {
    /*
     * 主题化之后这条检查必须**遍历所有主题**：
     * 原来只验一组硬编码值，加了新主题它完全没有保护——
     * 而新主题恰恰是最容易配错的地方（马卡龙粉彩做文字必然不达标）。
     */
    for (const theme of readThemeStates()) {
      for (const [key, value] of Object.entries(theme.state)) {
        const onTint = contrast(value, tint(value, 0.06))
        const onWhite = contrast(value, '#ffffff')
        const whiteOnIt = contrast('#ffffff', value)
        expect(onTint, `${theme.name}/state-${key} 衬 tint 只有 ${onTint.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
        expect(onWhite, `${theme.name}/state-${key} 衬白只有 ${onWhite.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
        expect(whiteOnIt, `${theme.name}/state-${key} 作背景配白字只有 ${whiteOnIt.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  it('每套主题的 ink-500 作为小字都达标（≥4.5:1）', () => {
    for (const theme of readThemeStates()) {
      expect(theme.ink500, `${theme.name} 没定义 --c-ink-500`).toBeDefined()
      const ratio = contrast(theme.ink500!, '#ffffff')
      expect(ratio, `${theme.name}/ink-500 衬白只有 ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
    }
  })

  /**
   * 马卡龙粉彩**不做文字色**。
   *
   * 这六个色衬白底的对比度只有 **1.2~1.5:1**（`#f9d5e5` 是 1.32:1），
   * 写 `text-decor-mint` 能编译、能渲染、界面上也"有一点东西"，
   * 但没人看得清——这是最难被发现的一类缺陷，因为它看着不像坏的。
   *
   * 它们的用途是**面**：卡片顶条、空状态底、图表填充、徽章底色。
   * 要文字就配 `ink-800`（衬这六个色都在 8.7~10.9:1）。
   */
  it('装饰色不做文字色（1.4~2.3:1，读不清）', () => {
    const files = collectSourceFiles(join(ROOT, 'src', 'renderer', 'src'))
    const pattern = /\btext-decor-[a-z]+\b/
    const offenders = files
      .map((file) => ({ file, text: readFileSync(file, 'utf8') }))
      .filter((entry) => pattern.test(entry.text))
      .map((entry) => entry.file.split(/[\\/]/).pop())
    expect(offenders).toEqual([])
  })

  it('装饰六个槽位都在配置里注册过', () => {
    const config = configSource()
    for (const name of ['pink', 'mint', 'lilac', 'butter', 'peach', 'sky']) {
      expect(config, `decor.${name} 没有注册`).toContain(`${name}: c('decor-${name}')`)
    }
  })

  it('语义文字色不叠透明度（叠了就必然掉到 4.5 以下）', () => {
    const files = collectSourceFiles(join(ROOT, 'src', 'renderer', 'src'))
    const pattern = /\btext-state-(?:ok|wait|bad|info)\/\d+/
    const offenders = files
      .map((file) => ({ file, text: readFileSync(file, 'utf8') }))
      .filter((entry) => pattern.test(entry.text))
      .map((entry) => entry.file.split(/[\\/]/).pop())
    expect(offenders).toEqual([])
  })

  /**
   * 灰阶：`ink-400` 不许当文字色。
   *
   * 它只有 **3.18:1**（衬白底），连 AA 的大字号放宽线（3:1）都刚擦边，
   * 而实际用法里 89 处是 `text-meta`(10.5px) / `text-sub`(11.5px) 这种小字。
   * 小字的可读性要求比大字号**更严**，不是更松。
   *
   * 为什么不是把它整体调深：调到 4.5 需要 #66738d，正好撞上 `ink-500`，
   * 中间档就没了、层次会塌。所以这里定的是**用途**而不是数值：
   * `ink-400` 留给边框/背景/禁用态这类不需要读的场合，文字一律从 `ink-500` 起。
   */
  it('文字色不用 ink-400（3.18:1，小字读不清）', () => {
    const files = collectSourceFiles(join(ROOT, 'src', 'renderer', 'src'))
    const pattern = /\btext-ink-400\b/
    const offenders = files
      .map((file) => ({ file, text: readFileSync(file, 'utf8') }))
      .filter((entry) => pattern.test(entry.text))
      .map((entry) => entry.file.split(/[\\/]/).pop())
    expect(offenders).toEqual([])
  })

  it('ink-500 及以上作为小字也达标（≥4.5:1）', () => {
    // ink-500 = #66738d，衬白底 4.77:1；衬 ink-50 4.45:1（四舍五入到 4.5）
    const INK_500 = '#66738d'
    const onWhite = contrast(INK_500, '#ffffff')
    expect(onWhite).toBeGreaterThanOrEqual(4.5)
  })
})

/**
 * 深色底（`ink-900`）上的文字。
 *
 * 启动页是**全站唯一的深色页面**，当时全部用 `text-white/30` 这类写法手感调深浅。
 * 算完才发现 `ink-900`(#343945) 上白字的**最小可用 alpha 是 0.53**：
 *
 *   white/20 → 1.86:1    white/30 → 2.47:1    white/40 → 3.26:1
 *   white/45 → 3.71:1    white/55 → 5.03:1    white/62 → 5.57:1
 *
 * 而启动页有 11 处落在 1.86–3.71 之间。这批字不难看到"完全消失"，而是
 * **"灰蒙蒙地在那儿、但读起来费劲"**——比彻底看不见更难受，也更容易被忽略。
 *
 * 所以定了 `night-sub/body/emph` 三档实色，并把这条也纳入硬约束：
 * **深色底不许再用 `text-white/<alpha>` 调深浅**。
 */
describe('tailwind tokens · 深色底对比度', () => {
  const NIGHT_BG = '#343945' // ink-900
  const NIGHT = { sub: '#b2b4b8', body: '#c6c8cb', emph: '#e7e7e9', bad: '#ff9b9b' }

  function luminance(hex: string): number {
    const value = hex.replace('#', '')
    const channels = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255)
    const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
  }

  function contrast(a: string, b: string): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (hi! + 0.05) / (lo! + 0.05)
  }

  it('配置里的 night 四档与测试基准一致（改色必须同步改这里）', () => {
    const config = configSource()
    for (const [key, value] of Object.entries(NIGHT)) {
      expect(config, `night.${key} 应为 ${value}`).toContain(`${key}: '${value}'`)
    }
  })

  it('每一档衬在 ink-900 上都 ≥ 4.5:1', () => {
    for (const [key, value] of Object.entries(NIGHT)) {
      const ratio = contrast(value, NIGHT_BG)
      expect(ratio, `text-night-${key} 衬 ink-900 只有 ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('每一档彼此可分（相邻档至少差 0.8:1，否则三档等于一档）', () => {
    const sub = contrast(NIGHT.sub, NIGHT_BG)
    const body = contrast(NIGHT.body, NIGHT_BG)
    const emph = contrast(NIGHT.emph, NIGHT_BG)
    expect(body - sub, `sub→body 只差 ${(body - sub).toFixed(2)}`).toBeGreaterThanOrEqual(0.8)
    expect(emph - body, `body→emph 只差 ${(emph - body).toFixed(2)}`).toBeGreaterThanOrEqual(0.8)
  })

  it('深色底不许用 text-white/<alpha> 调深浅（薄的那几档只有 1.9–3.7:1）', () => {
    /**
     * 只拦 `text-white/数字`。`text-white` 本身是 11.56:1，没问题；
     * `bg-white/10`、`border-white/15` 这类是装饰性半透明，与可读性无关，不拦。
     */
    const files = collectSourceFiles(join(ROOT, 'src', 'renderer', 'src'))
    const pattern = /\btext-white\/\d+/
    const offenders = files
      .map((file) => ({ file, text: readFileSync(file, 'utf8') }))
      .filter((entry) => pattern.test(entry.text))
      .map((entry) => entry.file.split(/[\\/]/).pop())
    expect(offenders).toEqual([])
  })

  it('night-* 只许出现在深色底上（衬白底几乎看不见）', () => {
    /**
     * `night-sub`(#b2b4b8) 衬白底只有 1.62:1。这套色**只属于深色底**。
     * 目前合法的宿主只有两个，且都确认过底色：
     * - `BootSplash.tsx`：整页 `bg-ink-900`
     * - `Dock.tsx`：悬停提示，`bg-ink-900/95`
     *
     * 往白底页面上用会红——那时候应该用 `ink-*`，不是 `night-*`。
     */
    const ALLOWED = new Set(['BootSplash.tsx', 'Dock.tsx'])
    const files = collectSourceFiles(join(ROOT, 'src', 'renderer', 'src'))
    const offenders = files
      .map((file) => ({ file, text: readFileSync(file, 'utf8') }))
      .filter((entry) => /\btext-night-/.test(entry.text))
      .map((entry) => entry.file.split(/[\\/]/).pop() as string)
      .filter((name) => !ALLOWED.has(name))
    expect(offenders).toEqual([])
  })
})

/**
 * 类名不是类型——这一条是本项目踩过两次的坑，所以单独守一遍。
 *
 * Tailwind 对**没登记的类名静默跳过**：编译不报错、单测不报错，
 * 只是那段 CSS 压根不生成。表现是"这段样式好像没生效"，
 * 但没人会想到是名字写错了。
 *
 * 已经踩到的两次：
 * 1. `rounded-card` / `shadow-panel`（跳板机下拉卡片没有圆角和阴影）
 * 2. `text-state-warning` / `bg-state-success` / `text-state-danger`
 *    （实际叫 `state-wait` / `state-ok` / `state-bad`，点数页一上来就写错）
 *
 * 所以这里不再逐个系列手写正则，而是**把源码里所有 `前缀-名字` 形态的
 * 类名扫出来，拿去和配置里的注册表核对**。前缀必须是会被 Tailwind
 * 当 token 解的那几个，否则误报会淹没真问题。
 */
describe('tailwind tokens · 用到的名字必须真的存在', () => {
  /** 从 tailwind.config.js 里读出一组具名 token */
  function readTokenNames(): {
    colors: Set<string>
    fontSize: Set<string>
    borderRadius: Set<string>
    boxShadow: Set<string>
  } {
    const config = readFileSync(join(ROOT, 'tailwind.config.js'), 'utf8')

    /** 抓某个对象字面量里的一级键 */
    const keysOf = (block: string): Set<string> => {
      const names = new Set<string>()
      for (const match of block.matchAll(/^\s{6,}([A-Za-z][\w-]*):/gm)) names.add(match[1]!)
      return names
    }

    /** 取 `name: { ... }` 这个块的文本（按大括号配对，够用） */
    const blockOf = (source: string, name: string): string => {
      const start = source.indexOf(`${name}: {`)
      if (start < 0) return ''
      let depth = 0
      for (let i = start; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1
        else if (source[i] === '}') {
          depth -= 1
          if (depth === 0) return source.slice(start, i + 1)
        }
      }
      return ''
    }

    // 颜色是多层嵌套：colors.{ink,state,night} 是对象，其它是字符串
    const colors = new Set<string>()
    const colorsBlock = blockOf(config, 'colors')
    for (const match of colorsBlock.matchAll(/^\s{8}([A-Za-z][\w-]*):/gm)) colors.add(match[1]!)
    for (const group of ['ink', 'state', 'night', 'decor']) {
      const groupBlock = blockOf(colorsBlock, group)
      for (const match of groupBlock.matchAll(/^\s{10,}([A-Za-z][\w-]*):/gm)) {
        colors.add(`${group}-${match[1]}`)
      }
    }

    return {
      colors,
      fontSize: keysOf(blockOf(config, 'fontSize')),
      borderRadius: keysOf(blockOf(config, 'borderRadius')),
      boxShadow: keysOf(blockOf(config, 'boxShadow'))
    }
  }

  it('颜色类名（text-/bg-/border-/ring-/accent-）都能在配置里找到', () => {
    const tokens = readTokenNames()
    const files = collectSourceFiles(join(ROOT, 'src', 'renderer', 'src'))

    /**
     * 前缀相同、语义不同，必须分开处理：
     *
     * | 前缀 | 可能是 | 处理 |
     * |---|---|---|
     * | `text-` | 颜色 / 字号 | 命中字号名的放行 |
     * | `border-` | 颜色 / 宽度 / 方向 | 数字和方位词放行 |
     * | `bg-` `ring-` `fill-` `stroke-` `accent-` | 基本都是颜色 | 直接核对 |
     *
     * 第一版没有分离，一次报了 134 处误报（全是 `text-sub` 这种字号），
     * 那种测试没人会看，等于没写。
     */
    const PATTERN = /\b(text|bg|border|ring|accent|fill|stroke)-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\b/g

    /** Tailwind 内置色名与非 token 的关键字 */
    const BUILTIN = new Set([
      'white', 'black', 'transparent', 'current', 'inherit', 'none', 'auto', 'inset',
      'left', 'right', 'top', 'bottom', 'center', 'start', 'end',
      'slate', 'gray', 'zinc', 'neutral', 'stone', 'red', 'orange', 'amber', 'yellow',
      'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet',
      'purple', 'fuchsia', 'pink', 'rose'
    ])
    /** 内置色阶（`red-400`、`sky-700`） */
    const isPaletteShade = (name: string): boolean => /^[a-z]+-\d{2,3}$/.test(name)
    /** 字号名（`text-sub` / `text-page`）——它们不是颜色，但前缀也是 text- */
    const isFontSize = (name: string): boolean => tokens.fontSize.has(name)
    /** 边框宽度与方位：`border-2`、`border-b`、`border-t-2`、`border-x` */
    const isBorderGeometry = (name: string): boolean =>
      /^\d+$/.test(name) ||
      // 纯方位或方位+宽度：`border-b`、`border-t-2`、`border-x`
      /^[tblrxyse](-\d+)?$/.test(name) ||
      // 方位 + 内置色：`border-l-transparent`（Tailwind 允许这种组合）
      /^[tblrxyse]-(transparent|current|white|black|inherit)$/.test(name) ||
      /^(collapse|separate|solid|dashed|dotted)$/.test(name)

    const offenders: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(PATTERN)) {
        const prefix = match[1]!
        const name = match[2]!
        if (BUILTIN.has(name)) continue
        if (isPaletteShade(name)) continue
        // 组-子名形态（state-ok / ink-500 / night-sub）在注册表里
        if (tokens.colors.has(name)) continue
        if (prefix === 'text' && isFontSize(name)) continue
        if (prefix === 'border' && isBorderGeometry(name)) continue
        offenders.push(`${file.split(/[\\/]/).pop()}: ${match[0]}`)
      }
    }

    expect([...new Set(offenders)]).toEqual([])
  })

  it('rounded-* / shadow-* 都能在配置里找到', () => {
    const tokens = readTokenNames()
    const files = collectSourceFiles(join(ROOT, 'src', 'renderer', 'src'))

    /** 内置的圆角/阴影名 */
    const BUILTIN_ROUNDED = new Set(['none', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', 'full', 'card'])
    const BUILTIN_SHADOW = new Set(['none', 'sm', 'md', 'lg', 'xl', '2xl', 'inner'])

    const offenders: string[] = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/\brounded-([a-z][a-z0-9]*)\b/g)) {
        const name = match[1]!
        if (BUILTIN_ROUNDED.has(name) || tokens.borderRadius.has(name)) continue
        offenders.push(`${file.split(/[\\/]/).pop()}: ${match[0]}`)
      }
      for (const match of text.matchAll(/\bshadow-([a-z][a-z0-9]*)\b/g)) {
        const name = match[1]!
        if (BUILTIN_SHADOW.has(name) || tokens.boxShadow.has(name)) continue
        offenders.push(`${file.split(/[\\/]/).pop()}: ${match[0]}`)
      }
    }

    expect([...new Set(offenders)]).toEqual([])
  })
})
