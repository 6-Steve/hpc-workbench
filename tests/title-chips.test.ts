/**
 * 标题栏三枚「电量」数字 → 对应页签。
 *
 * ## 为什么这值得单写一个测试
 *
 * 这三条映射里有一条**明显反直觉**：标题栏写的是「存储」，对应的页签却是
 * `nodes`（资源页）——那一页同时装着显卡库存和存储配额，名字里根本没有"存储"。
 *
 * 写错了不会报错：`setTab('storage')` 如果那个 id 不存在，页面区就是一片空白，
 * 用户会以为"点了没反应"或"应用坏了"。而这三种错法编译和类型都拦不住多少
 * （`Tab` 是联合类型，能拦住拼错的 id，但拦不住"跳到能打开、但不是用户想看的页"，
 * 比如把存储映射到 `files`）。
 *
 * 所以这里不只断言"值是合法的 Tab"，还断言**每个目标页在 `DOCK_TABS` 里真实存在**
 * （运行时清单），以及映射关系本身符合约定。
 */
import { describe, expect, it } from 'vitest'
import { TITLE_CHIP_TARGETS, TITLE_CHIP_KEYS } from '../src/renderer/src/lib/title-chips'
import { DOCK_TABS } from '../src/renderer/src/lib/dock-tabs'

describe('标题栏 chip → 页签映射', () => {
  it('作业 → jobs（队列在作业页，不是资源页）', () => {
    expect(TITLE_CHIP_TARGETS.jobs).toBe('jobs')
  })

  it('存储 → nodes（资源页里才有存储配额）', () => {
    // 这条是最容易写错的一条：页签名叫 nodes，但用户看到的是"存储"
    expect(TITLE_CHIP_TARGETS.storage).toBe('nodes')
  })

  it('点数 → points', () => {
    expect(TITLE_CHIP_TARGETS.points).toBe('points')
  })

  it('每个目标页在 Dock 清单里真实存在（否则跳过去是空白）', () => {
    const ids = new Set(DOCK_TABS.map((tab) => tab.id))
    for (const key of TITLE_CHIP_KEYS) {
      const target = TITLE_CHIP_TARGETS[key]
      expect(ids.has(target), `${key} → ${target} 不在 DOCK_TABS 里`).toBe(true)
    }
  })

  it('三块 chip 不会指向同一个页（那说明有一处抄错了）', () => {
    const targets = TITLE_CHIP_KEYS.map((key) => TITLE_CHIP_TARGETS[key])
    expect(new Set(targets).size).toBe(targets.length)
  })

  it('每个目标页都有 label 和 hint（命令面板与 Dock 都靠它）', () => {
    for (const key of TITLE_CHIP_KEYS) {
      const meta = DOCK_TABS.find((tab) => tab.id === TITLE_CHIP_TARGETS[key])
      expect(meta, `${key} 找不到对应页签`).toBeDefined()
      expect(meta?.label.length).toBeGreaterThan(0)
      expect(meta?.hint.length).toBeGreaterThan(0)
    }
  })
})
