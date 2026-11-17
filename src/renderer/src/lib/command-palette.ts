/**
 * 命令面板的匹配与排序。
 *
 * 用**子序列模糊匹配**而不是 `includes`：敲 `gj` 能命中「作业」是拼音键的错觉，
 * 但敲 `rl` 命中「Resource」、敲 `zy` 命中「资源页」里的字，都是子序列匹配的功劳。
 * 真正的拼音首字母缩写需要一份拼音表，这个规模不值得——先把子序列做好。
 *
 * 全是纯函数，因为排序规则特别容易"看着对但排得怪"，只能靠单测钉住。
 */

export type PaletteKind = 'nav' | 'action' | 'job'

export interface PaletteItem {
  /** 稳定 id，用来记住"最近选过什么" */
  id: string
  title: string
  /** 第二行说明，也会参与匹配（用户可能记得描述里的词） */
  subtitle?: string
  /** 额外的可搜词：英文别名、拼音、作业号之类 */
  keywords?: string
  kind: PaletteKind
}

/** 类型优先级：同样的分数下，动作/导航排在具体作业前面 */
const KIND_ORDER: Record<PaletteKind, number> = { action: 0, nav: 1, job: 2 }

/**
 * 给一个候选文本打分。不匹配返回 null。
 *
 * 打分规则（都能被单测钉住的具体数字）：
 * - 每命中一个字符 +10
 * - 与上一个命中的字符**相邻**再 +15（连续片段比散落更像"用户想打的就是这个"）
 * - 命中在**词首**（开头，或前面是空格 / `-` / `_` / `/`）再 +10
 * - 最后减去 `长度 × 0.1`：同样匹配时，短标题更可能是目标
 */
export function fuzzyScore(query: string, text: string): number | null {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return 0

  const haystack = text.toLowerCase()
  let score = 0
  let searchFrom = 0
  let previousMatch = -2

  for (const char of needle) {
    const index = haystack.indexOf(char, searchFrom)
    if (index === -1) return null

    score += 10
    if (index === previousMatch + 1) score += 15
    if (index === 0 || /[\s\-_/]/.test(haystack[index - 1] ?? '')) score += 10

    previousMatch = index
    searchFrom = index + 1
  }

  return Math.round(score - haystack.length * 0.1)
}

/** 一个条目能被搜到的最好的那个分：标题、副标题、关键词里取最高 */
function scoreItem(item: PaletteItem, query: string): number | null {
  const scores = [item.title, item.subtitle ?? '', item.keywords ?? '']
    .map((text) => (text.length > 0 ? fuzzyScore(query, text) : null))
    .filter((value): value is number => value !== null)

  if (scores.length === 0) return null
  return Math.max(...scores)
}

/**
 * 排序候选。
 *
 * @param recentIds 最近选过的 id（最近的在前），命中的会加一点权重。
 *                  "我刚点过作业页"这种上下文比字符串长度更靠谱。
 */
export function rankItems(items: PaletteItem[], query: string, recentIds: string[] = []): PaletteItem[] {
  const recentWeight = new Map(recentIds.map((id, index) => [id, Math.max(0, 30 - index * 10)]))

  const scored: Array<{ item: PaletteItem; score: number; recent: number }> = []
  for (const item of items) {
    if (query.trim().length === 0) {
      // 空查询：按类型 + 最近使用排，不按字母序——中文标题的字母序毫无意义
      scored.push({ item, score: 0, recent: recentWeight.get(item.id) ?? 0 })
      continue
    }
    const score = scoreItem(item, query)
    if (score === null) continue
    scored.push({ item, score, recent: recentWeight.get(item.id) ?? 0 })
  }

  scored.sort((a, b) => {
    // 有查询时先比匹配分，再比最近使用，最后比类型
    if (a.score !== b.score) return b.score - a.score
    if (a.recent !== b.recent) return b.recent - a.recent
    const kindDiff = KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind]
    if (kindDiff !== 0) return kindDiff
    return a.item.title.localeCompare(b.item.title, 'zh-CN')
  })

  // 空查询时没有匹配分，最近使用和类型要真的起作用
  if (query.trim().length === 0) {
    scored.sort((a, b) => {
      if (a.recent !== b.recent) return b.recent - a.recent
      return KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind]
    })
  }

  return scored.map((entry) => entry.item)
}

/**
 * 结果条数上限。
 *
 * 为什么**截断必须发生在排序之后**：这里唯一的大批量来源是 `sacct` 的
 * 7 天历史（几百条）。如果在喂给 `rankItems` 之前截断（比如
 * `[...history.slice(0, 200)]`），截掉的是**按作业号倒序**的那 200 条，
 * 而不是"和查询词最相关"的 200 条——想找上周那个 21130x 时，
 * 它完全可能正好落在第 201 条，于是搜不到，而面板只会说"没有匹配"。
 *
 * 代价是每次按键都要对全量打分。实测 600 条 × 6 字符子序列是微秒级，
 * 不值得为此牺牲正确性。
 */
export const RESULT_LIMIT = 100

/** 把最近选择列表更新一下：新的放最前，去重，最多留这么多个 */
export function pushRecent(recentIds: string[], id: string, limit = 5): string[] {
  return [id, ...recentIds.filter((item) => item !== id)].slice(0, limit)
}

/**
 * 解析存下来的"最近选择"。
 *
 * 存储里可能是任何东西：旧格式、被手改、上半次写坏、`null`、一个对象。
 * 这个功能只是给排序加权，**不值得为它冒崩溃的风险**，所以一律不信任内容：
 * 不是字符串数组就当空，单个元素不是字符串就丢掉。
 *
 * 抽成纯函数是为了能单测——`try/catch + JSON.parse` 这几个分支
 * 靠手点是点不出来的。
 */
export function parseRecentIds(raw: string | null, limit = 5): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string').slice(0, limit)
  } catch {
    return []
  }
}

/** 分组：同一个 kind 的连续结果成为一段 */
export interface PaletteGroup {
  kind: PaletteKind
  items: PaletteItem[]
  /**
   * 这一段第一项在**扁平结果数组**里的下标。
   *
   * 为什么要带这个：键盘导航（↑↓、Enter）必须继续按扁平数组算索引，
   * 否则分组会让高亮跳到错误的位置。分组只影响"怎么画"，不影响"选第几个"。
   */
  startIndex: number
}

/**
 * 把扁平结果按类型分段。
 *
 * 只对**空查询**生效：输入了查询词时用户心里已有目标，
 * 这时再插组标题只会让人多扫几行。而刚打开面板时，
 * 你看到的是"2 个动作 + 7 个导航 + 一长串作业"混在一起，
 * 想找「资源」得往下翻一大段——这才是需要分组的时候。
 *
 * 分段保持输入顺序（`rankItems` 已经排好），不在组内重排，
 * 否则"最近用过的排前面"会失效。
 */
export function groupResults(items: PaletteItem[], grouped: boolean): PaletteGroup[] {
  if (!grouped || items.length === 0) {
    return items.length === 0 ? [] : [{ kind: items[0]!.kind, items, startIndex: 0 }]
  }

  const groups: PaletteGroup[] = []
  let current: PaletteGroup | null = null

  items.forEach((item, index) => {
    if (current && current.kind === item.kind) {
      current.items.push(item)
    } else {
      current = { kind: item.kind, items: [item], startIndex: index }
      groups.push(current)
    }
  })

  return groups
}
