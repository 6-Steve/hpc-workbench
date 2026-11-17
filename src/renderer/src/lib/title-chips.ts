/**
 * 标题栏三枚「电量」数字各自跳到哪一页。
 *
 * 单独放纯数据文件、而不是写在 `TitleBar.tsx` 里，有两个理由：
 *
 * 1. `tests/*.ts` 引用 `.tsx` 会触发 `TS6142`（node 侧检查 tests、但不开 jsx），
 *    所以凡是要被测试盯住的清单都不能放在 `.tsx` 里（MEMORY 第 20 条）。
 * 2. 这里**真有一个容易写错的映射**：标题栏写的是「存储」，但对应的页签叫
 *    `nodes`（资源页）——那一页同时装着显卡库存和存储配额。写错不会报错，
 *    只是点下去跳到别的页，用户会以为点了没反应。`tests/title-chips.test.ts`
 *    专门盯着 `storage → nodes` 这一条。
 *
 * 注意「作业」是 `jobs` 而不是 `nodes`：「资源」页虽然也列节点，
 * 但标题栏那两个数字说的是**队列**（跑中 / 排队），属于作业页。
 */
import type { Tab } from './dock-tabs'

export const TITLE_CHIP_TARGETS = {
  jobs: 'jobs',
  storage: 'nodes',
  points: 'points'
} as const satisfies Record<string, Tab>

/** 三枚 chip 的键，供测试遍历 */
export const TITLE_CHIP_KEYS = ['jobs', 'storage', 'points'] as const

export type TitleChipKey = (typeof TITLE_CHIP_KEYS)[number]
