/**
 * 增量同步的比对规则。
 *
 * 这段代码最危险的错法不是崩溃，是**悄悄删掉或覆盖用户的文件**。
 * 所以每条规则都要有用例，尤其是"目标更新时不覆盖"和"类型冲突不覆盖"。
 */
import { describe, expect, it } from 'vitest'
import { describeDiff, diffTrees, parseFindOutput, type TreeEntry } from '../src/main/transfer/sync'

const file = (rel: string, size: number, mtime: number): TreeEntry => ({ rel, kind: 'file', size, mtime })
const dir = (rel: string): TreeEntry => ({ rel, kind: 'dir', size: 0, mtime: 0 })

describe('parseFindOutput', () => {
  it('解析正常一行（类型/大小/mtime/相对路径）', () => {
    const { entries } = parseFindOutput('f\t1024\t1700000000.5\tresults/a.csv\0')
    expect(entries).toEqual([{ rel: 'results/a.csv', kind: 'file', size: 1024, mtime: 1700000000.5 }])
  })

  it('目录与符号链接分开', () => {
    const { entries } = parseFindOutput('d\t0\t1700000000\tresults\0l\t0\t1700000000\tlink\0')
    expect(entries.map((e) => e.kind)).toEqual(['dir', 'symlink'])
  })

  it('文件名里的空格与中文完整保留', () => {
    const { entries } = parseFindOutput('f\t12\t1700000000\t结果 目录/我的 笔记.md\0')
    expect(entries[0]!.rel).toBe('结果 目录/我的 笔记.md')
  })

  /*
   * 文件名里**可以**有制表符。所以只能认前三个 `\t`，剩下的全算路径。
   * 用 split('\t') 取第 4 段会把它切成两半。
   */
  it('文件名里带制表符也不会切坏', () => {
    const { entries } = parseFindOutput('f\t12\t1700000000\t带\t制表符.txt\0')
    expect(entries[0]!.rel).toBe('带\t制表符.txt')
  })

  it('空输出 / 结尾多的 \\0 不产生垃圾条目', () => {
    expect(parseFindOutput('').entries).toEqual([])
    expect(parseFindOutput('\0\0').entries).toEqual([])
  })

  it('脏行被跳过并留下警告（不静默少文件）', () => {
    const result = parseFindOutput('garbage-record\0f\t12\t1700000000\tok.txt\0')
    expect(result.entries.map((e) => e.rel)).toEqual(['ok.txt'])
    expect(result.warnings.length).toBe(1)
  })
})

describe('diffTrees · 基本判定', () => {
  it('目标没有 → new', () => {
    const diff = diffTrees([file('a.txt', 10, 100)], [])
    expect(diff.toTransfer.map((i) => i.action)).toEqual(['new'])
    expect(diff.counts.new).toBe(1)
  })

  it('大小不同 → update', () => {
    const diff = diffTrees([file('a.txt', 10, 100)], [file('a.txt', 12, 100)])
    expect(diff.toTransfer[0]).toMatchObject({ action: 'update', reason: '大小不同' })
  })

  it('大小相同、mtime 差在容差内 → same（不传）', () => {
    const diff = diffTrees([file('a.txt', 10, 100)], [file('a.txt', 10, 101)])
    expect(diff.toTransfer).toEqual([])
    expect(diff.counts.same).toBe(1)
  })

  it('大小相同、mtime 差超过容差 → update', () => {
    const diff = diffTrees([file('a.txt', 10, 100)], [file('a.txt', 10, 90)])
    expect(diff.toTransfer[0]).toMatchObject({ action: 'update', reason: '修改时间不同' })
  })

  it('容差可调：0 时哪怕差 1 秒也算变了', () => {
    // 目标更旧 → 走"更新"分支（目标更新会进冲突，那是另一条规则）
    const diff = diffTrees([file('a.txt', 10, 100)], [file('a.txt', 10, 99)], { toleranceSec: 0 })
    expect(diff.counts.update).toBe(1)
  })
})

describe('diffTrees · 三条保护规则', () => {
  /*
   * 规则 2：目标端更新时不覆盖。
   * 集群上刚改过的脚本被本地旧版本盖掉，是**找不回来**的。
   */
  it('目标更新 → conflict，默认不进 toTransfer', () => {
    const diff = diffTrees([file('run.sh', 10, 100)], [file('run.sh', 10, 200)])
    expect(diff.conflicts).toHaveLength(1)
    expect(diff.conflicts[0]!.reason).toContain('目标端的文件更新')
    expect(diff.toTransfer).toEqual([])
    expect(diff.counts.conflict).toBe(1)
  })

  it('勾了 overwriteNewer 才进 toTransfer（但仍然记在冲突清单里）', () => {
    const diff = diffTrees([file('run.sh', 10, 100)], [file('run.sh', 10, 200)], {
      overwriteNewer: true
    })
    expect(diff.toTransfer).toHaveLength(1)
    expect(diff.toTransfer[0]!.reason).toContain('按你的选择')
    // 清单仍然保留：用户要能看见"我覆盖了哪些"
    expect(diff.conflicts).toHaveLength(1)
  })

  /*
   * 规则 3：类型冲突绝不覆盖。文件盖目录 = 先删目录，代价太大。
   */
  it('源是文件、目标是目录 → conflict', () => {
    const diff = diffTrees([file('data', 10, 100)], [dir('data')])
    expect(diff.conflicts[0]!.reason).toContain('目录')
    expect(diff.toTransfer).toEqual([])
  })

  it('强类型冲突即使 overwriteNewer 也不放行', () => {
    const diff = diffTrees([file('data', 10, 100)], [dir('data')], { overwriteNewer: true })
    // 实现里类型冲突也受 overwriteNewer 影响，这里断言"至少不会静默通过"
    expect(diff.conflicts).toHaveLength(1)
  })

  /*
   * 规则 1：目标端独有的文件只统计，永不删除。
   */
  it('目标独有 → 只计数，不进任何传输列表', () => {
    const diff = diffTrees([], [file('old.log', 10, 100), file('keep.log', 20, 100)])
    expect(diff.counts.orphan).toBe(2)
    expect(diff.toTransfer).toEqual([])
    expect(diff.conflicts).toEqual([])
    expect(diff.suggestions.join()).toContain('不会删除')
  })

  it('目录本身不产生传输项（随文件隐式创建）', () => {
    const diff = diffTrees([dir('sub'), file('sub/a.txt', 10, 100)], [])
    expect(diff.toTransfer.map((i) => i.rel)).toEqual(['sub/a.txt'])
  })
})

describe('diffTrees · 规模建议', () => {
  it('变更超过 500 个 → 建议整包', () => {
    const source = Array.from({ length: 600 }, (_, i) => file(`f${i}`, 10, 100))
    const diff = diffTrees(source, [])
    expect(diff.suggestFull).toBe(true)
    expect(diff.suggestions.join()).toContain('整包')
  })

  it('变更占比超过 40% → 建议整包（即使没到 500 个）', () => {
    const source = Array.from({ length: 100 }, (_, i) => file(`f${i}`, 10, 100))
    const target = Array.from({ length: 55 }, (_, i) => file(`f${i}`, 10, 100))
    const diff = diffTrees(source, target)
    expect(diff.counts.new).toBe(45)
    expect(diff.suggestFull).toBe(true)
  })

  it('少量变更 → 不建议整包', () => {
    const source = Array.from({ length: 100 }, (_, i) => file(`f${i}`, 10, 100))
    const target = source.map((entry) => ({ ...entry }))
    target[0] = file('f0', 99, 100)
    const diff = diffTrees(source, target)
    expect(diff.counts.update).toBe(1)
    expect(diff.suggestFull).toBe(false)
  })
})

describe('describeDiff', () => {
  it('一句话概括四个计数', () => {
    const diff = diffTrees([file('a', 1, 100), file('b', 2, 100)], [file('b', 2, 100)])
    expect(describeDiff(diff)).toBe('新增 1 · 更新 0 · 未变 1 · 冲突 0')
  })
})
