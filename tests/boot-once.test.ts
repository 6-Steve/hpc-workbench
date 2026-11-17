/**
 * `createOncePerAttempt`：同一轮只执行一次，但结果谁要都给。
 *
 * ## 为什么要为这么小的函数写测试
 *
 * 因为上一版把这段逻辑写在组件 effect 里，出了问题**完全测不出来**：
 * `typecheck` 过了、全量测试全绿、连源码守卫都红过，但启动页照样卡死。
 *
 * 卡死的原因正是这个模块要解决的矛盾：
 * - 只发一次（否则启动检查跑 7 遍，主进程真连 7 次集群）
 * - 但结果必须能被**每个** effect 实例取到（否则唯一那次的结果被丢弃，永远等下去）
 *
 * 把逻辑抽出来之后，这两条都能直接断言，不再依赖"看界面"。
 */
import { describe, expect, it } from 'vitest'
import { createOncePerAttempt } from '../src/renderer/src/lib/once-per-attempt'

/** 可控的 Promise，用来观察"什么时候真的执行了" */
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createOncePerAttempt · 只执行一次', () => {
  it('同一个 attempt 多次调用，只跑一次', () => {
    let calls = 0
    const once = createOncePerAttempt(() => {
      calls += 1
      return Promise.resolve(1)
    })

    void once(0)
    void once(0)
    void once(0)

    expect(calls).toBe(1)
  })

  it('aim 变成新的，就重新执行（用户点「重试」）', () => {
    let calls = 0
    const once = createOncePerAttempt(() => {
      calls += 1
      return Promise.resolve(calls)
    })

    void once(0)
    void once(1)
    void once(2)

    expect(calls).toBe(3)
  })

  it('回到旧 attempt 不会复用更早的结果（只记最近一次）', () => {
    let calls = 0
    const once = createOncePerAttempt(() => {
      calls += 1
      return Promise.resolve(calls)
    })

    void once(0)
    void once(1)
    void once(0) // 又回到 0

    expect(calls).toBe(3)
  })
})

describe('createOncePerAttempt · 结果谁要都给（这是防卡死的关键）', () => {
  it('两次调用拿到的是**同一个 Promise**', () => {
    const once = createOncePerAttempt(() => Promise.resolve('ok'))
    expect(once(0)).toBe(once(0))
  })

  it('后注册的 .then 也能收到结果——模拟 StrictMode 的第二次 mount', () => {
    /*
     * StrictMode 的真实时序：
     *   effect#1 发请求 → cleanup → effect#2 重新挂 then → 请求返回
     *
     * 如果 effect#2 拿不到结果（比如被 flag 早退了），启动页就永久卡住。
     * 这里断言的就是"第二个等待者照样拿得到"。
     */
    const d = deferred<string>()
    const once = createOncePerAttempt(() => d.promise)

    const seenByFirst: string[] = []
    const seenBySecond: string[] = []

    void once(0).then((value) => seenByFirst.push(value))
    void once(0).then((value) => seenBySecond.push(value))

    d.resolve('done')

    return Promise.resolve().then(() => {
      expect(seenByFirst).toEqual(['done'])
      expect(seenBySecond).toEqual(['done'])
    })
  })

  it('失败时，后注册的 .catch 同样能收到', () => {
    const d = deferred<string>()
    const once = createOncePerAttempt(() => d.promise)

    const errors: string[] = []
    void once(0).catch((err: Error) => errors.push(err.message))
    d.reject(new Error('boom'))

    return Promise.resolve().then(() => {
      expect(errors).toEqual(['boom'])
    })
  })

  it('失败不会被缓存成"永久失败"——换一轮还能重试', () => {
    let calls = 0
    const once = createOncePerAttempt(() => {
      calls += 1
      return calls === 1 ? Promise.reject(new Error('第一次失败')) : Promise.resolve('第二次成功')
    })

    void once(0).catch(() => undefined)

    return Promise.resolve()
      .then(() => once(1))
      .then((value) => {
        expect(value).toBe('第二次成功')
        expect(calls).toBe(2)
      })
  })
})

describe('createOncePerAttempt · 异常兜底', () => {
  it('run 同步抛异常时，返回 rejected Promise 而不是把调用方炸掉', () => {
    // 真实场景：`window.hpc.bootStatus` 不存在（旧 preload）时直接 TypeError
    const once = createOncePerAttempt(() => {
      throw new TypeError('bootStatus is not a function')
    })

    let caught: string | null = null
    const promise = once(0)
    void promise.catch((err: Error) => {
      caught = err.message
    })

    return Promise.resolve().then(() => {
      expect(caught).toContain('not a function')
    })
  })
})
