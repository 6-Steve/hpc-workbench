/**
 * 设置页的「关窗行为」。
 *
 * 三种：总是退出（默认）/ 有活时才驻留 / 总是驻留。
 *
 * 默认必须是"总是退出"——托盘驻留如果默认打开，第一次用的用户会以为应用关不掉。
 * 想用的人自己去选，这是唯一不会让人困惑的顺序。
 */
import { useCallback, useEffect, useState } from 'react'
import { Card, Hint } from './ui'

type Mode = 'quit' | 'when-busy' | 'always'

const OPTIONS: Array<{ id: Mode; label: string; hint: string }> = [
  { id: 'quit', label: '总是退出', hint: '关窗就退出，和以前一样。' },
  {
    id: 'when-busy',
    label: '有任务时驻留',
    hint: '正在传输、或者开着隧道时，关窗只是收进托盘；空闲时照常退出。'
  },
  { id: 'always', label: '总是驻留', hint: '关窗永远只是收进托盘，要退出请用托盘菜单里的「退出」。' }
]

export function ResidencyCard(): JSX.Element {
  const [mode, setMode] = useState<Mode>('quit')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.hpc
      .residency()
      .then((result) => setMode(result.mode))
      .catch(() => undefined)
  }, [])

  const change = useCallback(async (next: Mode): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.hpc.residency(next)
      setMode(result.mode)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [])

  return (
    <Card title="关窗行为">
      <div className="space-y-1.5">
        {OPTIONS.map((option) => (
          <label
            key={option.id}
            className="flex cursor-pointer items-start gap-2 text-body leading-relaxed text-ink-700"
          >
            <input
              type="radio"
              name="residency"
              className="mt-1"
              checked={mode === option.id}
              disabled={busy}
              onChange={() => void change(option.id)}
            />
            <span>
              <span className="font-medium text-ink-800">{option.label}</span>
              <span className="mt-0.5 block text-sub text-ink-500">{option.hint}</span>
            </span>
          </label>
        ))}
      </div>

      {mode !== 'quit' && (
        <Hint>
          驻留期间窗口隐藏，但轮询照常进行——作业跑完仍会弹系统通知。退出请用托盘图标右键 →「退出」。
        </Hint>
      )}

      {error && <p className="mt-2 text-sub text-state-bad">{error}</p>}
    </Card>
  )
}
