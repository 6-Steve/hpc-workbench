/** @type {import('tailwindcss').Config} */

/**
 * 设计基准（tokens）· **主题化版本**。
 *
 * ## 这一版最重要的变化：颜色不再是常量，而是 CSS 变量
 *
 * 上一版把颜色写死在这里，改配色要改配置 + 重新构建，而且**只能有一套**。
 * 现在所有颜色都是 `rgb(var(--c-xxx) / <alpha-value>)`：
 *
 * - 主题 = `main.css` 里的一组 `--c-*` 变量值
 * - 切主题 = 给 `<html>` 改 `data-theme`，**不需要重新构建**
 * - 加主题 = 在 `main.css` 加一组变量 + 在 `lib/theme.ts` 登记，两处都对得上才算数
 *
 * 用 `rgb(... / <alpha-value>)` 而不是 `var(--c-xxx)` 直接塞 hex，
 * 是因为这样才能继续用 `bg-surface/70` 这种透明度修饰符
 * （标题栏、浮层大量依赖它，整片玻璃感靠这个）。
 *
 * ## 一条不能让步的约束
 *
 * **粉彩只能做「面」，不能做「字」。** 马卡龙粉衬白底只有 1.2~1.5:1，
 * 做正文色是不可读的。所以配色分两层：
 *
 * | 层 | 用什么 | 例子 |
 * |---|---|---|
 * | 面（背景、装饰、描边、图表填充） | `decor-*` | 卡片顶条、hover 底、徽章底 |
 * | 字（正文、语义提示） | 同色系的**深调** `ink-*` / `state-*` | `state-ok` 是薄荷深调 |
 *
 * 换句话说：**色相走主题，明度必须够深才配做字**。
 * 每套主题的语义色都要单独过三道对比度检查，`tests/design-tokens.test.ts` 会遍历所有主题。
 *
 * ## 语义色（新增，主题化的关键）
 *
 * 组件里原来直接写 `bg-white`（96 处）和 `bg-ink-900`（32 处）。这些**不是主题的一部分**
 * ——改 token 值影响不到"白色是不是纯白"，所以上一轮"很多颜色没改到"。
 * 现在给它们建立了语义替身：
 *
 * | token | 含义 | 替代了什么 |
 * |---|---|---|
 * | `canvas` | 页面底 | `body` 背景 |
 * | `surface` | 卡面 / 浮层面 | `bg-white` |
 * | `field` | 输入框面（可比卡片略灰） | 输入框的 `bg-white` |
 * | `inverse` | 反色面（主按钮底） | `bg-ink-900` |
 * | `on-inverse` | 反色面上的文字 | `text-white` |
 * | `scrim` | **固定深色**（启动页、Dock） | 那两处的 `bg-ink-900` |
 *
 * `scrim` 刻意**不随主题变**：启动页和 Dock 的深色是品牌锚点，
 * 浅色主题下它是"开场分界"，切到深色主题也不能变成浅色，否则那两块会反向发光。
 */
const c = (name) => `rgb(var(--c-${name}) / <alpha-value>)`

export default {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        /* —— 语义面 —— */
        canvas: c('canvas'),
        surface: c('surface'),
        field: c('field'),
        inverse: c('inverse'),
        'on-inverse': c('on-inverse'),
        scrim: c('scrim'),

        /**
         * 中性色：主题的"地基"，界面上占面积最大（边框、hover 底、次要文字）。
         * 各级的对比度标注见 `tests/design-tokens.test.ts` 的逐主题检查。
         */
        ink: {
          50: c('ink-50'),
          100: c('ink-100'),
          200: c('ink-200'),
          300: c('ink-300'),
          /** 只做边框/分隔/禁用/占位，**不做文字**（2.5~2.6:1） */
          400: c('ink-400'),
          /** 文字色的最低档，各主题都保证 ≥5:1 */
          500: c('ink-500'),
          600: c('ink-600'),
          700: c('ink-700'),
          800: c('ink-800'),
          900: c('ink-900'),
          950: c('ink-950')
        },

        /** 主色：焦点环、选中态、少量强调。不做大面积铺色 */
        accent: {
          400: c('accent-400'),
          500: c('accent-500'),
          600: c('accent-600')
        },

        /**
         * 状态色：**语义化**，一个状态只有一个名字。
         *
         * ⚠️ 每个值同时被当作**背景、边框、文字**三种角色用（170+ 处是正文），
         * 所以每套主题的这四个色都要同时通过三道检查：
         * 1. 作为文字，衬同色 6% tint ≥ 4.5:1
         * 2. 作为文字，衬纯白（或该主题的 surface）≥ 4.5:1
         * 3. 作为**实色背景**，衬白字 ≥ 4.5:1
         *
         * 第 3 条最狠：粉彩色在这里必然失败，所以状态色只能是"马卡龙色相的深调"。
         */
        state: {
          ok: c('state-ok'),
          wait: c('state-wait'),
          bad: c('state-bad'),
          info: c('state-info'),
          idle: c('state-idle')
        },

        /**
         * 装饰色槽位：**只做面，不做字**。
         *
         * 用途：卡片顶部的 3px 色条、徽章底、图表填充。它们**不承载文字**，
         * 所以可以直接用饱和的锚色（敦煌主题里 `decor-mint` 就是 `#03875C` 本身）。
         *
         * 守卫禁止 `text-decor-*`——那些色做文字只有 1.4~2.3:1，读不清。
         * （名字从 `macaron-*` 改过来：马卡龙主题已删除，旧名字会误导。）
         */
        decor: {
          pink: c('decor-pink'),
          mint: c('decor-mint'),
          lilac: c('decor-lilac'),
          butter: c('decor-butter'),
          peach: c('decor-peach'),
          sky: c('decor-sky')
        },

        /**
         * 深色底专用文字色（启动页 / Dock）。
         *
         * **不随主题变**——那两块的底色固定（`scrim`），文字色自然也该固定。
         * 层级是"深底上越白越强"，和 `ink-*` 完全相反，两套不能混用。
         */
        night: {
          sub: '#b2b4b8',
          body: '#c6c8cb',
          emph: '#e7e7e9',
          bad: '#ff9b9b'
        }
      },
      /**
       * 字体：CSS 变量，运行时可切换（见 `main.css` 的 `[data-font]`）。
       * `display` 是标题，`sans` 是正文，两者可以不同。
       */
      fontFamily: {
        sans: ['var(--font-body)'],
        display: ['var(--font-display)'],
        mono: ['var(--font-mono)']
      },
      /**
       * 字号五档。命名按**信息角色**而不是尺寸，微调数值不会让类名说谎。
       * - page  页标题（一屏一个）
       * - emph  强调：数值、卡片标题、按钮主文案
       * - body  正文：表格行、说明、表单值
       * - sub   辅助：次要说明、时间戳、单位
       * - meta  元信息：表头、角标、极短的标签
       */
      fontSize: {
        page: ['22px', { lineHeight: '1.3', letterSpacing: '-0.01em' }],
        emph: ['13px', { lineHeight: '1.5' }],
        body: ['12.5px', { lineHeight: '1.65' }],
        sub: ['11.5px', { lineHeight: '1.55' }],
        meta: ['10.5px', { lineHeight: '1.5' }]
      },
      /**
       * 圆角：两档，但值**随主题变**（`--r-control` / `--r-surface`）。
       * 「马卡龙甜梦」是 12/18（圆润），「经典」是 10/14（中性）。
       * 这不是审美细节——圆角大小直接决定"这软件是工具还是消费级 App"。
       */
      borderRadius: {
        control: 'var(--r-control)',
        surface: 'var(--r-surface)'
      },
      /** 阴影：随主题变（马卡龙是紫雾柔光，经典是极淡中性影） */
      boxShadow: {
        card: 'var(--shadow-card)',
        pop: 'var(--shadow-pop)',
        float: 'var(--shadow-float)'
      },
      /**
       * 卡片内边距：**间距也能主题化**。
       * 「经典」16/20（紧凑），「马卡龙甜梦」20/24（松，更有呼吸感）。
       * 只作用于 `Card`/`PageShell` 这类大容器，表格行距不动——松紧一乱，密集表格会散架。
       */
      spacing: {
        'card-x': 'var(--pad-card-x)',
        'card-y': 'var(--pad-card-y)'
      },
      /** 动效：快慢与缓动曲线随主题变（甜梦带回弹，经典是线性） */
      transitionDuration: {
        quick: 'var(--dur-quick)',
        base: 'var(--dur-base)'
      },
      transitionTimingFunction: {
        soft: 'var(--ease-soft)'
      },
      maxWidth: {
        // 统一页面栅格。之前是 720 / 880 / 980 / 1100 四套，切页时内容宽度整体跳动
        page: '1120px',
        // 宽屏（≥ 1480）下放宽一档：1920 的屏上两侧各空 400px 太浪费，看表格要来回扫
        'page-wide': '1400px'
      },
      /**
       * 断点按**窗口宽度**定，不按设备定。
       *
       * 这是桌面应用，没有手机和平板：默认的 sm(640)/md(768)/lg(1024)/xl(1280)
       * 是给网页设计的，在小窗口里断得乱七八糟——960 宽的窗口会命中 lg，
       * 但那时两栏布局根本放不下。所以只留三档，且按"这个宽度下能放下几栏"来命名：
       *
       * - `compact`  (≥ 1040) 单栏：侧边栏 56 + 页面边距 64 之后只剩 ~920，两栏装不下
       * - `normal`   (≥ 1180) 两栏：左内容 + 右 320 窄栏（这是设计目标尺寸）
       * - `wide`     (≥ 1480) 两栏且放宽：大屏上让内容变宽，而不是留白
       *
       * 低于 1040 不需要额外类：单栏是默认值（mobile-first）。
       * 窗口最小宽度在 main/index.ts 锁了 960，所以不存在更窄的情况。
       */
      screens: {
        compact: '1040px',
        normal: '1180px',
        wide: '1480px',
        // 把默认断点全部覆盖掉，防止有人顺手写 sm:/lg: 又引入一套语义
        sm: '1040px',
        md: '1180px',
        lg: '1180px',
        xl: '1480px',
        '2xl': '1480px'
      }
    }
  },
  plugins: []
}
