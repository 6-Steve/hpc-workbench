/**
 * 设置页的「跳板机」卡片：列出所有主机，可以逐台编辑。
 *
 * ## 为什么放在设置页而不是切换器里
 *
 * 切换器面板宽度只有 256px（`PANEL_WIDTH` 是常量，portal 定位靠它算），
 * 塞一个编辑表单会把它挤成一列文字。设置页本来就有「配置目录」「登录凭据」这些
 * 同一主题的东西，编辑主机放这里更顺。
 *
 * ## 一条边界
 *
 * 表单里能改**私钥路径**，但不能读私钥内容——路径是文件位置，不是秘密；
 * 内容永远只在主进程里待着。密码同理：只显示「钥匙串里有/没有」。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Card, EmptyState, Hint, Mono } from './ui'

const INPUT =
  'w-full rounded-control border border-ink-200 bg-surface px-3 py-1.5 text-emph text-ink-800 ' +
  'placeholder:text-ink-500'

interface ProfileSummary {
  id: string
  label: string
  host: string
  port: number
  username: string
  isDefault: boolean
}

interface Detail {
  id: string
  label: string
  host: string
  port: number
  username: string
  auth: { method: 'key' | 'password'; privateKeyPath?: string }
  hasPassword: boolean
}

/**
 * 堆叠式字段：标签在上、控件在下。
 *
 * 为什么不用设置页那个 `Field`：`Field` 是"左标签 96px + 右控件"的横排。
 * 放进 3 列栅格后，端口那列只剩 140px，标签吃掉 96px，输入框只剩一条缝
 * （真出现过，端口只剩一个点）。字段一多，横排标签就不合适了。
 */
function StackField({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div>
      <div className="mb-1 text-sub text-ink-500">{label}</div>
      {children}
    </div>
  )
}

export function ProfilesCard(): JSX.Element {
  const [profiles, setProfiles] = useState<ProfileSummary[]>([])
  const [editing, setEditing] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const result = await window.hpc.listProfiles()
    if (result.ok && result.profiles) setProfiles(result.profiles)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const openEditor = useCallback(async (id: string): Promise<void> => {
    setError(null)
    setNotice(null)
    const result = await window.hpc.profileDetail(id)
    if (!result.ok || !result.profile) {
      setError(result.error?.message ?? '读不到这台主机的配置')
      return
    }
    setEditing(result.profile)
  }, [])

  return (
    <Card title="跳板机" aside={<span className="text-sub text-ink-500">{profiles.length} 台</span>}>
      {profiles.length === 0 ? (
        <EmptyState title="还没有配置主机" hint="用「首次配置向导」加一台，或者把 profiles.json 放进配置目录。" />
      ) : (
        <div className="divide-y divide-ink-100">
          {profiles.map((profile) => (
            <div key={profile.id} className="flex flex-wrap items-center gap-2 py-2">
              <span className="text-emph font-medium text-ink-900">{profile.label}</span>
              <Mono>{`${profile.host}:${profile.port}`}</Mono>
              <span className="text-sub text-ink-500">{profile.username}</span>
              {profile.isDefault && (
                <span className="rounded border border-ink-200 px-1 text-meta text-ink-500">默认</span>
              )}
              <button
                type="button"
                onClick={() => void openEditor(profile.id)}
                className="ml-auto rounded-control border border-ink-200 bg-surface px-2.5 py-1 text-sub text-ink-700 transition hover:bg-ink-50"
              >
                编辑
              </button>
            </div>
          ))}
        </div>
      )}

      {error && <p className="mt-2 text-sub text-state-bad">{error}</p>}
      {notice && <p className="mt-2 text-sub text-state-ok">{notice}</p>}

      {editing && (
        <ProfileEditor
          detail={editing}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null)
            setNotice(message)
            void load()
          }}
        />
      )}
    </Card>
  )
}

function ProfileEditor({
  detail,
  onClose,
  onSaved
}: {
  detail: Detail
  onClose: () => void
  onSaved: (message: string) => void
}): JSX.Element {
  const [label, setLabel] = useState(detail.label)
  const [host, setHost] = useState(detail.host)
  const [port, setPort] = useState(String(detail.port))
  const [username, setUsername] = useState(detail.username)
  const [method, setMethod] = useState<'key' | 'password'>(detail.auth.method)
  const [keyPath, setKeyPath] = useState(detail.auth.privateKeyPath ?? '')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = useCallback(async (): Promise<void> => {
    const portNumber = Number.parseInt(port, 10)
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      setError('端口要填 1–65535 的整数')
      return
    }
    if (!host.trim() || !username.trim()) {
      setError('主机和用户名不能为空')
      return
    }
    if (method === 'key' && !keyPath.trim()) {
      setError('选了私钥登录，私钥路径不能为空')
      return
    }

    setBusy(true)
    setError(null)
    try {
      const result = await window.hpc.updateProfile({
        id: detail.id,
        label: label.trim() || detail.id,
        host: host.trim(),
        port: portNumber,
        username: username.trim(),
        auth: method === 'key' ? { method: 'key', privateKeyPath: keyPath.trim() } : { method: 'password' },
        // 空字符串 = 用户没重填，别去覆盖钥匙串里的旧密码
        password: method === 'password' && password ? password : undefined
      })

      if (!result.ok) {
        setError([result.error?.message, result.error?.hint].filter(Boolean).join(' · '))
        return
      }

      const prev = result.previous
      const moved = prev && (prev.host !== host.trim() || prev.port !== portNumber)
      onSaved(
        result.changed
          ? moved
            ? '已保存。主机或端口变了：旧连接已丢弃，切到这台时会用新地址重连。'
            : '已保存。参数变了：旧连接已丢弃，下次连接会用新配置。'
          : '没有改动。'
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [detail.id, label, host, port, username, method, keyPath, password, onSaved])

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-inverse/25 px-6">
      <div className="w-full max-w-[480px] overflow-hidden rounded-surface border border-ink-200 bg-surface shadow-pop">
        <header className="border-b border-ink-100 px-5 py-3">
          <h2 className="text-emph font-semibold text-ink-900">编辑跳板机</h2>
          <p className="mt-0.5 text-sub text-ink-500">
            id：<span className="font-mono">{detail.id}</span>（内部标识，不能改——它是连接会话的键）
          </p>
        </header>

        <div className="space-y-3 px-5 py-4">
          <StackField label="名称">
            <input className={INPUT} value={label} onChange={(event) => setLabel(event.target.value)} />
          </StackField>

          {/*
            端口固定 96px：4 位数字够用，也不会因为"主机"那列变长被压成一条缝。
            用 flex 而不是 3 列栅格——栅格列宽均分，标签一长就把端口挤没了。
          */}
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <StackField label="主机">
                <input className={INPUT} value={host} onChange={(event) => setHost(event.target.value)} />
              </StackField>
            </div>
            <div className="w-24 shrink-0">
              <StackField label="端口">
                <input
                  className={INPUT}
                  value={port}
                  inputMode="numeric"
                  maxLength={5}
                  onChange={(event) => setPort(event.target.value)}
                />
              </StackField>
            </div>
          </div>

          <StackField label="用户名">
            <input
              className={INPUT}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </StackField>

          <StackField label="认证方式">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setMethod('key')}
                className={
                  'rounded-control border px-2.5 py-1 text-sub transition ' +
                  (method === 'key'
                    ? 'border-accent-500/50 bg-accent-500/[0.08] text-ink-900'
                    : 'border-ink-200 bg-surface text-ink-700 hover:bg-ink-50')
                }
              >
                私钥
              </button>
              <button
                type="button"
                onClick={() => setMethod('password')}
                className={
                  'rounded-control border px-2.5 py-1 text-sub transition ' +
                  (method === 'password'
                    ? 'border-accent-500/50 bg-accent-500/[0.08] text-ink-900'
                    : 'border-ink-200 bg-surface text-ink-700 hover:bg-ink-50')
                }
              >
                密码
              </button>
            </div>
          </StackField>

          {method === 'key' ? (
            <StackField label="私钥路径">
              <input
                className={`${INPUT} font-mono`}
                value={keyPath}
                placeholder="~/.ssh/id_rsa"
                onChange={(event) => setKeyPath(event.target.value)}
              />
            </StackField>
          ) : (
            <StackField label="密码">
              <input
                className={INPUT}
                type="password"
                value={password}
                placeholder={detail.hasPassword ? '已保存在钥匙串里，留空表示不修改' : '还没保存过密码'}
                onChange={(event) => setPassword(event.target.value)}
              />
            </StackField>
          )}

          <Hint>改完会丢弃这台机器的旧连接；正在用它的终端和隧道需要重连。</Hint>

          {error && (
            <p className="rounded-surface border border-state-bad/25 bg-state-bad/[0.06] px-3 py-2 text-sub leading-relaxed text-ink-800">
              {error}
            </p>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-ink-100 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-control border border-ink-200 bg-surface px-3 py-1.5 text-body text-ink-700 transition hover:bg-ink-50 disabled:opacity-40"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            className="rounded-control bg-inverse px-3.5 py-1.5 text-body font-medium text-white transition hover:bg-ink-800 disabled:cursor-not-allowed disabled:bg-ink-300"
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </footer>
      </div>
    </div>
  )
}
