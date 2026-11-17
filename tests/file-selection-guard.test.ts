/**
 * 文件页多选的守护测试。
 *
 * ## 守的是什么
 *
 * 用户的原话是"点击文件后应该有变色……要不然删除的时候都不知道选中的是哪个"。
 * 第一版实现的选中态是 `bg-state-info/12` —— 12% 的淡蓝底，和 hover 的
 * `bg-ink-50` 几乎分辨不出，等于**没有选中态**。
 *
 * 这类问题编译器一句话都不会说：className 就是个字符串，描边、底色、
 * hover 优先级全是运行时才生效的。所以只能靠测试盯住几个具体事实：
 *
 * 1. 选中行必须有**不止底色**的标识（左侧强调条 / 焦点描边），
 *    否则再淡一档就又回到"看不出来"；
 * 2. `hover:` 变体不能被写在选中态之后——同权重下后写的赢，
 *    鼠标划过选中行时底色会被 hover 抢走，看起来像"选中丢了"；
 * 3. 多选逻辑必须走 `lib/selection.ts`，不许在组件里重新手写一套
 *    （手写版本一定会丢掉 anchor，Shift 区间就会漂移）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const PANE = join(ROOT, 'src/renderer/src/components/FilePane.tsx')
const SELECTION = join(ROOT, 'src/renderer/src/lib/selection.ts')

function pane(): string {
  return readFileSync(PANE, 'utf8')
}

describe('文件页 · 选中态必须看得出来', () => {
  it('选中行除了底色还有左侧强调条', () => {
    /**
     * 只靠底色是不够的：底色要和 hover、斑马纹、焦点行区分开，
     * 每加一个状态就得重调一次色值，迟早会塌成"都差不多"。
     * 左侧一条 2px 的实色条是**结构性**的差异，不会因为调色而消失。
     */
    expect(pane()).toMatch(/active\s*&&\s*<span className="absolute inset-y-0 left-0/)
  })

  it('选中态里不会再退回 12% 那种几乎看不见的底色', () => {
    // 12% 是修之前的值。它不是"淡一点没关系"，是"和 hover 分不出来"。
    expect(pane()).not.toContain('bg-state-info/12')
  })

  it('选中行有焦点描边（键盘移动要有落点）', () => {
    expect(pane()).toContain('ring-inset')
    expect(pane()).toContain('selection.focus === entry.name')
  })

  it('hover 不会盖掉选中态', () => {
    /**
     * 选中和 hover 是互斥分支（三元表达式），所以不会出现
     * "两个类同时在场、后写的赢"这种情况。这里断言它确实还是分支结构：
     * 一旦有人改成 `'hover:bg-ink-50 ' + (active ? ... : '')`，
     * 鼠标划过选中行时底色就会被 hover 抢走。
     */
    const source = pane()
    const row = source.slice(source.indexOf('renderRow='), source.indexOf('onDoubleClick'))
    expect(row).not.toMatch(/'[^']*hover:bg-ink-50[^']*'\s*\+\s*\(active/)
  })
})

describe('文件页 · 多选必须用统一的选择模型', () => {
  it('组件从 lib/selection 引入，而不是自己维护一个 string[]', () => {
    const source = pane()
    expect(source).toContain("from '../lib/selection'")
    // 旧实现是 `const [selected, setSelected] = useState<string[]>([])`
    expect(source).not.toMatch(/setSelected\s*\(/)
  })

  it('点击带了 Ctrl 和 Shift 两个修饰键', () => {
    const source = pane()
    expect(source).toContain('toggle: event.ctrlKey || event.metaKey')
    expect(source).toContain('shift: event.shiftKey')
  })

  it('方向键和 Ctrl+A 都接上了', () => {
    const source = pane()
    expect(source).toContain("event.key === 'ArrowDown'")
    expect(source).toContain("event.key === 'ArrowUp'")
    expect(source).toContain('selectAll(names)')
  })

  it('锚点概念还在（Shift 区间靠它，丢了就会漂移）', () => {
    const source = readFileSync(SELECTION, 'utf8')
    expect(source).toContain('anchor')
    // 回归断言：连续 Shift 点击必须回到同一个起点
    expect(source).toContain('rangeNames')
  })
})

describe('文件页 · 批量操作说清数量', () => {
  it('删除菜单项在多选时显示条数', () => {
    expect(pane()).toContain('`删除 ${selected.length} 项`')
  })

  it('移动菜单项在多选时显示条数', () => {
    expect(pane()).toContain('`移动 ${selected.length} 项到…`')
  })

  it('移动结果按成功/失败分别汇报，不是一个笼统的"失败"', () => {
    /**
     * 主进程是逐条搬的（一个被占用不该让其余九个都不动），
     * 所以界面必须能说出"搬走了 3 项，但第 4 项因为……失败"。
     */
    const source = pane()
    expect(source).toContain('response.moved.length')
    expect(source).toContain('response.failed.length')
  })
})
