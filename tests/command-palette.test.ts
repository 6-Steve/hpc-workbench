/**
 * 命令面板的匹配与排序。
 *
 * 这类"看起来能用但用着别扭"的交互，问题几乎都出在排序上，
 * 所以把规则全部写成可断言的数字，而不是靠手感调。
 */
import { describe, expect, it } from 'vitest'
import {
  RESULT_LIMIT,
  fuzzyScore,
  groupResults,
  parseRecentIds,
  pushRecent,
  rankItems,
  type PaletteItem
} from '../src/renderer/src/lib/command-palette'

describe('fuzzyScore', () => {
  it('空查询返回 0（调用方负责决定此时怎么排）', () => {
    expect(fuzzyScore('', '作业')).toBe(0)
    expect(fuzzyScore('   ', '作业')).toBe(0)
  })

  it('不匹配返回 null', () => {
    expect(fuzzyScore('xyz', '作业页')).toBeNull()
  })

  it('子序列匹配：字符按顺序出现即可，中间可以跳过', () => {
    expect(fuzzyScore('stg', 'settings')).not.toBeNull()
    expect(fuzzyScore('作页', '作业页')).not.toBeNull()
  })

  it('不支持拼音首字母——这是已知边界，不是 bug', () => {
    // 敲 zy 想命中「资源」需要一份拼音表，这个规模不值得。真要做是另一个模块的事。
    expect(fuzzyScore('zy', '资源')).toBeNull()
  })

  it('顺序不对不算匹配', () => {
    expect(fuzzyScore('jz', '作业')).toBeNull()
  })

  it('连续命中比散落命中分高', () => {
    const consecutive = fuzzyScore('job', 'job')!
    const scattered = fuzzyScore('job', 'j-o-b-xyz')!
    expect(consecutive).toBeGreaterThan(scattered)
  })

  it('词首命中比词中命中分高', () => {
    const atStart = fuzzyScore('set', 'settings')!
    const inMiddle = fuzzyScore('set', 'asset')!
    expect(atStart).toBeGreaterThan(inMiddle)
  })

  it('同样匹配时短标题分更高（短的那个更可能是目标）', () => {
    const short = fuzzyScore('file', 'file')!
    const long = fuzzyScore('file', 'file-pane-with-many-more-words')!
    expect(short).toBeGreaterThan(long)
  })

  it('大小写不敏感', () => {
    expect(fuzzyScore('JOB', 'job')).toBe(fuzzyScore('job', 'JOB'))
  })

  it('中文按字符匹配', () => {
    expect(fuzzyScore('资源', '资源页')).not.toBeNull()
    expect(fuzzyScore('资页', '资源页')).not.toBeNull()
  })
})

const nav = (id: string, title: string, subtitle?: string): PaletteItem => ({
  id,
  title,
  subtitle,
  kind: 'nav'
})
const job = (id: string, title: string): PaletteItem => ({ id, title, kind: 'job' })

describe('rankItems', () => {
  it('空查询时按类型排序：动作 → 导航 → 作业', () => {
    const items: PaletteItem[] = [
      job('j1', 'train-01'),
      nav('n1', '文件'),
      { id: 'a1', title: '提交作业', kind: 'action' }
    ]
    expect(rankItems(items, '').map((item) => item.kind)).toEqual(['action', 'nav', 'job'])
  })

  it('有查询时过滤掉不匹配的', () => {
    const items = [nav('n1', '文件'), nav('n2', '作业')]
    expect(rankItems(items, '作业').map((item) => item.id)).toEqual(['n2'])
  })

  it('副标题也参与匹配（用户可能记得描述里的词）', () => {
    const items = [nav('n1', '设置', '默认目录与缓存'), nav('n2', '文件', '传文件')]
    expect(rankItems(items, '缓存').map((item) => item.id)).toEqual(['n1'])
  })

  it('关键词参与匹配（英文别名 / 作业号）', () => {
    const items: PaletteItem[] = [
      { id: 'n1', title: '作业', keywords: 'jobs', kind: 'nav' },
      { id: 'n2', title: '文件', keywords: 'files', kind: 'nav' }
    ]
    expect(rankItems(items, 'jobs').map((item) => item.id)).toEqual(['n1'])
  })

  it('分数相同的导航项，最近用过的排前面', () => {
    const items = [nav('n1', '设置'), nav('n2', '作业')]
    // 两个都是两个字，分数一样，靠 recent 决出先后
    const ranked = rankItems(items, '设', ['n1'])
    expect(ranked[0]?.id).toBe('n1')
  })

  it('空查询时最近使用的排最前', () => {
    const items = [nav('n1', '文件'), nav('n2', '作业'), nav('n3', '资源')]
    expect(rankItems(items, '', ['n3'])[0]?.id).toBe('n3')
  })

  it('一个都匹配不上时返回空数组，而不是把全部倒出来', () => {
    expect(rankItems([nav('n1', '文件')], 'zzzz')).toEqual([])
  })
})

describe('pushRecent', () => {
  it('新的放最前', () => {
    expect(pushRecent(['a', 'b'], 'c')).toEqual(['c', 'a', 'b'])
  })

  it('重复的挪到最前而不是出现两次', () => {
    expect(pushRecent(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c'])
  })

  it('超过上限就截断（老的不再影响排序）', () => {
    expect(pushRecent(['a', 'b', 'c', 'd', 'e'], 'f', 3)).toEqual(['f', 'a', 'b'])
  })
})

/**
 * 持久化的"最近选择"。
 *
 * 为什么专门测解析：存储里可能是任何东西——旧格式、被手改、上次写了一半、
 * `null`、一个对象、`[1,2,3]`。这段 `try/catch + JSON.parse` 的分支
 * 靠手点是点不出来的，而它一旦抛异常，命令面板直接白屏。
 */
describe('parseRecentIds', () => {
  it('正常情况原样读出', () => {
    expect(parseRecentIds('["a","b"]')).toEqual(['a', 'b'])
  })

  it('null / 空串 返回空数组', () => {
    expect(parseRecentIds(null)).toEqual([])
    expect(parseRecentIds('')).toEqual([])
  })

  it('坏 JSON 不抛异常，返回空数组', () => {
    expect(parseRecentIds('{not json')).toEqual([])
    expect(parseRecentIds('["unterminated')).toEqual([])
  })

  it('不是数组的（对象 / 数字 / 字符串）一律当空', () => {
    expect(parseRecentIds('{"a":1}')).toEqual([])
    expect(parseRecentIds('42')).toEqual([])
    expect(parseRecentIds('"nav:files"')).toEqual([])
  })

  it('数组里混进非字符串时只保留字符串', () => {
    // 旧版本可能存过 {id, at} 这种对象，不能让它们带着 undefined 流进排序
    expect(parseRecentIds('["nav:files",1,null,{"id":"x"},"nav:jobs"]')).toEqual(['nav:files', 'nav:jobs'])
  })

  it('按上限截断（存的比读的多也不怕）', () => {
    expect(parseRecentIds('["a","b","c","d","e","f"]', 3)).toEqual(['a', 'b', 'c'])
  })
})

/**
 * 分组渲染。
 *
 * 这里最容易写错的地方不是"怎么分段"，而是**分完段以后键盘还能不能选中正确的那条**。
 * 所以 `startIndex` 是这套设计的关键：键盘仍然按扁平数组算下标，
 * 分组只改变画法。下面专门有一条测试盯着这件事。
 */
describe('groupResults', () => {
  const items: PaletteItem[] = [
    { id: 'a1', title: '提交作业', kind: 'action' },
    { id: 'a2', title: '命令记录', kind: 'action' },
    { id: 'n1', title: '文件', kind: 'nav' },
    { id: 'n2', title: '作业', kind: 'nav' },
    { id: 'j1', title: '211301 train', kind: 'job' }
  ]

  it('按类型分段，段内保持原顺序', () => {
    const groups = groupResults(items, true)
    expect(groups.map((g) => g.kind)).toEqual(['action', 'nav', 'job'])
    expect(groups[0]!.items.map((i) => i.id)).toEqual(['a1', 'a2'])
    expect(groups[1]!.items.map((i) => i.id)).toEqual(['n1', 'n2'])
  })

  it('startIndex 是扁平数组里的绝对下标（键盘导航靠它）', () => {
    const groups = groupResults(items, true)
    expect(groups[0]!.startIndex).toBe(0)
    expect(groups[1]!.startIndex).toBe(2)
    expect(groups[2]!.startIndex).toBe(4)
  })

  it('用 startIndex + 段内偏移能还原出每一条的绝对下标', () => {
    // 这条是防回归的核心：如果哪天有人把 startIndex 改成段内偏移，
    // 分组一多，↑↓ 就会跳到别的类型的条目上
    const groups = groupResults(items, true)
    const rebuilt = groups.flatMap((g) => g.items.map((_, offset) => g.startIndex + offset))
    expect(rebuilt).toEqual([0, 1, 2, 3, 4])
  })

  it('不分段时返回一整段，startIndex 为 0', () => {
    const groups = groupResults(items, false)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.startIndex).toBe(0)
    expect(groups[0]!.items).toHaveLength(items.length)
  })

  it('同类型不连续的会被分成两段（不在组内重排，避免打乱排序结果）', () => {
    const mixed: PaletteItem[] = [
      { id: 'a1', title: '动作一', kind: 'action' },
      { id: 'n1', title: '导航一', kind: 'nav' },
      { id: 'a2', title: '动作二', kind: 'action' }
    ]
    const groups = groupResults(mixed, true)
    expect(groups.map((g) => g.kind)).toEqual(['action', 'nav', 'action'])
    expect(groups.map((g) => g.startIndex)).toEqual([0, 1, 2])
  })

  it('空结果返回空分组（不是一段空列表）', () => {
    expect(groupResults([], true)).toEqual([])
    expect(groupResults([], false)).toEqual([])
  })
})

/**
 * 命令面板的导航项必须覆盖 Dock 的**每一个**页签。
 *
 * 这条测试是在补一个真实的漏洞：原先 `App.tsx` 里手写了 5 个导航项，
 * 而 Dock 有 7 个页签——「隧道」和「终端」在命令台里搜不到。
 * 用户按 Ctrl+K 搜"隧道"得到"没有匹配"，然后就再也不信这个入口了。
 *
 * 现在两边共用 `DOCK_TABS` 单一数据源，这条测试守的是"别哪天又把它拆回两份"。
 */
describe('命令面板 · 导航项覆盖度', () => {
  it('Dock 的每个页签都能被搜到', async () => {
    const { DOCK_TABS } = await import('../src/renderer/src/lib/dock-tabs')
    const items: PaletteItem[] = DOCK_TABS.map((tab) => ({
      id: `nav:${tab.id}`,
      title: tab.label,
      subtitle: tab.hint,
      keywords: tab.keywords,
      kind: 'nav' as const
    }))

    // 7 个页签一个不能少
    expect(items).toHaveLength(DOCK_TABS.length)
    expect(items.map((item) => item.id).sort()).toEqual(DOCK_TABS.map((tab) => `nav:${tab.id}`).sort())

    // 关键回归：曾经漏掉的两个
    expect(rankItems(items, '隧道').map((item) => item.id)).toContain('nav:tunnels')
    expect(rankItems(items, '终端').map((item) => item.id)).toContain('nav:terminal')
  })

  it('每个页签都能用它自己的中文名搜到（不是只靠关键词）', async () => {
    const { DOCK_TABS } = await import('../src/renderer/src/lib/dock-tabs')
    const items: PaletteItem[] = DOCK_TABS.map((tab) => ({
      id: `nav:${tab.id}`,
      title: tab.label,
      subtitle: tab.hint,
      keywords: tab.keywords,
      kind: 'nav' as const
    }))

    for (const tab of DOCK_TABS) {
      const hit = rankItems(items, tab.label).map((item) => item.id)
      expect(hit, `搜「${tab.label}」应该能命中 nav:${tab.id}`).toContain(`nav:${tab.id}`)
    }
  })

  it('英文别名也能搜到（ssh -L / forward / shell 这类）', async () => {
    const { DOCK_TABS } = await import('../src/renderer/src/lib/dock-tabs')
    const items: PaletteItem[] = DOCK_TABS.map((tab) => ({
      id: `nav:${tab.id}`,
      title: tab.label,
      subtitle: tab.hint,
      keywords: tab.keywords,
      kind: 'nav' as const
    }))

    expect(rankItems(items, 'forward').map((item) => item.id)).toContain('nav:tunnels')
    expect(rankItems(items, 'shell').map((item) => item.id)).toContain('nav:terminal')
    expect(rankItems(items, 'sftp').map((item) => item.id)).toContain('nav:files')
  })
})

/**
 * 历史作业搜索（`sacct`）。
 *
 * 场景：「上周那个跑挂的作业 21130x，我想看日志」。它早就不在 `squeue` 里了。
 *
 * 这一组里最要紧的不是"能搜到"，而是**截断发生在排序之后**——
 * 曾经写成 `history.slice(0, 200)`（先砍再排），砍掉的是按作业号倒序的前 200 条，
 * 不是最相关的 200 条。想找的那条如果排在第 201 位，面板只会说"没有匹配"，
 * 人会以为 sacct 没数据。
 */
describe('命令面板 · 历史作业搜索', () => {
  /** 造 n 条历史作业，id 从 211000 往上，倒序（和 App.tsx 里的排序一致） */
  function makeHistory(count: number): PaletteItem[] {
    return Array.from({ length: count }, (_, index) => {
      const id = String(211000 + (count - 1 - index))
      return {
        id: `hjob:${id}`,
        title: `${id}  train-sweep-${id}`,
        subtitle: 'COMPLETED · 3 天前',
        keywords: `job history sacct train-sweep-${id}`,
        kind: 'job' as const
      }
    })
  }

  it('能从几百条历史里搜到指定作业号', () => {
    const history = makeHistory(600)
    const hit = rankItems(history, '211377')
    expect(hit.map((item) => item.id)).toContain('hjob:211377')
  })

  it('按作业名也能搜到（不是只有作业号）', () => {
    const history = makeHistory(300)
    const hit = rankItems(history, 'train-sweep-211055')
    expect(hit[0]!.id).toBe('hjob:211055')
  })

  it('截断在排序之后：排在末尾的那条，搜到它时不会被上限切掉', () => {
    // 关键回归。600 条历史 + 上限 100：如果先 slice(0,100) 再搜，
    // 最老的那条永远搜不到，而它恰恰是"上周那个"最可能的目标。
    const history = makeHistory(600)
    const oldest = `hjob:${String(211000)}`
    expect(history.at(-1)!.id).toBe(oldest)

    const ranked = rankItems(history, '211000')
    const shown = ranked.slice(0, RESULT_LIMIT)
    expect(shown.map((item) => item.id)).toContain(oldest)
  })

  it('上限只管画多少条，不管能匹配多少条', () => {
    const history = makeHistory(250)
    const ranked = rankItems(history, 'train')
    expect(ranked.length).toBe(250)
    expect(ranked.slice(0, RESULT_LIMIT)).toHaveLength(RESULT_LIMIT)
    // 被截断时要能让面板提示"100 / 250"，否则用户以为就这些
    expect(ranked.length).toBeGreaterThan(RESULT_LIMIT)
  })

  it('队列里已有的作业不会重复出现（前缀不同，按 id 去重）', () => {
    // App.tsx 里用 queuedIds 过滤：同一作业既在 squeue 又在 sacct 时只留队列那条
    const queue = ['211299', '211300']
    const history = makeHistory(50).filter((item) => !queue.includes(item.id.slice('hjob:'.length)))
    expect(history.map((item) => item.id)).not.toContain('hjob:211299')
    expect(history.every((item) => item.id.startsWith('hjob:'))).toBe(true)
  })
})
