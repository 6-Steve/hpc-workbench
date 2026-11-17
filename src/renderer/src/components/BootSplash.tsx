/**
 * 启动页（Splash）。
 *
 * 解决的问题：冷启动时窗口是 `show:false` 等着的，从 `ready-to-show` 到主界面
 * 真正有数据之间还有 1–3 秒（加载界面 + preload 握手 + 第一轮 squeue）。
 * 这段时间窗口是纯 `#f6f7f9` 空白，没有任何标识——放到演示里第一眼像卡住了。
 *
 * 设计上的三条取舍：
 *
 * 1. **不是装饰性动画片**。三个步骤对应三次真实检查（配置 / 连接 / 队列），
 *    每一步的结论来自主进程，失败就停在那里并给下一步建议。
 *    纯转圈 1.5 秒再进主界面只是把等待拉长。
 *
 * 2. **随时可以跳过**。Esc 或点「直接进入」立刻进主界面——那时各页面自己的
 *    加载态会接管。启动页是锦上添花，绝不能变成新的阻塞点。
 *
 * 3. **失败不拦人**。连不上不该被挡在门外：诊断页正是为这种情况准备的。
 *    所以失败态给的是「重试 / 去诊断 / 先进入」三个出口，不是一句红字。
 *
 * 颜色刻意用深底：和主界面的浅灰形成一次明确的开场分界，
 * 也让 200ms 的淡出更容易察觉。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { BootStatus } from '../../../shared/boot'
import { createOncePerAttempt } from '../lib/once-per-attempt'

interface BootSplashProps {
  /** 关闭启动页（成功或跳过都走这里） */
  onDone: (result: { ok: boolean; queue?: BootStatus['queue'] }) => void
  /** 失败时点「去诊断页」*/
  onDiagnose: () => void
}

interface StepView {
  phase: 'config' | 'connect' | 'queue'
  label: string
  detail: string
}

/** 三步的静态定义。detail 在未执行时显示，执行完换成真实结论 */
const STEPS: StepView[] = [
  { phase: 'config', label: '读取配置', detail: '找 config/profiles.json' },
  { phase: 'connect', label: '连接集群', detail: '握手并确认身份' },
  { phase: 'queue', label: '读取队列', detail: 'squeue 一次，顺便把数字交给主界面' }
]

/** 淡出时长，必须和下面 transition 里的数字一致 */
const FADE_MS = 220

export function BootSplash({ onDone, onDiagnose }: BootSplashProps): JSX.Element {
  const [status, setStatus] = useState<BootStatus | null>(null)
  /** 正在跑第几步（0/1/2）。-1 = 全部结束 */
  const [activeStep, setActiveStep] = useState(0)
  const [leaving, setLeaving] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const [attempt, setAttempt] = useState(0)

  const doneRef = useRef(false)

  /**
   * `onDone` 存进 ref，`leave` 的依赖数组因此可以留空。
   *
   * ## 这是启动页"停好久"的原因之一，值得记下来
   *
   * 原来写的是 `useCallback(..., [onDone])`，而 App 传进来的是内联箭头函数
   * `<BootSplash onDone={() => setBooting(false)} />`——**每次父组件重渲染
   * 都是一个新函数**。于是 `leave` 变了 → 下面那个 effect 的依赖
   * `[attempt, leave]` 变了 → **又重新发一次启动检查**。
   *
   * 启动期间父组件因为轮询数据陆续到达会重渲染好几次，实测触发了 **7 次**：
   * 主进程真的连了 7 次集群、跑了 7 次 squeue。
   *
   * 更隐蔽的是：effect 里的 `cancelled` 只阻止"设置状态"，
   * **不取消已经发出去的 IPC 请求**——所以那些请求全都真实执行了。
   */
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  /** 统一的退出：先播淡出，再通知父组件。重复调用只生效一次 */
  const leave = useCallback((result: { ok: boolean; queue?: BootStatus['queue'] }): void => {
    if (doneRef.current) return
    doneRef.current = true
    setLeaving(true)
    window.setTimeout(() => onDoneRef.current(result), FADE_MS)
  }, [])

  /**
   * 启动检查：**同一轮只发一次，但结果谁要都给**。
   *
   * ## 这里踩过一个很深的坑，别改回去
   *
   * 第一版为了防止"重渲染导致重复请求"，用了一个 flag 守卫：
   *
   * ```ts
   * if (requestedRef.current === attempt) return   // ← 早退
   * requestedRef.current = attempt
   * ...
   * if (cancelled) return                          // ← 唯一那次的结果被丢弃
   * setStatus(result)
   * ```
   *
   * 配上 `StrictMode`（开发模式会**故意** mount → cleanup → mount）就死锁：
   *
   * 1. 第一次 effect 发请求，`cancelled = false`
   * 2. StrictMode 立刻 cleanup，把 `cancelled` 置 `true`
   * 3. 第二次 effect 被 flag 拦住 —— **没有第二次请求兜底**
   * 4. 唯一那次请求返回，看到 `cancelled === true`，**结果被扔掉**
   * 5. `status` 永远是 `null` → 启动页永远不淡出
   *
   * 现象极具迷惑性：日志里 `[boot]` 只打印一次、耗时也正常，
   * 但界面死死停在第一步。**请求成功、结果没人接**。
   *
   * 现在的做法：缓存 **Promise 本身**（`createOncePerAttempt`）。
   * 每个 effect 实例都挂一次 `.then`，谁的 `cancelled` 是 false 谁就接住结果。
   * 请求仍然只发一次，但不存在"结果无人接收"的状态。
   */
  const bootOnce = useRef(
    createOncePerAttempt(() => window.hpc.bootStatus() as Promise<BootStatus>)
  ).current

  /**
   * 跑一次检查。
   *
   * 关于步骤动画：真结果是**一次调用**整体返回的（主进程里三步串行）。
   * 但界面不能干等 —— 连接那步可能 300 ms，队列 200 ms，
   * 如果 0.5 秒内界面完全静止，看着就像死了。
   * 所以在前端按"未完成就停在当前步"的方式推进：拿到结果后再一次性对齐真实结论。
   *
   * ⚠️ **这个 effect 里不许出现"早退跳过 then 挂载"的分支**。
   * 每个 effect 实例都必须挂一次 `.then`——重跑时只有 `cancelled` 为 false
   * 的那个能接住结果。之前用 flag 早退，结果唯一那次请求的返回值没人接，
   * 启动页永久卡死（详见上面 `bootOnce` 的注释）。
   */
  useEffect(() => {
    // 旧 preload 兜底：宁可直接放行，也不要卡在启动页上（docs/04 E20）
    if (typeof window.hpc?.bootStatus !== 'function') {
      leave({ ok: false })
      return
    }

    let cancelled = false
    setStatus(null)
    setActiveStep(0)

    // 每 260ms 把"进行中"的指针往前推一格，最多推到第 3 步（等真实结果）
    const advance = window.setInterval(() => {
      setActiveStep((step) => (step < STEPS.length - 1 ? step + 1 : step))
    }, 260)

    void bootOnce(attempt)
      .then((result) => {
        // 只有"还活着"的那个 effect 实例才设置状态
        if (cancelled) return
        setStatus(result)
        setActiveStep(-1)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setStatus({
          ok: false,
          steps: [
            {
              phase: 'connect',
              ok: false,
              message: '启动检查没能执行',
              hint: err instanceof Error ? err.message : String(err),
              ms: 0
            }
          ],
          totalMs: 0
        })
        setActiveStep(-1)
      })
      .finally(() => {
        window.clearInterval(advance)
      })

    return () => {
      cancelled = true
      window.clearInterval(advance)
    }
  }, [attempt, bootOnce, leave])

  // Esc 随时跳过。用 capture 是为了抢在命令面板之类之前——启动页期间它们还没挂载
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        leave({ ok: false })
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [leave])

  /** 全部成功 → 停 420ms 让人看清"三步都绿"再走，太快反而像没检查 */
  useEffect(() => {
    if (!status || !status.ok) return
    const timer = window.setTimeout(() => leave({ ok: true, queue: status.queue }), 420)
    return () => window.clearTimeout(timer)
  }, [status, leave])

  const failed = status !== null && !status.ok

  return (
    <div
      className={
        'absolute inset-0 z-50 flex flex-col items-center justify-center bg-scrim transition-opacity ' +
        (leaving ? 'pointer-events-none opacity-0' : 'opacity-100')
      }
      style={{ transitionDuration: `${FADE_MS}ms` }}
      role="status"
      aria-live="polite"
    >
      {/* 拖动区：无边框窗口里，启动页也得能拖 */}
      <div className="drag-region absolute inset-x-0 top-0 h-11" />

      <div className="w-[380px] max-w-[calc(100%-64px)]">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-surface bg-white/10 text-page font-semibold leading-none text-white ring-1 ring-white/15">
            H
          </div>
          <div>
            <p className="text-emph font-medium tracking-tight text-white">HPC 工作台</p>
            <p className="mt-0.5 text-meta text-night-sub">远程算力客户端</p>
          </div>
        </div>

        <ol className="mt-7 space-y-2.5">
          {STEPS.map((step, index) => {
            const result = status?.steps.find((item) => item.phase === step.phase)
            // 执行完了就按真实结果；没执行完，看指针到没到
            const state = result ? (result.ok ? 'ok' : 'bad') : index === activeStep ? 'active' : 'idle'
            const text = result ? result.message : index === activeStep ? '进行中…' : step.detail
            const detail = result?.hint

            return (
              <li key={step.phase} className="flex items-start gap-2.5">
                <StepDot state={state} />
                <div className="min-w-0 flex-1">
                  <p
                    className={
                      'text-sub leading-tight ' +
                      (state === 'bad'
                        ? // 深色底上的红必须换一档：state-bad(#b91c1c) 衬 ink-900 只有 1.79:1
                          'text-night-bad'
                        : state === 'ok'
                          ? 'text-night-emph'
                          : state === 'active'
                            ? 'text-night-body'
                            : 'text-night-sub')
                    }
                  >
                    <span className="text-night-sub">{step.label}</span>
                    <span className="mx-1.5 text-night-sub">·</span>
                    {text}
                    {result && (
                      <span className="ml-1.5 font-mono text-meta text-night-sub">{result.ms}ms</span>
                    )}
                  </p>
                  {detail && <p className="mt-0.5 text-meta leading-relaxed text-night-sub">{detail}</p>}
                </div>
              </li>
            )
          })}
        </ol>

        {failed && status.raw && (
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setShowRaw((value) => !value)}
              className="rounded px-1 py-0.5 text-meta text-night-sub underline-offset-2 transition hover:text-night-emph hover:underline"
            >
              {showRaw ? '收起原始输出' : '查看原始输出'}
            </button>
            {showRaw && (
              <pre className="selectable mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-control bg-black/30 p-2 font-mono text-meta leading-relaxed text-night-body">
                {status.raw}
              </pre>
            )}
          </div>
        )}

        <div className="mt-6 flex items-center gap-2">
          {failed ? (
            <>
              <button
                type="button"
                onClick={() => {
                  doneRef.current = false
                  setAttempt((value) => value + 1)
                }}
                className="rounded-control bg-surface px-3 py-1.5 text-sub font-medium text-ink-900 transition hover:bg-surface/90"
              >
                重试
              </button>
              <button
                type="button"
                onClick={onDiagnose}
                className="rounded-control border border-white/20 px-3 py-1.5 text-sub text-night-body transition hover:bg-white/10"
              >
                去诊断页
              </button>
              <button
                type="button"
                onClick={() => leave({ ok: false })}
                className="ml-auto rounded px-1.5 py-1 text-meta text-night-sub transition hover:text-night-body"
              >
                先进入 →
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => leave({ ok: false })}
              className="ml-auto rounded px-1.5 py-1 text-meta text-night-sub transition hover:text-night-body"
            >
              跳过（Esc）
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** 三种形态的小圆点：等待（空心）、进行中（呼吸）、成功（实心勾）、失败（实心叉） */
function StepDot({ state }: { state: 'idle' | 'active' | 'ok' | 'bad' }): JSX.Element {
  if (state === 'ok') {
    return (
      <span className="mt-[3px] grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full bg-state-ok">
        <svg width="8" height="8" viewBox="0 0 10 10" fill="none">
          <path d="M2 5.2 4.1 7.3 8 3.2" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    )
  }
  if (state === 'bad') {
    return (
      <span className="mt-[3px] grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full bg-state-bad">
        <svg width="8" height="8" viewBox="0 0 10 10" fill="none">
          <path d="M3 3l4 4M7 3l-4 4" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </span>
    )
  }
  if (state === 'active') {
    return (
      <span className="mt-[3px] h-3.5 w-3.5 shrink-0 animate-pulse rounded-full border-2 border-state-info" />
    )
  }
  return <span className="mt-[3px] h-3.5 w-3.5 shrink-0 rounded-full border border-white/15" />
}
