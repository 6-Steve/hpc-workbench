/**
 * 「同一个 attempt 只执行一次，但结果可以被多次取用」。
 *
 * ## 它解决的具体问题
 *
 * 启动页要发一次 `bootStatus()`（1~2 秒的网络活），但 React 的 effect
 * 可能因为**各种原因重跑**：
 *
 * - `StrictMode` 在开发模式下**故意**双调用（mount → cleanup → mount）
 * - 依赖变化
 *
 * 重跑本身不可怕，可怕的是两种错误做法：
 *
 * | 写法 | 后果 |
 * |---|---|
 * | 每次 effect 都重发请求 | 启动检查跑 7 遍，主进程真连 7 次集群（实测过） |
 * | 用 flag 拦住重发 + `cancelled` 丢弃结果 | **启动页永远卡住**：唯一那次请求的结果被扔了 |
 *
 * 正确做法是：**请求只发一次，但结果谁要都给**。
 * 所以这里缓存的是 **Promise 本身**，而不是"发过没发过"的布尔值——
 * 后来的调用者拿到同一个 Promise，照样能 `.then` 到结果。
 *
 * ## 为什么抽成独立模块
 *
 * 上一版把去重逻辑直接写在组件的 effect 里，结果出了问题**测不出来**：
 * 项目没有组件测试环境，而 `typecheck`、全量测试、源码守卫**全都通过了**，
 * 因为它结构上"看起来"没问题。
 *
 * 抽成纯函数之后，"同一轮只跑一次"和"不同轮要重跑"这两个性质都能直接断言。
 */
export interface OncePerAttempt<T> {
  /** 同一个 attempt 复用同一个 Promise；attempt 变了才重新执行 */
  (attempt: number): Promise<T>
}

export function createOncePerAttempt<T>(run: () => Promise<T>): OncePerAttempt<T> {
  let current: { attempt: number; promise: Promise<T> } | null = null

  return (attempt: number): Promise<T> => {
    if (current !== null && current.attempt === attempt) {
      return current.promise
    }

    /*
     * `run()` 理论上可能同步抛（比如 `window.hpc.bootStatus` 不存在时
     * 直接 TypeError）。包成 rejected Promise，让调用方的 `.catch` 能接住，
     * 而不是在 effect 里炸掉整个渲染。
     */
    let promise: Promise<T>
    try {
      promise = run()
    } catch (err) {
      promise = Promise.reject(err)
    }

    current = { attempt, promise }
    return promise
  }
}
