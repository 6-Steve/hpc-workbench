/**
 * 分级轮询 + 失败退避。
 *
 * 跳板机是公共资源（docs/04 §5.1 P6 "跳板机禁大负载 → 轮询必须分级 + 退避"），
 * 所以：
 * - **分级**：作业列表 20 秒一次（会变），配额和点数 5 分钟一次（几乎不变，而且配额实测要 550 ms）
 * - **退避**：连续失败就把间隔翻倍，最多 5 倍；成功一次立刻恢复
 * - **窗口不可见就停**：最小化/切到别的应用之后没人看结果，一次 `squeue` 也是
 *   一次 SSH 往返。实测这个应用常驻一整天，光这一条就能省掉几百条命令。
 *
 * 用递归 `setTimeout` 而不是 `setInterval`：退避要改下一次的间隔，
 * `setInterval` 改不了，只能清掉重开，反而更难写对。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/** 退避上限倍数：20s × 5 = 100s，再久界面就显得"死了" */
const MAX_BACKOFF_FACTOR = 5

/** 纯函数，方便单测：失败几次之后的间隔 */
export function nextPollDelay(baseMs: number, failures: number): number {
  if (failures <= 0) return baseMs
  return baseMs * Math.min(MAX_BACKOFF_FACTOR, 2 ** failures)
}

/** 窗口重新可见后，先等这么久再刷新：避免刚切回来就抢网络，也躲开切换动画 */
export const RESUME_DELAY_MS = 400

/**
 * 页面当前是否可见。
 *
 * 单独抽成 hook 而不是在 `usePoll` 里直接读 `document.hidden`：
 * 这是一个**外部状态**，直接读不会触发重渲染，轮询停不下来。
 */
/**
 * 托盘驻留时，窗口隐藏也要继续轮询。
 *
 * ## 为什么必须有这个开关
 *
 * 本文件的原则是"不可见就停"，省电也省集群的登录记录。但托盘驻留把窗口**藏起来**了，
 * 如果还按"隐藏就停"，作业跑完就没有任何通知——那正好和"驻留是怕你错过结果"的目的相反。
 *
 * 所以驻留模式下把条件放宽。模式由主进程持有（它才知道关窗时留下了没有），
 * 启动时由 `App` 通过 `setTrayResident()` 写进来。
 */
let trayResident = false
const residencyListeners = new Set<() => void>()

export function setTrayResident(value: boolean): void {
  if (trayResident === value) return
  trayResident = value
  for (const listener of residencyListeners) listener()
}

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => !document.hidden || trayResident)

  useEffect(() => {
    const sync = (): void => setVisible(!document.hidden || trayResident)
    document.addEventListener('visibilitychange', sync)
    residencyListeners.add(sync)
    // 注册时先对齐一次：setTrayResident 可能发生在挂载之前
    sync()
    return () => {
      document.removeEventListener('visibilitychange', sync)
      residencyListeners.delete(sync)
    }
  }, [])

  return visible
}

export interface PollState<T> {
  data: T | null
  error: unknown
  /** 最近一次成功的时间戳（ms）；从未成功过是 null */
  updatedAt: number | null
  /** 正在请求第一次 */
  pending: boolean
}

export interface PollResult<T> extends PollState<T> {
  /**
   * 立刻重新拉一次（用户点「刷新」时用）。
   *
   * 为什么必须给这个出口：光有 5 分钟轮询的话，用户点刷新按钮**没有任何反应**，
   * 会以为是 bug。而且点完之后要看得见"它真的在转"，所以这里同时
   * 把 `refreshing` 置 true。
   *
   * 内置节流：1 秒内重复点是无效的（连着点时不该发一串请求）。
   */
  refresh: () => void
  /** 手动刷新正在进行中（不含轮询发起的请求） */
  refreshing: boolean
}

/**
 * 周期执行 `run`，把结果放进状态。
 *
 * `run` 必须是稳定引用（调用方用 `useCallback` 包住），否则依赖变化会不停重启轮询。
 * `enabled` 为 false 时完全不发请求——比如 preload 是旧版本、方法根本不存在时。
 *
 * `refreshKey` 变一次就**立刻重来一轮**，并清空旧的 `data`。
 * 用途只有一个：切换跳板机。切完之后屏幕上的作业/配额/点数是**旧机器**的，
 * 不清空的话用户会对着 A 机的数字以为在看 B 机，要等 5 分钟才更新——
 * 那比看到"—"糟得多。清空是诚实的：它说"我还不知道"。
 */
export function usePoll<T>(
  run: () => Promise<T>,
  baseMs: number,
  enabled = true,
  refreshKey: string | number = 0
): PollResult<T> {
  const [state, setState] = useState<PollState<T>>({ data: null, error: null, updatedAt: null, pending: true })
  const [refreshing, setRefreshing] = useState(false)
  const visible = usePageVisible()

  // 用 ref 存 run，这样 run 变了不会重置定时器（也就不会因为父组件重渲染而重置退避）
  const runRef = useRef(run)
  runRef.current = run

  /**
   * 手动刷新的入口。轮询的 `tick` 活在 effect 闭包里，外面拿不到，
   * 所以这里独立发一次请求——代价是多一次 SSH 往返，但只在用户主动点时发生。
   */
  const lastManualRef = useRef(0)
  const refresh = useCallback((): void => {
    const now = Date.now()
    // 1 秒内重复点直接忽略：连点不该发一串请求
    if (now - lastManualRef.current < 1000) return
    lastManualRef.current = now

    setRefreshing(true)
    void runRef
      .current()
      .then((value) => {
        setState({ data: value, error: null, updatedAt: Date.now(), pending: false })
      })
      .catch((err: unknown) => {
        setState((previous) => ({ ...previous, error: err, pending: false }))
      })
      .finally(() => setRefreshing(false))
  }, [])

  // 换机器：先把上一轮的结论扔掉，别让用户拿着旧机器的数字做判断
  useEffect(() => {
    setState({ data: null, error: null, updatedAt: null, pending: true })
  }, [refreshKey])

  useEffect(() => {
    if (!enabled || !visible) return

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0

    const tick = async (): Promise<void> => {
      try {
        const value = await runRef.current()
        if (cancelled) return
        failures = 0
        setState({ data: value, error: null, updatedAt: Date.now(), pending: false })
      } catch (err) {
        if (cancelled) return
        failures += 1
        setState((previous) => ({ ...previous, error: err, pending: false }))
      }
      if (cancelled) return
      timer = setTimeout(() => void tick(), nextPollDelay(baseMs, failures))
    }

    // 从"不可见"回到"可见"时多等一会儿：用户刚切回来，先让画面渲染完
    timer = setTimeout(() => void tick(), RESUME_DELAY_MS)

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [baseMs, enabled, visible, refreshKey])

  return { ...state, refresh, refreshing }
}
