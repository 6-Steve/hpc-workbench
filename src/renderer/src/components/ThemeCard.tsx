/**
 * 主题选择器。
 *
 * 每张卡片是一个"色卡 + 风格说明"，不用真的预览整个界面——
 * 选中之后整站立刻变，那才是真预览。
 *
 * 色卡上的四个色块直接用 `var(--c-xxx)`，**不是**写死的 hex：
 * 这样色卡显示的永远是该主题的真实值，不会出现"色卡和实际不一致"
 * （那种不一致最难查，因为它看着只是"颜色好像不太对"）。
 */
import { useEffect, useState } from 'react'
import { Card, Hint } from './ui'
import {
  DEFAULT_THEME,
  THEMES,
  applyTheme,
  loadTheme,
  saveTheme,
  type ThemeId
} from '../lib/theme'
import { FONT_THEMES } from '../lib/font-theme'

export function ThemeCard(): JSX.Element {
  const [current, setCurrent] = useState<ThemeId>(DEFAULT_THEME)

  // main.tsx 已经在首帧前应用过，这里只是让选中态和 DOM 对齐
  useEffect(() => {
    setCurrent(loadTheme())
  }, [])

  const pick = (id: ThemeId): void => {
    setCurrent(id)
    applyTheme(id, document.documentElement)
    saveTheme(id)
  }

  return (
    <Card title="主题" tone="lilac">
      {/*
        三套主题在 `normal`（≥1180）排成一行。**不要用两列**：三张卡在两列里
        会留下一个空格子，看起来像"少了一套"或加载失败。
        低于 1180 自动回落单列堆叠，每张占满宽度。
      */}
      <div className="grid gap-2.5 normal:grid-cols-3">
        {THEMES.map((theme) => {
          const active = theme.id === current
          return (
            <button
              key={theme.id}
              type="button"
              aria-pressed={active}
              onClick={() => pick(theme.id)}
              /*
               * 选中态用**三重**差异（描边 + 底色 + 色卡边框），不只靠底色：
               * 极浅的底色在浅色界面里几乎看不出来。
               * `hover:` 和选中态是互斥三元分支，不能拼接——同权重下后写的赢，
               * 鼠标划过选中卡片时底色会被抢走（MEMORY 第 33 条）。
               */
              className={
                'group flex flex-col gap-2 rounded-control border p-3 text-left transition ' +
                'duration-quick ease-soft ' +
                (active
                  ? 'border-accent-500/60 bg-accent-500/[0.06] shadow-float'
                  : 'border-ink-200 bg-surface hover:border-ink-300 hover:bg-ink-50')
              }
            >
              {/* 色卡：四个真实色块 */}
              <span className="flex h-9 w-full overflow-hidden rounded-[6px]" aria-hidden="true">
                <span className="w-1/3" style={{ background: theme.swatch.accent }} />
                <span className="w-1/3" style={{ background: theme.swatch.canvas }} />
                <span className="w-1/3" style={{ background: theme.swatch.macaron }} />
              </span>

              <span className="flex items-baseline gap-2">
                <span className={`text-emph font-medium ${active ? 'text-ink-900' : 'text-ink-800'}`}>
                  {theme.label}
                </span>
                {active && <span className="text-meta text-accent-600">使用中</span>}
              </span>
              <span className="text-sub leading-relaxed text-ink-500">{theme.hint}</span>

              {/*
                推荐字体只是**标注**，不自动切换：字体是独立的选择器，
                主题擅自改别人的选择是隐藏行为，用户会觉得"我选过的字怎么自己变了"。
              */}
              {theme.recommendedFont && (
                <span className="text-meta text-ink-500">
                  建议搭配：
                  {FONT_THEMES.find((font) => font.id === theme.recommendedFont)?.label}
                  （在下面「字体」里选）
                </span>
              )}
            </button>
          )
        })}
      </div>

      <Hint>
        主题不只换颜色：圆角、卡片留白、阴影浓度、动效快慢都会跟着变。
        切换立刻生效，并且会记住。
      </Hint>
    </Card>
  )
}
