/**
 * 跨页面共享的「先给旧数据，再后台刷新」缓存（stale-while-revalidate）。
 *
 * 解决的具体问题：资源页每次切回来都会重新拉 `listNodes` + `getQuota` + `getPrices`，
 * 三块内容一起变空（显示"正在读取…"），而实测配额要 550 ms、价格要单独发一条
 * `scir-watch`。用户来回切几次就会觉得"这软件老是白一下"。
 *
 * 设计上刻意做得很小，因为需求只有一条：**组件卸载后数据要活下来**。
 *
 * - 缓存放在模块级 Map 里，不跟着组件生命周期走；
 * - 过期判断用"多久以前"而不是定时器：没人看的时候不需要刷新，省跳板机；
 * - 正在飞的请求做去重，避免两个组件同时挂载时打两条同样的命令
 *   （跳板机是公共资源，这条和 use-poll 的分级轮询是同一个理由）；
 * - `settled` 是给"失败也要记住"用的：价格拉不到时如果每次都重试，
 *   用户在资源页每切一次就等一次超时。失败结果缓存更短的时间。
 */

interface Entry<T> {
  value: T
  /** 写入时间（ms）。stale 判断和"最近更新于"都看它 */
  at: number
}

const entries = new Map<string, Entry<unknown>>()
const inflight = new Map<string, Promise<unknown>>()

/** 默认新鲜期。超过它就算 stale：仍然先显示，但会后台刷一次 */
export const DEFAULT_TTL_MS = 30_000

/**
 * 读缓存。
 *
 * 返回 `null` 表示"从来没有成功过"，调用方据此决定要不要显示空态。
 * 注意 `stale` 为 true 时 `value` 依然可用——这正是这个模块的全部意义。
 */
export function readCache<T>(key: string, ttlMs = DEFAULT_TTL_MS): { value: T; at: number; stale: boolean } | null {
  const entry = entries.get(key)
  if (!entry) return null
  return {
    value: entry.value as T,
    at: entry.at,
    stale: Date.now() - entry.at >= ttlMs
  }
}

/** 写缓存。失败结果也走这里，只是调用方传一个更短的 ttl */
export function writeCache<T>(key: string, value: T): void {
  entries.set(key, { value, at: Date.now() })
}

/** 清掉某个键（比如用户点了"刷新"，要确保不是拿缓存糊弄） */
export function invalidateCache(key: string): void {
  entries.delete(key)
}

/** 清掉所有键。测试用，也留给以后"退出登录/切换集群"这类场景 */
export function clearCache(): void {
  entries.clear()
  inflight.clear()
}

/**
 * 同一个 key 的并发请求合并成一条。
 *
 * 回调里如果抛异常，**不写缓存**：让下一次调用重新试，
 * 否则失败会被永久记住，比闪白更糟。
 */
export async function dedupe<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key)
  if (existing) return existing as Promise<T>

  const promise = run().finally(() => {
    inflight.delete(key)
  })
  inflight.set(key, promise)
  return promise
}

/** 缓存键：集中在这里定义，避免各处手拼字符串拼错导致"永远不命中" */
export const CACHE_KEYS = {
  nodes: 'nodes',
  quota: 'quota',
  prices: 'prices',
  jobs: 'jobs'
} as const
