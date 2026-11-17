/**
 * 配置目录卡片。
 *
 * ## 为什么这张卡片必须显示"来源"
 *
 * 配置目录有四个来路：环境变量、自定义、便携（程序目录）、默认（%APPDATA%）。
 * 只显示一个路径的话，用户改了设置、看起来没变化，就没法判断是"没生效"还是
 * "被更高优先级的来源压住了"。**把"为什么是这个目录"显示出来，比路径本身更重要。**
 *
 * ## 为什么改完会重启
 *
 * `known_hosts` / 凭据库 / 能力缓存都在启动时用旧路径构造好了。
 * 运行中换目录会出现"一半服务写旧目录、一半读新目录"，
 * 那种状态比"改完重启一下"糟得多。所以这里只负责写指针，重启交给主进程。
 */
import { useCallback, useEffect, useState } from 'react'
import { Card, Field, Hint, Mono } from './ui'

type Source = 'env' | 'custom' | 'portable' | 'default'

const SOURCE_LABEL: Record<Source, string> = {
  portable: '便携模式',
  custom: '自定义',
  default: '默认',
  env: '环境变量'
}

/** 来源徽标。用 state-* 表达"稳不稳"：便携/自定义是用户主动选的，用 info */
const SOURCE_TONE: Record<Source, string> = {
  portable: 'border-state-info/30 bg-state-info/[0.08] text-state-info',
  custom: 'border-state-info/30 bg-state-info/[0.08] text-state-info',
  default: 'border-ink-200 bg-ink-50 text-ink-600',
  env: 'border-state-wait/30 bg-state-wait/[0.08] text-state-wait'
}

interface ConfigDirInfo {
  dir: string
  source: Source
  portableDir: string
  defaultDir: string
  appRoot: string
  mode: 'auto' | 'custom' | 'portable'
  customDir?: string
  fallback?: 'portable-not-writable'
  readonly: boolean
}

export function ConfigDirCard(): JSX.Element {
  const [info, setInfo] = useState<ConfigDirInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [resetBusy, setResetBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      setInfo((await window.hpc.configDir()) as ConfigDirInfo)
    } catch {
      // preload 是旧版本时这里会抛，顶部横幅会说明要重启
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const apply = useCallback(
    async (request: { mode: 'auto' | 'custom' | 'portable'; dir?: string }): Promise<void> => {
      setBusy(true)
      setError(null)
      try {
        const result = await window.hpc.setConfigDir(request)
        if (!result.ok) {
          setError(result.error ?? '切换失败')
          return
        }
        // 成功：主进程会在 400ms 后重启，这里只是把界面切到"正在重启"
        setPending(true)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    []
  )

  const pickCustom = useCallback(async (): Promise<void> => {
    const picked = await window.hpc.pickConfigDir()
    if (!picked.ok || !picked.path) return
    await apply({ mode: 'custom', dir: picked.path })
  }, [apply])

  /**
   * 备份现有 `profiles.json` 并重启 → 重新进入首次配置向导。
   *
   * 成功后应用会自己重启，所以这里只需要把界面切到"正在重启"；
   * 失败才需要把原因留在屏幕上。
   */
  const doReset = useCallback(async (): Promise<void> => {
    setResetBusy(true)
    setError(null)
    try {
      const result = await window.hpc.resetConfig()
      if (!result.ok) {
        setError(result.error ?? '重新配置失败')
        setConfirmReset(false)
        return
      }
      setPending(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setResetBusy(false)
    }
  }, [])

  const disabled = busy || pending || (info?.readonly ?? false)

  return (
    <Card
      title="配置目录"
      tone="mint"
      aside={
        info && (
          <span className={`rounded-full border px-2 py-0.5 text-meta ${SOURCE_TONE[info.source]}`}>
            {SOURCE_LABEL[info.source]}
          </span>
        )
      }
    >
      <Field label="当前目录">
        <Mono>{info?.dir ?? '读取中…'}</Mono>
      </Field>

      {/*
        便携目录写不进去（典型：装到了 Program Files），已经退回默认。
        这条必须显眼——不然用户会以为"我明明在程序目录放了 config，
        怎么还读的是 %APPDATA%"，而真正的原因（没权限）根本不在屏幕上。
      */}
      {info?.fallback === 'portable-not-writable' && (
        <div className="mt-2 rounded-surface border border-state-wait/25 bg-state-wait/[0.06] px-3 py-2 text-body leading-relaxed text-ink-800">
          程序目录下检测到 <code className="font-mono">config</code>，但
          <strong className="font-medium">写不进去</strong>，已退回默认目录。
          常见原因：应用装在了 <code className="font-mono">Program Files</code>（普通用户没有写权限）。
          想用便携模式，请改装到用户目录，或手动选一个可写的目录。
        </div>
      )}

      {error && (
        <div className="mt-2 rounded-surface border border-state-bad/25 bg-state-bad/[0.06] px-3 py-2 text-body leading-relaxed text-ink-800">
          {error}
        </div>
      )}

      {pending && (
        <div className="mt-2 rounded-surface border border-state-info/25 bg-state-info/[0.06] px-3 py-2 text-body text-ink-800">
          正在重启应用以生效…
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {/*
          `focus-visible` 是全局的，这里不再叠 ring（叠了就是"蓝圈 + 灰圈"）。
        */}
        <button
          type="button"
          onClick={() => void pickCustom()}
          disabled={disabled}
          className="rounded-control bg-inverse px-3 py-1.5 text-sub font-medium text-white transition hover:bg-ink-800 disabled:opacity-40"
        >
          更改…
        </button>
        <button
          type="button"
          onClick={() => void apply({ mode: 'portable' })}
          disabled={disabled}
          className="rounded-control border border-ink-200 bg-surface px-2.5 py-1.5 text-sub text-ink-700 transition hover:bg-ink-50 disabled:opacity-40"
        >
          用程序目录
        </button>
        <button
          type="button"
          onClick={() => void apply({ mode: 'auto' })}
          disabled={disabled}
          className="rounded-control border border-ink-200 bg-surface px-2.5 py-1.5 text-sub text-ink-700 transition hover:bg-ink-50 disabled:opacity-40"
        >
          恢复默认
        </button>
        <button
          type="button"
          onClick={() => void window.hpc.openConfigDir('current')}
          className="rounded-control border border-ink-200 bg-surface px-2.5 py-1.5 text-sub text-ink-700 transition hover:bg-ink-50"
        >
          打开
        </button>
        {/*
          改端口（比如 2223）最轻的办法：直接打开那个 JSON 改一行。
          比"重跑向导"省事，也比让人自己去 %APPDATA% 里翻路径靠谱。
        */}
        <button
          type="button"
          onClick={() => void window.hpc.openConfigDir('profileFile')}
          className="rounded-control border border-ink-200 bg-surface px-2.5 py-1.5 text-sub text-ink-700 transition hover:bg-ink-50"
        >
          编辑配置文件
        </button>

        {/*
          "重新配置"走的是**备份 + 重跑向导**，不是另写一套编辑表单：
          向导已经串好了校验、SSH 导入和说明，再来一套编辑界面就是两份规则两个真相。
        */}
        {!confirmReset ? (
          <button
            type="button"
            onClick={() => setConfirmReset(true)}
            disabled={disabled}
            className="rounded-control border border-ink-200 bg-surface px-2.5 py-1.5 text-sub text-ink-600 transition hover:bg-ink-50 disabled:opacity-40"
          >
            重新配置…
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void doReset()}
              disabled={resetBusy}
              className="rounded-control border border-state-bad/30 bg-state-bad/[0.06] px-2.5 py-1.5 text-sub text-ink-800 transition hover:bg-state-bad/[0.1] disabled:opacity-40"
            >
              {resetBusy ? '处理中…' : '确认：备份后重新配置'}
            </button>
            <button
              type="button"
              onClick={() => setConfirmReset(false)}
              className="rounded-control border border-ink-200 bg-surface px-2.5 py-1.5 text-sub text-ink-600 transition hover:bg-ink-50"
            >
              取消
            </button>
          </>
        )}
      </div>

      {info && (
        <Hint>
          三档：<span className="text-ink-700">默认</span>放用户数据目录；
          <span className="text-ink-700">用程序目录</span>把配置放在应用旁边
          （<code className="font-mono">{info.portableDir}</code>），拷走整个文件夹就能走；
          <span className="text-ink-700">更改…</span>可指到任意可写位置。
          默认模式下，只要程序目录里出现 <code className="font-mono">config</code> 就自动按便携模式用。
          切换时，当前目录里<span className="text-ink-700">有</span>的{' '}
          <code className="font-mono">profiles.json</code>、凭据、主机指纹会一并复制过去
          （没有就跳过，目标已有同名文件也不覆盖），然后自动重启生效。
        </Hint>
      )}
    </Card>
  )
}
