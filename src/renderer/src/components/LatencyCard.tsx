/**
 * 设置页的「跳板机测速」。
 *
 * 和标题栏那个小面板的区别：这里是**完整分解 + 判读**，用来回答
 * "到底是网慢还是节点忙"。标题栏只放得下两个数。
 *
 * 设计上的两个克制：
 * 1. **进页面不自动测**。每次测速都是一次真实 SSH 登录，会在集群上留 auth 记录；
 *    用户没点之前不该有网络动作。
 * 2. **同一时刻只测一台**。主进程那边串行，这里只是把按钮禁掉，别让人以为卡住了。
 */
import { useCallback, useEffect, useState } from 'react'
import { formatMs } from '../../../shared/latency'
import { Card, Hint, Mono } from './ui'

interface ProfileSummary {
  id: string
  label: string
  host: string
  port: number
  username: string
  isDefault: boolean
}

export function LatencyCard(): JSX.Element {
  const [profiles, setProfiles] = useState<ProfileSummary[]>([])
  const [latencies, setLatencies] = useState<Record<string, ProfileLatency>>({})
  const [measuring, setMeasuring] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.hpc
      .listProfiles()
      .then((result) => {
        if (result.ok && result.profiles) setProfiles(result.profiles)
      })
      .catch(() => undefined)
  }, [])

  const runLatency = useCallback(async (id: string): Promise<void> => {
    setMeasuring(id)
    setError(null)
    try {
      const result = await window.hpc.profileLatency({ profileId: id, force: true })
      if (!result.ok || !result.latency) {
        setError(result.error?.message ?? '测速失败')
        return
      }
      const latency = result.latency
      setLatencies((prev) => ({ ...prev, [id]: latency }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setMeasuring(null)
    }
  }, [])

  if (profiles.length === 0) return <></>

  return (
    <Card title="跳板机测速">
      <Hint>
        测一次 = 真的登录一次。拆成四段看：<b className="font-medium text-ink-700">网络</b>高就换网络，
        <b className="font-medium text-ink-700">登录</b>高就换节点。结果缓存 5 分钟，点按钮才会重测。
      </Hint>

      <div className="mt-2 divide-y divide-ink-100">
        {profiles.map((profile) => {
          const latency = latencies[profile.id]
          return (
            <div key={profile.id} className="py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-emph font-medium text-ink-900">{profile.label}</span>
                <Mono>{`${profile.host}:${profile.port}`}</Mono>
                <button
                  type="button"
                  disabled={measuring !== null}
                  onClick={() => void runLatency(profile.id)}
                  className="ml-auto rounded-control border border-ink-200 bg-surface px-2 py-0.5 text-sub text-ink-700 transition hover:bg-ink-50 disabled:opacity-40"
                >
                  {measuring === profile.id ? '测速中…' : latency ? '重新测' : '测一下'}
                </button>
              </div>

              {latency ? (
                <>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sub text-ink-600">
                    <span>网络 <b className="font-mono font-medium text-ink-800">{formatMs(latency.tcpMs)}</b></span>
                    <span>sshd <b className="font-mono font-medium text-ink-800">{formatMs(latency.sshdMs)}</b></span>
                    <span>登录 <b className="font-mono font-medium text-ink-800">{formatMs(latency.authMs)}</b></span>
                    <span>命令 <b className="font-mono font-medium text-ink-800">{formatMs(latency.execMs)}</b></span>
                    <span className="text-ink-500">合计 {formatMs(latency.totalMs)}</span>
                  </div>
                  <p
                    className={`mt-1 text-body leading-relaxed ${
                      latency.verdict === 'ok' ? 'text-ink-700' : 'text-state-wait'
                    }`}
                  >
                    <b className="font-medium">{latency.headline}</b> —— {latency.detail}
                  </p>
                </>
              ) : (
                <p className="mt-1 text-sub text-ink-500">还没测过。</p>
              )}
            </div>
          )
        })}
      </div>

      {error && <p className="mt-2 text-sub text-state-bad">{error}</p>}
    </Card>
  )
}
