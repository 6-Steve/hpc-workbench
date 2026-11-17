/**
 * 设置页的「登录凭据」卡片。
 *
 * ## 它解决的问题
 *
 * 1. 有些集群只支持密码登录（不能只用密钥），每次启动都要手输
 * 2. 赠送点数这类操作要 LDAP 密码，每次转账都要再输一遍
 *
 * 存好之后这两处都不用再问——`ProfileState.current()` 会把密码填进 profile，
 * 转账也可以直接用。
 *
 * ## 三条界面上的硬规则
 *
 * 1. **系统钥匙串不可用时，禁用"保存"并说清原因**。不能让用户点了保存、
 *    以为存上了，实际什么都没存。这时只提供「只在本次运行内记住」。
 * 2. **密码框永远不回显已有密码**。主进程从不把密码传回来，
 *    所以这里只能显示"已保存"，不显示"已保存：abc***"。
 * 3. **明文密码要主动提示迁移**。配置文件里躺着的明文是真实风险，
 *    但改用户的 profiles.json 必须由他点确认。
 */
import { useCallback, useEffect, useState } from 'react'
import { Card, Hint, Mono } from './ui'

type Kind = 'ssh-password' | 'key-passphrase' | 'platform-password'

/** 三类凭据在界面上的分组顺序与说明 */
const GROUPS: { kind: Kind; label: string; hint: string }[] = [
  {
    kind: 'ssh-password',
    label: 'SSH 登录密码',
    hint: 'profile 里 auth.method 是 password 的那种。每台跳板机单独一份。'
  },
  {
    kind: 'key-passphrase',
    label: '私钥口令',
    hint: '只有当私钥本身带口令（生成时输了 passphrase）才需要填。不填是正常的。'
  },
  {
    kind: 'platform-password',
    label: '平台账号密码',
    hint: '赠送点数这类操作要的 LDAP 密码。跨跳板机是同一个账号。'
  }
]

type TestStatus = 'ok' | 'wrong' | 'unreachable' | 'unsupported'

interface TestOutcome {
  status: TestStatus
  message: string
  detail?: string
}

/** 测试结果的配色：只有"对"和"错"用语义色，其余保持中性——别把"连不上"说成"密码错" */
const TEST_STYLE: Record<TestStatus, { className: string; icon: string }> = {
  ok: { className: 'text-state-ok', icon: '✓' },
  wrong: { className: 'text-state-bad', icon: '✗' },
  unreachable: { className: 'text-state-wait', icon: '!' },
  unsupported: { className: 'text-ink-600', icon: '?' }
}

interface Target {
  kind: Kind
  scope: string
  display: string
  ownerLabel: string
  configured: boolean
  optional?: boolean
}

interface Status {
  available: boolean
  backend: string
  stored: number
  sessionOnly: number
}

export function CredentialsCard(): JSX.Element {
  const [status, setStatus] = useState<Status | null>(null)
  const [targets, setTargets] = useState<Target[]>([])
  const [plaintext, setPlaintext] = useState<
    { profileId: string; label: string; field: 'password' | 'passphrase'; canEncrypt: boolean }[]
  >([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  /** 正在编辑哪一条（用 kind+scope 当 key） */
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [persist, setPersist] = useState(true)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /** 正在测哪一条（kind::scope） */
  const [testing, setTesting] = useState<string | null>(null)
  /** 各条的测试结果，按 kind::scope 存 */
  const [outcomes, setOutcomes] = useState<Record<string, TestOutcome>>({})
  /** 平台密码要先确认，因为会真的发一次转账请求 */
  const [pendingTest, setPendingTest] = useState<Target | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const response = await window.hpc.listCredentials()
      if (!response.ok) {
        setError(response.error?.message ?? '读取凭据状态失败')
        return
      }
      setStatus(response.status ?? null)
      setTargets(response.targets ?? [])
      setPlaintext(response.plaintext ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const key = (target: Target): string => `${target.kind}::${target.scope}`

  const startEdit = (target: Target): void => {
    setEditing(key(target))
    setDraft('')
    // 钥匙串不可用时默认不落盘，避免用户以为存上了
    setPersist(status?.available ?? false)
    setNotice(null)
    setError(null)
  }

  const submit = async (target: Target): Promise<void> => {
    if (draft.length === 0) {
      setError('密码是空的')
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const response = await window.hpc.setCredential({
        kind: target.kind,
        scope: target.scope,
        secret: draft,
        persist
      })
      if (!response.ok) {
        setError(response.reason ?? '保存失败')
        return
      }
      // 密码用完立刻从组件状态里清掉，不在内存里多留
      setDraft('')
      setEditing(null)
      setNotice(
        response.persisted
          ? '已保存。下次连接／转账会自动用它。'
          : '只在本次运行内记住，退出应用就没了。'
      )
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (target: Target): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const response = await window.hpc.removeCredential({ kind: target.kind, scope: target.scope })
      if (!response.ok) {
        setError(response.reason ?? '删除失败')
        return
      }
      setNotice('已删除。')
      // 删掉了就不要再显示旧的测试结果
      setOutcomes((prev) => {
        const next = { ...prev }
        delete next[`${target.kind}::${target.scope}`]
        return next
      })
      await load()
    } finally {
      setBusy(false)
    }
  }

  /**
   * 真的去认证一次。
   *
   * 密码是加密存的，解开密文只能证明"密钥还在"，不能证明"里面那串是对的"——
   * 所以只能拿去问认证方。三种凭据的代价不同，界面上分别说明。
   */
  const runTest = async (target: Target): Promise<void> => {
    const id = `${target.kind}::${target.scope}`
    setPendingTest(null)
    setTesting(id)
    setError(null)
    setNotice(null)
    try {
      const response = await window.hpc.testCredential({
        kind: target.kind,
        scope: target.scope
      })
      setOutcomes((prev) => ({ ...prev, [id]: response.outcome }))
    } catch (err) {
      setOutcomes((prev) => ({
        ...prev,
        [id]: {
          status: 'unreachable',
          message: '测试过程中出错了。',
          detail: err instanceof Error ? err.message : String(err)
        }
      }))
    } finally {
      setTesting(null)
    }
  }

  const startTest = (target: Target): void => {
    // 平台密码会真的发一次转账，必须先告知
    if (target.kind === 'platform-password') {
      setPendingTest(target)
      return
    }
    void runTest(target)
  }

  const available = status?.available ?? false

  return (
    <Card
      title="登录凭据"
      aside={
        status && (
          <span className={`text-sub ${available ? 'text-ink-500' : 'text-state-wait'}`}>
            {available ? status.backend : `${status.backend}不可用`}
          </span>
        )
      }
    >
      <div className="space-y-3">
        {/*
          不可用是一等状态，不是边缘情况：Linux 没装密钥环、
          或者精简版 Windows 上都会这样。必须让用户一眼看到"存不了"。
        */}
        {status && !available && (
          <div className="rounded-control border border-state-wait/40 bg-state-wait/10 px-3 py-2">
            <p className="text-body font-medium text-state-wait">这台机器上无法加密保存密码</p>
            <p className="mt-1 text-sub text-ink-600">
              原因：{status.backend}不可用。为避免把密码明文写进磁盘，这里<strong className="font-medium">不会</strong>保存，
              只能选「只在本次运行内记住」——退出应用就失效。
            </p>
          </div>
        )}

        {plaintext.length > 0 && (
          <div className="rounded-control border border-state-wait/40 bg-state-wait/10 px-3 py-2">
            <p className="text-body font-medium text-state-wait">
              配置文件里还有 {plaintext.length} 处明文密码
            </p>
            <p className="mt-1 text-sub text-ink-600">
              {plaintext.map((item) => `${item.label} 的 ${item.field}`).join('、')}
              。这些是 `config/profiles.json` 里直接写着的密码，任何能读这个文件的人都能看到。
            </p>
            <p className="mt-1 text-sub text-ink-600">
              处理办法：在上面把对应的密码存一份，然后到 `profiles.json` 里把
              {plaintext.some((item) => item.field === 'password') && ' `password`'}
              {plaintext.some((item) => item.field === 'passphrase') && ' `passphrase`'}
              的值改成空字符串。<strong className="font-medium">程序不会替你改这个文件</strong>——那是你手写的配置。
            </p>
          </div>
        )}

        {GROUPS.map((group) => {
          const rows = targets.filter((target) => target.kind === group.kind)
          if (rows.length === 0) return null
          return (
            <div key={group.kind}>
              <h3 className="text-sub font-medium text-ink-700">{group.label}</h3>
              <p className="mt-0.5 text-meta text-ink-500">{group.hint}</p>

              <div className="mt-2 space-y-2">
                {rows.map((target) => {
                  const isEditing = editing === key(target)
                  return (
                    <div
                      key={key(target)}
                      className="rounded-control border border-ink-200 bg-surface px-3 py-2"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Mono>{target.display}</Mono>
                        {target.configured ? (
                          <span className="text-meta text-state-ok">已保存</span>
                        ) : target.optional ? (
                          <span className="text-meta text-ink-500">未设置（通常不需要）</span>
                        ) : (
                          <span className="text-meta text-state-wait">未设置</span>
                        )}

                        <div className="ml-auto flex items-center gap-1.5">
                          {!isEditing && (
                            <button
                              type="button"
                              onClick={() => startEdit(target)}
                              className="rounded-surface border border-ink-200 bg-surface px-2.5 py-1 text-sub text-ink-700 transition hover:bg-ink-50"
                            >
                              {target.configured ? '换一个' : '设置'}
                            </button>
                          )}
                          {target.configured && !isEditing && (
                            <button
                              type="button"
                              disabled={busy || testing === key(target)}
                              onClick={() => startTest(target)}
                              title="拿这个密码去真的认证一次，看平台认不认"
                              className="rounded-surface border border-ink-200 bg-surface px-2.5 py-1 text-sub text-ink-700 transition hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              {testing === key(target) ? '测试中…' : '测试'}
                            </button>
                          )}
                          {target.configured && !isEditing && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void remove(target)}
                              className="rounded-surface px-2 py-1 text-sub text-ink-500 transition hover:bg-ink-100 hover:text-state-bad disabled:opacity-40"
                            >
                              删除
                            </button>
                          )}
                        </div>
                      </div>

                      {/*
                        平台密码的测试会真的向平台发一次 0 点转账（转给自己）。
                        虽然等于空操作，但确实是一次请求，不能偷偷发。
                      */}
                      {pendingTest !== null && key(pendingTest) === key(target) && (
                        <div className="mt-2 rounded-control border border-state-wait/40 bg-state-wait/10 px-3 py-2">
                          <p className="text-sub text-ink-700">
                            验证平台密码需要真的走一次 LDAP 认证，方式是
                            <span className="font-mono"> 0 点转账给你自己</span>
                            （账号 {target.display}）。金额是 0，等于空操作，但确实会发一次请求。
                          </p>
                          <div className="mt-2 flex gap-2">
                            <button
                              type="button"
                              onClick={() => void runTest(target)}
                              className="rounded-control bg-state-wait px-3 py-1.5 text-sub font-medium text-white"
                            >
                              验证
                            </button>
                            <button
                              type="button"
                              onClick={() => setPendingTest(null)}
                              className="rounded-control border border-ink-200 px-3 py-1.5 text-sub text-ink-700"
                            >
                              取消
                            </button>
                          </div>
                        </div>
                      )}

                      {testing === key(target) && (
                        <p className="mt-2 text-meta text-ink-500">
                          {target.kind === 'platform-password'
                            ? '正在走 LDAP 认证，可能要十几秒…'
                            : target.kind === 'ssh-password'
                              ? '正在连一次集群…'
                              : '正在本地解开私钥…'}
                        </p>
                      )}

                      {outcomes[key(target)] && testing !== key(target) && (
                        <div className="mt-2">
                          <p className={`text-sub ${TEST_STYLE[outcomes[key(target)]!.status].className}`}>
                            <span className="mr-1 font-mono">
                              {TEST_STYLE[outcomes[key(target)]!.status].icon}
                            </span>
                            {outcomes[key(target)]!.message}
                          </p>
                          {outcomes[key(target)]!.detail && (
                            <details className="mt-1">
                              <summary className="cursor-pointer text-meta text-ink-500">平台原话</summary>
                              <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-ink-50 p-2 font-mono text-meta text-ink-700">
                                {outcomes[key(target)]!.detail}
                              </pre>
                            </details>
                          )}
                        </div>
                      )}

                      {isEditing && (
                        <div className="mt-2 space-y-2">
                          <input
                            type="password"
                            value={draft}
                            autoFocus
                            autoComplete="off"
                            onChange={(event) => setDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') void submit(target)
                              if (event.key === 'Escape') setEditing(null)
                            }}
                            placeholder="输入密码"
                            className="w-full rounded-control border border-ink-200 px-3 py-1.5 text-emph text-ink-800"
                          />

                          <label className="flex cursor-pointer items-center gap-1.5 text-sub text-ink-600">
                            <input
                              type="checkbox"
                              checked={persist}
                              disabled={!available}
                              onChange={(event) => setPersist(event.target.checked)}
                              className="h-3 w-3 accent-ink-700"
                            />
                            保存到这台机器（{available ? '加密存储' : '当前不可用'}）
                          </label>
                          {!available && (
                            <p className="text-meta text-ink-500">
                              只能记到本次运行结束，因为这台机器没有可用的系统钥匙串。
                            </p>
                          )}

                          <div className="flex gap-2">
                            <button
                              type="button"
                              disabled={busy || draft.length === 0}
                              onClick={() => void submit(target)}
                              className="rounded-control bg-inverse px-3 py-1.5 text-sub font-medium text-white transition hover:bg-ink-800 disabled:opacity-40"
                            >
                              {busy ? '保存中…' : '保存'}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setEditing(null)
                                setDraft('')
                              }}
                              className="rounded-control border border-ink-200 px-3 py-1.5 text-sub text-ink-700"
                            >
                              取消
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}

        {error !== null && <p className="text-sub text-state-bad">{error}</p>}
        {notice !== null && <p className="text-sub text-state-ok">{notice}</p>}
        {loading && <p className="text-sub text-ink-500">读取中…</p>}

        <Hint>
          密码由操作系统的钥匙串加密（{status?.backend ?? '系统钥匙串'}），
          密钥绑当前系统账户——文件被拷到别的电脑或别的账户下解不开。
          保存后，连接集群和赠送点数都不再需要手输。
        </Hint>
      </div>
    </Card>
  )
}
