import { describe, expect, it } from 'vitest'
import { fileUrlToPath, parseUriList } from '../src/renderer/src/lib/drop-path'

describe('fileUrlToPath', () => {
  it('Windows 盘符路径去掉前导斜杠', () => {
    expect(fileUrlToPath('file:///C:/Users/alice/a.txt')).toBe('C:/Users/alice/a.txt')
    expect(fileUrlToPath('file:///D:/data/x.bin')).toBe('D:/data/x.bin')
  })

  it('POSIX 路径原样保留', () => {
    expect(fileUrlToPath('file:///home/user/a.txt')).toBe('/home/user/a.txt')
    expect(fileUrlToPath('file:///tmp')).toBe('/tmp')
  })

  it('中文和空格要解码', () => {
    expect(fileUrlToPath('file:///C:/Users/alice/%E7%BB%93%E6%9E%9C.csv')).toBe('C:/Users/alice/结果.csv')
    expect(fileUrlToPath('file:///C:/a%20b/c.txt')).toBe('C:/a b/c.txt')
  })

  it('畸形转义不抛异常，返回 null', () => {
    // %ZZ 不是合法转义，decodeURIComponent 会抛
    expect(fileUrlToPath('file:///C:/a%ZZ.txt')).toBeNull()
  })

  it('空路径返回 null', () => {
    expect(fileUrlToPath('file://')).toBeNull()
  })
})

describe('parseUriList', () => {
  it('多行拆成多个路径', () => {
    const raw = ['file:///C:/a.txt', 'file:///C:/b.txt'].join('\r\n')
    expect(parseUriList(raw)).toEqual(['C:/a.txt', 'C:/b.txt'])
  })

  it('跳过注释行和空行', () => {
    // Chromium 会在 uri-list 里塞 # 开头的元信息
    const raw = ['# comment', '', 'file:///C:/a.txt', '   ', 'file:///C:/b.txt'].join('\n')
    expect(parseUriList(raw)).toEqual(['C:/a.txt', 'C:/b.txt'])
  })

  it('忽略非 file:// 的条目', () => {
    const raw = ['https://example.com/x', 'file:///C:/a.txt'].join('\n')
    expect(parseUriList(raw)).toEqual(['C:/a.txt'])
  })

  it('空输入返回空数组', () => {
    expect(parseUriList('')).toEqual([])
    expect(parseUriList('   ')).toEqual([])
  })

  it('全是非法条目时返回空数组，不抛异常', () => {
    expect(parseUriList('https://a\nftp://b')).toEqual([])
  })
})
