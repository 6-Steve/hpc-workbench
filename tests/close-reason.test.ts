/**
 * 「连接是怎么断的」这句话。
 *
 * 目的很窄：让事后解释不再是干巴巴的"连接已断开"。
 * 但要先说清楚**拿不到什么**——网上常见"读 ssh2 的 exit code / signal"的说法是错的，
 * 那是通道（exec / shell）的概念。连接的 `close` 只给一个 `hadError` 布尔，
 * 所以这里能答的只有"谁先动的"。
 */
import { describe, expect, it } from 'vitest'
import { describeClose } from '../src/main/ssh/session'

describe('describeClose', () => {
  it('我们自己关的：说"本地"，不能赖到服务端头上', () => {
    expect(describeClose({ byUs: true, remoteEnded: false })).toBe('本地主动关闭')
  })

  it('本地关的时候即使对面已经发了断开请求，也算本地——是我们先决定关的', () => {
    expect(describeClose({ byUs: true, remoteEnded: true })).toBe('本地主动关闭')
  })

  it('收到 SSH_MSG_DISCONNECT：服务端主动断', () => {
    expect(describeClose({ byUs: false, remoteEnded: true })).toBe('服务端主动断开了连接')
  })

  it('什么都没收到：老实说"没拿到具体原因"，不要编一个', () => {
    expect(describeClose({ byUs: false, remoteEnded: false })).toContain('没拿到具体原因')
  })
})
