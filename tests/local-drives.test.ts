import { describe, expect, it } from 'vitest'
import { DRIVES_ROOT, listLocalDir } from '../src/main/fs/listing'

/**
 * 「此电脑」这一层的测试。
 *
 * 为什么单独写：`path.dirname('C:\\')` 在 Windows 上返回的是 `'C:/'`（正斜杠！），
 * 所以"上一级"会算成 `C:/` 而不是回到盘符列表。这个坑只有跑真机才看得出来。
 */
describe('本地驱动器列表（此电脑）', () => {
  it('虚拟根标记对，且不是普通目录', async () => {
    const listing = await listLocalDir(DRIVES_ROOT)
    expect(listing.virtualRoot).toBe(true)
    expect(listing.path).toBe(DRIVES_ROOT)
    // 已经是顶层了，没有上一级
    expect(listing.parent).toBeNull()
  })

  it('至少能列出一个盘（跑测试的机器上一定有）', async () => {
    const listing = await listLocalDir(DRIVES_ROOT)
    expect(listing.entries.length).toBeGreaterThan(0)

    if (process.platform === 'win32') {
      // 每个条目是 `C:` 这种形式，不带分隔符
      for (const entry of listing.entries) {
        expect(entry.name).toMatch(/^[A-Z]:$/)
        expect(entry.kind).toBe('dir')
      }
    }
  })

  it('盘符根的上一级是「此电脑」，不是它自己', async () => {
    const drives = await listLocalDir(DRIVES_ROOT)
    const first = drives.entries[0]!
    const sep = process.platform === 'win32' ? '\\' : ''
    const rootPath = process.platform === 'win32' ? `${first.name}${sep}` : first.name

    const root = await listLocalDir(rootPath)
    expect(root.parent).toBe(DRIVES_ROOT)
  })

  it('从盘符根返回后，又回到带 virtualRoot 标记的列表', async () => {
    const drives = await listLocalDir(DRIVES_ROOT)
    const first = drives.entries[0]!
    const sep = process.platform === 'win32' ? '\\' : ''
    const rootPath = process.platform === 'win32' ? `${first.name}${sep}` : first.name

    const root = await listLocalDir(rootPath)
    const back = await listLocalDir(root.parent!)
    expect(back.virtualRoot).toBe(true)
    expect(back.entries.map((e) => e.name)).toEqual(drives.entries.map((e) => e.name))
  })

  it('正斜杠写法也能认出来（dirname 会吐正斜杠）', async () => {
    if (process.platform !== 'win32') return
    const listing = await listLocalDir('C:/')
    expect(listing.parent).toBe(DRIVES_ROOT)
  })
})
