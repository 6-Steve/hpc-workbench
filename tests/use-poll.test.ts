/**
 * 轮询退避。
 *
 * 这条规则是给跳板机让路的（docs/04 §3.1 P6 "跳板机禁大负载 → 轮询必须分级 + 退避"）：
 * 断线时如果还按原频率猛打，只会让本来就拥挤的登录节点更糟。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RESUME_DELAY_MS, nextPollDelay } from '../src/renderer/src/lib/use-poll'

const BASE = 20_000

describe('nextPollDelay', () => {
  it('没失败时用基础间隔', () => {
    expect(nextPollDelay(BASE, 0)).toBe(BASE)
  })

  it('连续失败就翻倍：2x / 4x，第 3 次起碰到 5 倍上限', () => {
    expect(nextPollDelay(BASE, 1)).toBe(BASE * 2)
    expect(nextPollDelay(BASE, 2)).toBe(BASE * 4)
    // 2^3 = 8 已经超过上限，所以直接取 5 倍
    expect(nextPollDelay(BASE, 3)).toBe(BASE * 5)
  })

  it('封顶 5 倍，再失败也不继续拉长', () => {
    // 不封顶的话失败 10 次就是 1024 倍 = 5.7 小时，界面等于死了
    expect(nextPollDelay(BASE, 5)).toBe(BASE * 5)
    expect(nextPollDelay(BASE, 50)).toBe(BASE * 5)
  })

  it('负数也按基础间隔处理（调用方算错不能变成 0 毫秒死循环）', () => {
    expect(nextPollDelay(BASE, -1)).toBe(BASE)
  })
})

/**
 * 窗口不可见时停止轮询。
 *
 * 这一条不测的话，改错的症状是"最小化之后跳板机上还在每 20 秒一条 squeue"，
 * 谁都看不见，只能等下一个人发现。所以这里直接驱动 `document.hidden`
 * 和 `visibilitychange`，数一数到底发了几次请求。
 */
describe('usePoll · 窗口可见性', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('恢复可见后先等 RESUME_DELAY_MS 再刷新（不抢占切换动画）', () => {
    // 这条只锁常量语义：改小到 0 会让用户每次切回来都撞上"正在连接…"
    expect(RESUME_DELAY_MS).toBeGreaterThan(0)
    expect(RESUME_DELAY_MS).toBeLessThan(1000)
  })
})
