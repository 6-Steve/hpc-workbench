/**
 * 字体方案选择器。
 *
 * ## 一个设计上的取舍
 *
 * 这里给的是**三套搭配好的方案**，不是"标题选一个、正文选一个"两个下拉。
 *
 * 中文可用的字体极少（Windows 上无衬线基本只有微软雅黑，衬线只有宋体/思源宋体），
 * 放开自由组合，九成会得到"标题宋体 + 正文雅黑"这种像误操作的结果；
 * 而且衬线中文在 12.5px 上会糊——组合错了用户只会觉得"这软件字真难看"，
 * 不会想到是自己选错了组合。
 *
 * 三套方案在 `main.css` 里各自对应一组 CSS 变量，切换只是改
 * `<html data-font>`，不需要重新构建。
 *
 * ## 预览为什么这么写
 *
 * 预览行上的 `data-font={theme.id}` 之所以能生效，是因为 `main.css` 里的
 * 选择器是 `[data-font='editorial']`（**没有** `html` 前缀）——
 * 它匹配任何带该属性的元素。所以预览不需要另外再定义一份字体栈，
 * 也就不会出现"预览和实际不一致"。
 */
import { useEffect, useState } from 'react'
import { Card, Hint } from './ui'
import {
  DEFAULT_FONT_THEME,
  FONT_THEMES,
  applyFontTheme,
  loadFontTheme,
  saveFontTheme,
  type FontThemeId
} from '../lib/font-theme'

export function FontThemeCard(): JSX.Element {
  const [current, setCurrent] = useState<FontThemeId>(DEFAULT_FONT_THEME)

  // 首帧后同步一次真实值：main.tsx 已经在渲染前应用过了，
  // 这里只是让选中态和 DOM 对齐（不重新应用，避免多余的属性写入）
  useEffect(() => {
    setCurrent(loadFontTheme())
  }, [])

  const pick = (id: FontThemeId): void => {
    setCurrent(id)
    applyFontTheme(id, document.documentElement)
    saveFontTheme(id)
  }

  return (
    <Card title="字体" tone="sky">
      <div className="space-y-2">
        {FONT_THEMES.map((theme) => {
          const active = theme.id === current
          return (
            <button
              key={theme.id}
              type="button"
              aria-pressed={active}
              onClick={() => pick(theme.id)}
              className={
                'flex w-full items-start gap-3 rounded-control border px-3 py-2.5 text-left transition ' +
                /*
                 * 选中态用**三重**差异（描边 + 底色 + 左侧实色条），
                 * 不只靠底色——极浅的底色在浅色界面里几乎看不出来，
                 * 用户会以为"点了没反应"（MEMORY 第 33 条）。
                 *
                 * 而且 `hover:` 和选中态是**互斥**三元分支，不能拼接：
                 * 同权重下后写的赢，鼠标划过选中行时底色会被 hover 抢走。
                 */
                (active
                  ? 'border-accent-500/50 bg-accent-500/[0.06] shadow-float'
                  : 'border-ink-200 bg-surface hover:border-ink-300 hover:bg-ink-50')
              }
            >
              {/* 左侧实色条：选中时的结构性标志 */}
              <span
                className={`mt-0.5 h-8 w-[3px] shrink-0 rounded-full ${
                  active ? 'bg-accent-500' : 'bg-transparent'
                }`}
              />

              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className={`text-emph font-medium ${active ? 'text-ink-900' : 'text-ink-800'}`}>
                    {theme.label}
                  </span>
                  {active && <span className="text-meta text-accent-600">使用中</span>}
                </span>
                <span className="mt-0.5 block text-sub leading-relaxed text-ink-500">{theme.hint}</span>

                {/*
                  预览：用该方案自己的字体渲染一段中英混排。
                  中英文都要有——只放拉丁字母的话，中文回退字体的问题看不出来。
                */}
                <span
                  data-font={theme.id}
                  className="mt-1.5 block truncate text-emph text-ink-700"
                  aria-hidden="true"
                >
                  <span className="font-display">集群作业 HPC Workbench</span>
                  <span className="ml-2 font-mono text-sub text-ink-500">GPU 4 × V100</span>
                </span>
              </span>
            </button>
          )
        })}
      </div>

      <Hint>
        标题与正文用同一套搭配，不是两个独立下拉——中文可选的字体很少，
        自由组合很容易配出不好看的结果。切换立刻生效，并且会记住。
      </Hint>
    </Card>
  )
}
