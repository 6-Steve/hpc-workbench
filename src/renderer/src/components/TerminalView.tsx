/**
 * 内嵌终端（登录节点上的交互式 shell）。
 *
 * 为什么要有它：图形界面永远盖不住全部操作——`module load`、`conda activate`、
 * `salloc` 申请交互节点、盯 `watch nvidia-smi`，这些只能在 shell 里干。
 * 以前的做法是切到另一个终端窗口再 `ssh` 一遍。
 *
 * 几个必须做对的地方：
 * - **Ctrl+K 要留给 shell**（bash 里是 kill-line）。全局的 Ctrl+K 命令面板
 *   在终端区域内会被让路，见 App 里的 keydown 守卫和容器上的 `data-terminal`。
 * - **窗口大小变化要同步 PTY 的行列数**，否则 `vim` / `htop` / `top` 会画歪。
 *   用 ResizeObserver + fit()，并做 150ms 防抖（拖动窗口时会连发几十次）。
 * - **卸载时一定要关会话**，否则远端会留一堆 shell 进程。
 */
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import { explainIpcError, stalePreloadError } from '../lib/preload'
import { PageHeader, StatusDot } from './ui'

type Status = 'connecting' | 'ready' | 'closed' | 'error'

/** 拖动窗口时 resize 会连发，防抖到停手再同步给 PTY */
const RESIZE_DEBOUNCE_MS = 150

export function TerminalView(): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionRef = useRef<string | null>(null)

  const [status, setStatus] = useState<Status>('connecting')
  const [message, setMessage] = useState<string | null>(null)
  /** 只有用户主动点「重新连接」时才重建终端，用这个计数触发 effect */
  const [attempt, setAttempt] = useState(0)

  const connect = useCallback(async (): Promise<void> => {
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return

    if (typeof window.hpc?.openTerminal !== 'function') {
      setStatus('error')
      setMessage(stalePreloadError('内嵌终端').message)
      return
    }

    setStatus('connecting')
    setMessage(null)

    try {
      fit.fit()
      const response = await window.hpc.openTerminal({ cols: term.cols, rows: term.rows })
      if (!response.ok || !response.sessionId) {
        setStatus('error')
        setMessage(
          [response.error?.message, response.error?.hint].filter(Boolean).join(' · ') || '开终端失败'
        )
        return
      }
      sessionRef.current = response.sessionId
      setStatus('ready')
      term.focus()
    } catch (err) {
      setStatus('error')
      setMessage(explainIpcError(err, '开终端').message)
    }
  }, [])

  // —— 建终端 + 首连（attempt 变化时重建）——
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      // 远端按这个型号查 terminfo；给了才能在 htop / vim 里正常画框
      fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, "Courier New", monospace',
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      convertEol: false,
      scrollback: 5000,
      // 浅色主题，和应用其它页面一致（深色终端在浅色界面里像贴了块黑胶带）
      theme: {
        background: '#ffffff',
        foreground: '#2b2f36',
        cursor: '#23262e',
        cursorAccent: '#ffffff',
        selectionBackground: '#dbeafe',
        black: '#2b2f36',
        red: '#c0392b',
        green: '#1e7b46',
        yellow: '#a5761b',
        blue: '#2563a8',
        magenta: '#8e44ad',
        cyan: '#0f7b8a',
        white: '#e6e8ec'
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()

    termRef.current = term
    fitRef.current = fit

    // 键盘 → 主进程。这里不能做任何加工，PTY 要的是原始字节
    const inputSub = term.onData((data) => {
      const sessionId = sessionRef.current
      if (sessionId) window.hpc.writeTerminal(sessionId, data)
    })

    void connect()

    // 尺寸变化 → 同步 PTY
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        try {
          fit.fit()
        } catch {
          // 容器被隐藏时 fit 会抛，忽略
        }
        const sessionId = sessionRef.current
        if (sessionId) window.hpc.resizeTerminal(sessionId, term.cols, term.rows)
      }, RESIZE_DEBOUNCE_MS)
    })
    observer.observe(host)

    return () => {
      if (resizeTimer) clearTimeout(resizeTimer)
      observer.disconnect()
      inputSub.dispose()
      const sessionId = sessionRef.current
      sessionRef.current = null
      if (sessionId) void window.hpc.closeTerminal(sessionId)
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [attempt, connect])

  // —— 收输出 / 收结束 ——
  useEffect(() => {
    if (typeof window.hpc?.onTerminalData !== 'function') return

    window.hpc.onTerminalData((payload) => {
      if (payload.sessionId !== sessionRef.current) return
      termRef.current?.write(payload.text)
    })

    window.hpc.onTerminalClosed((payload) => {
      if (payload.sessionId !== sessionRef.current) return
      sessionRef.current = null
      setStatus('closed')
      setMessage(payload.reason)
      termRef.current?.write(`\r\n\x1b[2m── ${payload.reason} ──\x1b[0m\r\n`)
    })
  }, [])

  const reconnect = (): void => {
    // 先把旧终端彻底销毁（effect 的清理会关会话），再让 effect 重建
    setAttempt((value) => value + 1)
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <div className="mx-auto w-full max-w-[1440px] shrink-0 px-8 pb-3 pt-6">
        <PageHeader
          className=""
          title="终端"
          description={
            <>
              登录节点上的交互式 shell。<code className="font-mono text-body">module load</code>、
              <code className="font-mono text-body">conda activate</code>、
              <code className="font-mono text-body">salloc</code> 都在这里用。
            </>
          }
          aside={
            <>
              <span className="flex items-center gap-1.5 text-sub">
            <StatusDot
              tone={status === 'ready' ? 'ok' : status === 'connecting' ? 'idle' : 'bad'}
              pulse={status === 'connecting'}
            />
            <span className={status === 'ready' ? 'text-ink-500' : 'text-ink-500'}>
              {status === 'ready'
                ? '已连接'
                : status === 'connecting'
                  ? '连接中…'
                  : status === 'closed'
                    ? '已断开'
                    : '出错'}
            </span>
          </span>
          {(status === 'closed' || status === 'error') && (
            <button
              type="button"
              onClick={reconnect}
              className="rounded-surface bg-inverse px-3 py-1.5 text-body font-medium text-white transition hover:bg-ink-800"
            >
              重新连接
            </button>
          )}
            </>
          }
        />
      </div>

      {message && status !== 'ready' && (
        <div className="mx-auto w-full max-w-[1440px] shrink-0 px-8 pb-2">
          <p className="rounded-surface border border-state-wait/25 bg-state-wait/[0.06] px-3 py-1.5 text-sub text-state-wait">
            {message}
          </p>
        </div>
      )}

      {/* data-terminal：App 的全局快捷键（Ctrl+K）看到这个标记就让路，把按键交还给 shell */}
      <div className="mx-auto flex min-h-0 w-full max-w-[1440px] flex-1 px-8 pb-6" data-terminal>
        <div className="min-h-0 w-full flex-1 overflow-hidden rounded-surface border border-ink-200 bg-surface p-2 shadow-card">
          <div ref={hostRef} className="h-full w-full" />
        </div>
      </div>
    </main>
  )
}
