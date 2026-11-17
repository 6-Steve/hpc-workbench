/**
 * SWR 缓存的单元测试。
 *
 * 这个模块很小，但它是"切页面不闪白"的全部依据，而闪白这件事没有测试就只能靠肉眼撞见。
 * 尤其下面两条，写错了不会报错、只会表现为"偶尔白一下"：
 * 1. 并发去重：两个组件同时挂载时只该发一条命令（跳板机是公共资源）
 * 2. 失败不写缓存：否则一次网络抖动会被记 30 秒，比闪白更难堪
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CACHE_KEYS,
  DEFAULT_TTL_MS,
  clearCache,
  dedupe,
  invalidateCache,
  readCache,
  writeCache
} from '../src/renderer/src/lib/swr-cache'

beforeEach(() => clearCache())
afterEach(() => {
  vi.useRealTimers()
  clearCache()
})

describe('readCache / writeCache', () => {
  it('没写过时返回 null，而不是空对象', () => {
    // 空对象会让调用方以为"有数据"，从而跳过错开的空态分支
    expect(readCache(CACHE_KEYS.nodes)).toBeNull()
  })

  it('写进去能原样读出来，并且带上时间戳', () => {
    writeCache(CACHE_KEYS.nodes, { totals: { nodes: 3 } })
    const hit = readCache<{ totals: { nodes: number } }>(CACHE_KEYS.nodes)
    expect(hit?.value.totals.nodes).toBe(3)
    expect(typeof hit?.at).toBe('number')
    expect(hit?.stale).toBe(false)
  })

  it('超过 TTL 就标成 stale，但值依然可读', () => {
    // 这是整个模块的核心语义：stale ≠ 不可用。返回 null 就等于没用缓存。
    vi.useFakeTimers()
    writeCache(CACHE_KEYS.quota, [{ fs: 'home', used: 1 }])

    vi.advanceTimersByTime(DEFAULT_TTL_MS - 1)
    expect(readCache(CACHE_KEYS.quota)?.stale).toBe(false)

    vi.advanceTimersByTime(2)
    const hit = readCache<unknown[]>(CACHE_KEYS.quota)
    expect(hit?.stale).toBe(true)
    expect(hit?.value).toHaveLength(1)
  })

  it('不同键互不干扰', () => {
    writeCache(CACHE_KEYS.nodes, 'nodes')
    writeCache(CACHE_KEYS.prices, 'prices')
    expect(readCache(CACHE_KEYS.nodes)?.value).toBe('nodes')
    expect(readCache(CACHE_KEYS.prices)?.value).toBe('prices')
    expect(readCache(CACHE_KEYS.jobs)).toBeNull()
  })

  it('invalidate 之后当没写过', () => {
    writeCache(CACHE_KEYS.nodes, 1)
    invalidateCache(CACHE_KEYS.nodes)
    expect(readCache(CACHE_KEYS.nodes)).toBeNull()
  })
})

describe('dedupe', () => {
  it('同一个键的并发调用只真正执行一次', async () => {
    const run = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return 'ok'
    })

    const results = await Promise.all([
      dedupe('k', run),
      dedupe('k', run),
      dedupe('k', run)
    ])

    expect(run).toHaveBeenCalledTimes(1)
    expect(results).toEqual(['ok', 'ok', 'ok'])
  })

  it('不同键各自执行', async () => {
    const run = vi.fn(async () => 'v')
    await Promise.all([dedupe('a', run), dedupe('b', run)])
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('上一次结束之后能再次发起（不是永久去重）', async () => {
    let calls = 0
    const run = async (): Promise<number> => {
      calls += 1
      return calls
    }
    expect(await dedupe('k', run)).toBe(1)
    expect(await dedupe('k', run)).toBe(2)
    expect(calls).toBe(2)
  })

  it('抛异常时把错误原样抛给每个等待者，且不留下脏状态', async () => {
    const boom = new Error('连不上')
    await expect(dedupe('k', async () => Promise.reject(boom))).rejects.toThrow('连不上')
    // 失败后必须能重试：如果 inflight 没清掉，第二次调用会拿到同一个 rejected promise
    await expect(dedupe('k', async () => 'ok')).resolves.toBe('ok')
  })
})
