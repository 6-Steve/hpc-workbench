import { useCallback, useEffect, useState } from 'react'
import { formatSize } from '../lib/format'
import { Card, Field, Hint, Mono, PageHeader, PageShell } from './ui'
import { CredentialsCard } from './CredentialsCard'
import { FontThemeCard } from './FontThemeCard'
import { ConfigDirCard } from './ConfigDirCard'
import { LatencyCard } from './LatencyCard'
import { ProfilesCard } from './ProfilesCard'
import { ResidencyCard } from './ResidencyCard'
import { ThemeCard } from './ThemeCard'

interface SettingsViewProps {
  /** 本机栏默认目录；null 表示用户主目录 */
  defaultStartDir: string | null
  onStartDirChange: (dir: string | null) => void
}

/**
 * 设置页。
 *
 * 目前两项，都是"改了以后能立刻感觉到"的：
 * 本机栏从哪儿起步、拖拽缓存占了多少。
 * 不做成 JSON 配置文件让用户手改——那种设置页等于没有。
 */
export function SettingsView({ defaultStartDir, onStartDirChange }: SettingsViewProps): JSX.Element {
  const [mirror, setMirror] = useState<{ files: number; bytes: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [cleared, setCleared] = useState<{ files: number; bytes: number } | null>(null)

  const loadMirrorStats = useCallback(async (): Promise<void> => {
    const stats = await window.hpc.mirrorStats()
    setMirror(stats)
  }, [])

  useEffect(() => {
    void loadMirrorStats()
  }, [loadMirrorStats])

  const pickStartDir = useCallback(async (): Promise<void> => {
    const picked = await window.hpc.pickDirectory()
    if (!picked.ok || !picked.path) return
    const result = await window.hpc.setLocalStart(picked.path)
    onStartDirChange(result.dir)
  }, [onStartDirChange])

  const resetStartDir = useCallback(async (): Promise<void> => {
    const result = await window.hpc.setLocalStart(null)
    onStartDirChange(result.dir)
  }, [onStartDirChange])

  const clearDragCache = useCallback(async (): Promise<void> => {
    setBusy(true)
    setCleared(null)
    try {
      const result = await window.hpc.clearMirror()
      setCleared(result)
      await loadMirrorStats()
    } finally {
      setBusy(false)
    }
  }, [loadMirrorStats])

  return (
    <PageShell>
      <PageHeader title="设置" description="这些改动立即生效，不需要重启。" />

      <div className="space-y-4">
        {/* 凭据放最上面：它决定了"能不能连上"，比目录和缓存重要得多 */}
        <ProfilesCard />

        <CredentialsCard />

        {/* 紧接着是"这些文件存在哪"——连不上时第二常查的就是它 */}
        <ConfigDirCard />

        {/* 测速放在配置目录后面：先能连上，才谈得上快慢 */}
        <LatencyCard />

        <ResidencyCard />

        <ThemeCard />

        <FontThemeCard />

        <Card title="本机栏">
          <Field label="默认目录">
            <div className="flex flex-wrap items-center gap-2">
              <Mono>{defaultStartDir ?? '用户主目录（未设置）'}</Mono>
              <button
                type="button"
                onClick={() => void pickStartDir()}
                className="rounded-surface border border-ink-200 bg-surface px-2.5 py-1 text-sub text-ink-700 transition hover:bg-ink-50"
              >
                选择目录…
              </button>
              {defaultStartDir && (
                <button
                  type="button"
                  onClick={() => void resetStartDir()}
                  className="rounded-surface px-2 py-1 text-sub text-ink-500 transition hover:bg-ink-100 hover:text-ink-800"
                >
                  恢复默认
                </button>
              )}
            </div>
          </Field>
          <Hint>
            展开本机栏时从这个目录开始。也可以在文件页的本机栏空白处右键设置。
            如果这个目录被删了（或者 U 盘拔了），会自动回落到用户主目录，不会报错。
          </Hint>
        </Card>

        <Card
          title="拖拽缓存"
          aside={
            <span className="text-sub text-ink-500">
              {mirror ? `${mirror.files} 个文件 · ${formatSize(mirror.bytes)}` : '统计中…'}
            </span>
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void clearDragCache()}
              disabled={busy || (mirror?.files ?? 0) === 0}
              className="rounded-surface border border-ink-200 bg-surface px-3 py-1.5 text-body text-ink-700 transition hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? '清理中…' : '清空缓存'}
            </button>
            {cleared && (
              <span className="text-sub text-state-ok">
                已清掉 {cleared.files} 个文件 / {formatSize(cleared.bytes)}
              </span>
            )}
          </div>
          <Hint>
            把集群文件拖到资源管理器时，会先下载一份副本放在系统临时目录，它充当缓存
            （同一个文件再拖就瞬间开始）。<strong className="font-medium text-ink-500">每次启动应用都会自动清空</strong>，
            所以这里的数字只反映本次运行拖过的文件。占地方的话可以手动清。
          </Hint>
        </Card>
      </div>
    </PageShell>
  )
}
