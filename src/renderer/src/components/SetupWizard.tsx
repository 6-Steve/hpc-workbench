/**
 * 首次运行向导。
 *
 * ## 为什么要向导，而不是"给个横幅让人改 JSON"
 *
 * 之前没配置时的界面是：一条横幅 + 一句"把 profiles.example.json 复制成
 * profiles.json，填主机、用户名和认证方式"。对写代码的人够用，对"同学装完
 * 想连集群"就完全不够——他们不知道 JSON 放哪、哪个字段必填、密码该不该写进去。
 *
 * 向导把这三件事一次性解决：
 * 1. **先问放哪儿**（默认 / 程序目录便携 / 自选），因为这决定了后续所有路径
 * 2. **逐项问连接信息**，每项旁边就是规则（必填、范围、格式）
 * 3. **提交时生成文件**，并把"写到哪了、长什么样、下一步做什么"说清楚
 *
 * ## 密码为什么不写进文件
 *
 * 文件里只有 `auth.method`；密码走 `credentials.set()`（系统钥匙串加密）。
 * 界面上这句话必须写出来——否则用户会以为"我没填密码它怎么记住的"，
 * 或者反过来"是不是明文存进去了"。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  emptyDraft,
  groupIssues,
  validateSetupDraft,
  type SetupDraft,
  type SetupField
} from '../../../shared/setup'
import { draftFromSshHost } from '../../../shared/ssh-config'
import {
  TUNNEL_DEFAULTS,
  validateTunnelPorts,
  type TunnelPortField,
  type TunnelPortsDraft
} from '../../../shared/tunnel-defaults'
import { Card, Hint, Mono, PageHeader, PageShell } from './ui'

type Mode = 'auto' | 'portable' | 'custom'
type Step = 'where' | 'connect' | 'tunnel' | 'done'

interface DirInfo {
  dir: string
  portableDir: string
  defaultDir: string
  appRoot: string
  readonly: boolean
}

interface ApplyResult {
  ok: boolean
  issues?: Array<{ field: SetupField; message: string }>
  configPath?: string
  warnings?: string[]
  restartRequired: boolean
}

/** 与 `src/preload/index.d.ts` 的 `SshImportResult` 对应（渲染层只用到这些字段） */
interface SshHost {
  alias: string
  hostName: string
  user?: string
  port?: number
  identityFile?: string
  identityAbsolute?: string
  keyExists?: boolean
  keyEncrypted?: boolean
  proxyJump?: string
}

interface SshImportResult {
  dir: string
  configPath: string
  found: boolean
  hosts: SshHost[]
  keys: Array<{ path: string; name: string; encrypted: boolean }>
  warnings: string[]
}

const INPUT =
  'w-full rounded-control border border-ink-200 bg-surface px-3 py-1.5 text-emph text-ink-800 ' +
  'placeholder:text-ink-500'

/**
 * 把一条 `Host` 变成表单补丁。
 *
 * 只在**确定**的字段上动手：有 `IdentityFile` 才切到私钥方式；
 * 没有就不碰「登录方式」——那可能是用户自己选的，猜错一次就要重选一遍。
 */
function draftPatchFromHost(host: SshImportHost): Partial<SetupDraft> {
  const base = draftFromSshHost(host)
  return {
    label: base.label,
    host: base.host,
    port: base.port,
    username: base.username,
    ...(host.identityAbsolute
      ? { method: 'key' as const, privateKeyPath: base.privateKeyPath || host.identityAbsolute }
      : {})
  }
}

/** 一行表单：标签 + 控件 + 规则说明 + 错误。规则和错误都贴着控件，不另设说明区 */
function Row({
  label,
  rule,
  error,
  children
}: {
  label: string
  rule?: string
  error?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="space-y-1">
      <label className="block text-emph font-medium text-ink-800">{label}</label>
      {children}
      {error ? (
        <p className="text-sub text-state-bad">{error}</p>
      ) : (
        rule && <p className="text-sub text-ink-500">{rule}</p>
      )}
    </div>
  )
}

export function SetupWizard({ onDone }: { onDone: () => void }): JSX.Element {
  const [step, setStep] = useState<Step>('where')
  const [info, setInfo] = useState<DirInfo | null>(null)
  const [mode, setMode] = useState<Mode>('auto')
  const [customDir, setCustomDir] = useState('')
  const [draft, setDraft] = useState<SetupDraft>(emptyDraft())
  const [fields, setFields] = useState<Partial<Record<SetupField, string>>>({})
  const [general, setGeneral] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ApplyResult | null>(null)
  const [ssh, setSsh] = useState<SshImportResult | null>(null)
  const [sshBusy, setSshBusy] = useState(false)
  const [tunnel, setTunnel] = useState<TunnelPortsDraft>({
    remotePort: String(TUNNEL_DEFAULTS.remotePort),
    localPort: String(TUNNEL_DEFAULTS.localPort)
  })
  const [tunnelErrors, setTunnelErrors] = useState<Partial<Record<TunnelPortField, string>>>({})
  const [selectedAlias, setSelectedAlias] = useState<string | null>(null)
  /** 一起写进 profiles 的其它主机（从 SSH 配置里勾的） */
  const [extras, setExtras] = useState<string[]>([])
  /**
   * 用户是否动过表单。
   *
   * 自动填入只能发生在**表单还是空的**时候：用户已经手敲了主机地址，
   * 这时候"读到了配置"再覆盖一遍是最让人恼火的交互。
   */
  const touched = useRef(false)

  useEffect(() => {
    void window.hpc.configDir().then((value) => setInfo(value as DirInfo))
  }, [])

  /*
   * 隧道端口的"当前值"：如果之前配过（比如从老版本升上来），要读回来而不是
   * 用硬编码默认值覆盖——不然用户改过的端口会在下次进向导时被悄悄改回去。
   */
  useEffect(() => {
    void window.hpc
      .tunnelDefaults()
      .then((value) => {
        setTunnel({ remotePort: String(value.remotePort), localPort: String(value.localPort) })
      })
      .catch(() => undefined)
  }, [])

  /*
   * 尝试读 `~/.ssh/config`。
   *
   * **先读再问**：八成的人和自己的集群已经配过 `ssh hpc`，直接给选项比让人
   * 从零抄一遍省事得多。读不到也不报错——大把人是第一次连，本来就没有这个文件。
   */
  const loadSsh = useCallback(async (target?: string): Promise<void> => {
    setSshBusy(true)
    try {
      const result = (await window.hpc.readSshConfig(target)) as SshImportResult
      setSsh(result)

      /*
       * **读到就填第一台**。
       *
       * 原来是"列出来等你点"，结果用户看到列表上明明白白写着 `:2223`，
       * 下面的端口框却还是 `22`，第一反应就是"导入没生效"。
       * 「导入」这个词本身就意味着"帮我把值填上"，不是"给我看一眼"。
       * 表单已经被动过就不覆盖（`touched`）。
       */
      const first = result.hosts[0]
      if (!touched.current && first) {
        setDraft((prev) => ({ ...prev, ...draftPatchFromHost(first) }))
        setSelectedAlias(first.alias)
      }
    } catch {
      setSsh(null)
    } finally {
      setSshBusy(false)
    }
  }, [])

  useEffect(() => {
    void loadSsh()
  }, [loadSsh])

  const patch = useCallback((next: Partial<SetupDraft>): void => {
    touched.current = true
    setDraft((prev) => ({ ...prev, ...next }))
    // 改了哪一项就清哪一项的错误：边填边红一片最劝退
    setFields((prev) => {
      const copy = { ...prev }
      for (const key of Object.keys(next)) delete copy[key as SetupField]
      return copy
    })
  }, [])

  const pickDir = useCallback(async (): Promise<void> => {
    const picked = await window.hpc.pickConfigDir()
    if (picked.ok && picked.path) {
      setCustomDir(picked.path)
      setMode('custom')
    }
  }, [])

  /**
   * 把一条 `Host` 填进表单（用户点了某台主机）。
   *
   * 只在**确定**的字段上动手：有 `IdentityFile` 才切到私钥方式；
   * 没有就不碰「登录方式」——那可能是用户自己选的，猜错一次就要重选一遍。
   */
  const useHost = useCallback((host: SshImportHost): void => {
    touched.current = true
    setDraft((prev) => ({ ...prev, ...draftPatchFromHost(host) }))
    setSelectedAlias(host.alias)
    setFields((prev) => {
      const copy = { ...prev }
      for (const key of ['label', 'host', 'port', 'username', 'privateKeyPath'] as SetupField[]) {
        delete copy[key]
      }
      return copy
    })
  }, [])

  const submit = useCallback((): void => {
    setBusy(true)
    setGeneral(null)
    void window.hpc
      .applyInitialSetup({
        draft,
        /*
         * 勾了"同时加入"的其它主机一起写进 `profiles`。
         *
         * 这是**跳板机切换器能不能用**的关键：它列的就是 `profiles` 数组。
         * 只写一台的话，用户 `ssh config` 里配了两台登录节点，装完却只能连一台。
         */
        extras: extras
          .map((alias) => ssh?.hosts.find((host) => host.alias === alias))
          .filter((host): host is SshHost => Boolean(host?.identityAbsolute))
          .map((host) => ({ ...emptyDraft(), ...draftPatchFromHost(host) })),
        mode,
        dir: mode === 'custom' ? customDir : undefined
      })
      .then(async (value) => {
        const applied = value as ApplyResult
        if (!applied.ok) {
          const listed = applied.issues ?? []
          setFields(groupIssues(listed))
          setGeneral(listed.find((issue) => issue.field === 'general')?.message ?? null)
          // 出错就退回到连接信息那一步：错在那几个框里
          setStep('connect')
          return
        }

        /*
         * 隧道端口存成用户偏好。失败**不挡**整个配置——配置文件已经能用了，
         * 拖着一句"端口没存上"卡在向导里不值得。
         */
        const saved = await window.hpc.setTunnelDefaults({
          remotePort: Number(tunnel.remotePort),
          localPort: Number(tunnel.localPort)
        })
        if (!saved.ok && saved.error) {
          applied.warnings = [...(applied.warnings ?? []), `隧道默认端口没存上：${saved.error}`]
        }

        setResult(applied)
        setStep('done')
      })
      .catch((err: unknown) => {
        setGeneral(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setBusy(false))
  }, [draft, mode, customDir, tunnel, extras, ssh])

  const next = useCallback((): void => {
    if (step === 'where') {
      setStep('connect')
      return
    }

    if (step === 'connect') {
      const issues = validateSetupDraft(draft)
      if (issues.length > 0) {
        setFields(groupIssues(issues))
        setGeneral(null)
        return
      }
      setFields({})
      setStep('tunnel')
      return
    }

    if (step !== 'tunnel') return
    const check = validateTunnelPorts(tunnel)
    if (Object.keys(check.errors).length > 0) {
      setTunnelErrors(check.errors)
      return
    }
    setTunnelErrors({})
    submit()
  }, [step, draft, tunnel, submit])

  const tunnelWarnings = useMemo(() => validateTunnelPorts(tunnel).warnings, [tunnel])

  /**
   * 可以"顺便一起加入"的其它主机。
   *
   * 只收**配了私钥**的：附带主机没法让用户各填一遍密码，而没私钥的
   * 走密码方式必然缺密码——加进去只会得到一条连不上的配置。
   */
  const otherHosts = useMemo(
    () => (ssh?.hosts ?? []).filter((host) => host.alias !== selectedAlias && host.identityAbsolute),
    [ssh, selectedAlias]
  )

  const targetDir =
    mode === 'custom' ? customDir || '（还没选）' : mode === 'portable' ? (info?.portableDir ?? '…') : (info?.defaultDir ?? '…')

  return (
    <PageShell>
      <PageHeader
        title="先配一下集群"
        description={
          <>
            这一步只需要两件事：告诉它<b className="font-medium text-ink-800">配置放在哪</b>，
            再填<b className="font-medium text-ink-800">登录信息</b>。填完会自动生成配置文件，
            下一次启动就不用再填了。
          </>
        }
      />

      {/* 步骤指示：三步固定，让人知道还剩多少 */}
      <ol className="mb-4 flex items-center gap-2 text-sub">
          {(
            [
              ['where', '1 存放位置'],
              ['connect', '2 连接信息'],
              ['tunnel', '3 隧道端口'],
              ['done', '4 完成']
            ] as Array<[Step, string]>
          ).map(([id, label]) => {
            const active = id === step
            const passed =
              ['where', 'connect', 'tunnel', 'done'].indexOf(step) >
              ['where', 'connect', 'tunnel', 'done'].indexOf(id)
            return (
              <li
                key={id}
                className={
                  'rounded-full border px-2.5 py-0.5 ' +
                  (active
                    ? 'border-accent-500/50 bg-accent-500/[0.08] text-ink-900'
                      : passed
                        ? 'border-ink-200 bg-ink-50 text-ink-600'
                        : 'border-ink-200 text-ink-500')
                }
              >
                {label}
              </li>
            )
          })}
        </ol>

        {step === 'where' && (
          <Card title="配置放在哪">
            <div className="space-y-2">
              {(
                [
                  ['auto', '默认位置', info?.defaultDir, '跟着系统用户走，重装系统前都在。绝大多数人用这个。'],
                  ['portable', '程序目录（便携）', info?.portableDir, '放在应用旁边，整个文件夹拷走就能换台机器用。'],
                  ['custom', '自己选一个目录', customDir || null, '放 D 盘、U 盘、同步盘都行，只要可写。']
                ] as Array<[Mode, string, string | null | undefined, string]>
              ).map(([id, title, dir, hint]) => {
                const active = mode === id
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => (id === 'custom' ? void pickDir() : setMode(id))}
                    className={
                      'w-full rounded-control border p-3 text-left transition ' +
                      (active
                        ? 'border-accent-500/50 bg-accent-500/[0.06]'
                        : 'border-ink-200 bg-surface hover:border-ink-300 hover:bg-ink-50')
                    }
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="text-emph font-medium text-ink-900">{title}</span>
                      {active && <span className="text-meta text-accent-600">选中</span>}
                    </div>
                    <div className="mt-0.5 break-all font-mono text-sub text-ink-600">{dir ?? '点这里选择目录…'}</div>
                    <div className="mt-0.5 text-sub text-ink-500">{hint}</div>
                  </button>
                )
              })}
            </div>
            <Hint>
              配置目录里会放三个文件：<code className="font-mono">profiles.json</code>（主机与账号）、
              <code className="font-mono">credentials.json</code>（加密后的密码）、
              <code className="font-mono">known_hosts.json</code>（主机指纹）。
            </Hint>
          </Card>
        )}

        {step === 'connect' && (
          <div className="space-y-4">
            {/*
              导入区放在连接信息**上面**：能导入的人看见的第一眼就是自己的主机名，
              一个按钮点完，下面四个框已经填好了。没有配置的人也只需要看一句话——
              「没找到，请手填」。
            */}
            <Card
              title="从 SSH 配置导入"
              aside={
                <span className="text-sub text-ink-500">
                  {sshBusy ? '读取中…' : ssh?.found ? `${ssh.hosts.length} 台可选` : '没找到'}
                </span>
              }
            >
              {ssh && (
                <p className="mb-2 break-all text-sub text-ink-600">
                  读取自 <Mono>{ssh.configPath}</Mono>
                </p>
              )}

              {ssh && ssh.hosts.length > 0 ? (
                <div className="grid gap-2 normal:grid-cols-2">
                  {ssh.hosts.map((host) => (
                    <button
                      key={host.alias}
                      type="button"
                      onClick={() => useHost(host)}
                      className={
                        'rounded-control border p-2.5 text-left transition ' +
                        (selectedAlias === host.alias
                          ? 'border-accent-500/50 bg-accent-500/[0.06]'
                          : 'border-ink-200 bg-surface hover:border-ink-300 hover:bg-ink-50')
                      }
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="flex items-baseline gap-1.5">
                          <span className="text-emph font-medium text-ink-900">{host.alias}</span>
                          {selectedAlias === host.alias && (
                            <span className="text-meta text-accent-600">已填入</span>
                          )}
                        </span>
                        {host.identityAbsolute && (
                          <span
                            className={
                              'text-meta ' + (host.keyExists ? 'text-ink-500' : 'text-state-bad')
                            }
                          >
                            {host.keyExists ? '私钥已找到' : '私钥文件不存在'}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 break-all font-mono text-sub text-ink-600">
                        {host.user ? `${host.user}@` : ''}
                        {host.hostName}
                        {host.port ? `:${host.port}` : ''}
                      </div>
                      {host.keyEncrypted && (
                        <div className="mt-0.5 text-sub text-state-wait">私钥带口令，填完要在下面补口令</div>
                      )}
                    </button>
                  ))}
                </div>
              ) : (
                <Hint>
                  {ssh?.found
                    ? '这个文件里没有具体的主机（只有通配块），请手填下面的信息，或换个位置。'
                    : '没找到 SSH 配置——第一次连集群的人本来就没有这个文件，直接填下面的信息即可。'}
                </Hint>
              )}

              {ssh && ssh.hosts.length > 0 && selectedAlias && (
                <p className="mt-1.5 text-sub text-ink-600">
                  已按 <span className="font-mono text-ink-800">{selectedAlias}</span>{' '}
                  自动填入下面的表单
                  {ssh.hosts.length > 1 ? '；点另一台可以切换' : ''}。
                </p>
              )}

              {otherHosts.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-sub text-ink-600">
                  <span>其它主机也一起加进来：</span>
                  {otherHosts.map((host) => {
                    const added = extras.includes(host.alias)
                    return (
                      <button
                        key={host.alias}
                        type="button"
                        onClick={() =>
                          setExtras((prev) =>
                            prev.includes(host.alias)
                              ? prev.filter((alias) => alias !== host.alias)
                              : [...prev, host.alias]
                          )
                        }
                        className={
                          'rounded-control border px-2 py-0.5 font-mono text-meta transition ' +
                          (added
                            ? 'border-accent-500/50 bg-accent-500/[0.08] text-ink-900'
                            : 'border-ink-200 bg-surface text-ink-700 hover:bg-ink-50')
                        }
                      >
                        {added ? '✓ ' : '＋ '}
                        {host.alias}
                      </button>
                    )
                  })}
                  <span className="text-ink-500">加进来后可以在标题栏切换</span>
                </div>
              )}

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    const picked = await window.hpc.pickSshConfig()
                    if (picked.ok && picked.path) await loadSsh(picked.path)
                  }}
                  className="rounded-control border border-ink-200 bg-surface px-2.5 py-1 text-sub text-ink-700 transition hover:bg-ink-50"
                >
                  换个位置…
                </button>
                <button
                  type="button"
                  onClick={() => void loadSsh()}
                  className="rounded-control border border-ink-200 bg-surface px-2.5 py-1 text-sub text-ink-700 transition hover:bg-ink-50"
                >
                  重新读取
                </button>
              </div>

              {/* 配置里没写 IdentityFile、但 .ssh 下确实有私钥时，给一条捷径 */}
              {ssh && ssh.keys.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-sub text-ink-600">
                  <span>可用私钥：</span>
                  {ssh.keys.map((key) => (
                    <button
                      key={key.path}
                      type="button"
                      onClick={() => patch({ method: 'key', privateKeyPath: key.path })}
                      className="rounded-control border border-ink-200 bg-surface px-2 py-0.5 font-mono text-meta text-ink-700 transition hover:bg-ink-50"
                    >
                      {key.name}
                      {key.encrypted ? '（带口令）' : ''}
                    </button>
                  ))}
                </div>
              )}

              {ssh && ssh.warnings.length > 0 && (
                <ul className="mt-2 space-y-0.5">
                  {ssh.warnings.map((warning) => (
                    <li key={warning} className="text-sub leading-relaxed text-state-wait">
                      · {warning}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="连接信息">
            <div className="grid gap-3 normal:grid-cols-2">
              <Row label="名称" rule="只是界面上显示的名字，随便填" error={fields.label}>
                <input className={INPUT} value={draft.label} onChange={(e) => patch({ label: e.target.value })} />
              </Row>
              <Row label="端口" rule="默认 22，非标准端口才需要改" error={fields.port}>
                <input
                  className={INPUT}
                  value={draft.port}
                  inputMode="numeric"
                  onChange={(e) => patch({ port: e.target.value })}
                />
              </Row>
              <Row label="主机地址" rule="登录节点的主机名或 IP，不要带 ssh:// 或路径" error={fields.host}>
                <input
                  className={INPUT}
                  value={draft.host}
                  placeholder="login.example.edu.cn"
                  onChange={(e) => patch({ host: e.target.value })}
                />
              </Row>
              <Row label="用户名" rule="集群上 whoami 的结果" error={fields.username}>
                <input
                  className={INPUT}
                  value={draft.username}
                  autoComplete="off"
                  onChange={(e) => patch({ username: e.target.value })}
                />
              </Row>
            </div>

            <div className="mt-4 space-y-2">
              <span className="block text-emph font-medium text-ink-800">登录方式</span>
              <div className="flex gap-2">
                {(
                  [
                    ['key', '私钥文件'],
                    ['password', '密码']
                  ] as Array<['key' | 'password', string]>
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => patch({ method: id })}
                    className={
                      'rounded-control border px-3 py-1.5 text-sub transition ' +
                      (draft.method === id
                        ? 'border-accent-500/50 bg-accent-500/[0.08] text-ink-900'
                        : 'border-ink-200 bg-surface text-ink-700 hover:bg-ink-50')
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>

              {draft.method === 'key' ? (
                <div className="grid gap-3 normal:grid-cols-2">
                  <Row label="私钥路径" rule="支持 ~ 开头，例如 ~/.ssh/id_ed25519" error={fields.privateKeyPath}>
                    <input
                      className={INPUT}
                      value={draft.privateKeyPath}
                      placeholder="~/.ssh/id_ed25519"
                      onChange={(e) => patch({ privateKeyPath: e.target.value })}
                    />
                  </Row>
                  <Row label="私钥口令" rule="私钥没有口令就留空。只存钥匙串，不写进文件">
                    <input
                      className={INPUT}
                      type="password"
                      value={draft.passphrase}
                      autoComplete="off"
                      onChange={(e) => patch({ passphrase: e.target.value })}
                    />
                  </Row>
                </div>
              ) : (
                <Row label="登录密码" rule="只存进系统钥匙串（加密），不会写进配置文件" error={fields.password}>
                  <input
                    className={INPUT}
                    type="password"
                    value={draft.password}
                    autoComplete="off"
                    placeholder="集群的登录密码"
                    onChange={(e) => patch({ password: e.target.value })}
                  />
                </Row>
              )}
            </div>

            {general && (
              <div className="mt-3 rounded-surface border border-state-bad/25 bg-state-bad/[0.06] px-3 py-2 text-body leading-relaxed text-ink-800">
                {general}
              </div>
            )}

            <Hint>
              配置会写到 <Mono>{targetDir}</Mono> 下的 <code className="font-mono">profiles.json</code>。
              文件里只有主机、端口、用户名和认证方式，
              <span className="text-ink-700">没有密码</span>。
            </Hint>
            </Card>
          </div>
        )}

        {step === 'tunnel' && (
          <Card title="隧道端口">
            <div className="grid gap-3 normal:grid-cols-2">
              <Row
                label="集群侧监听端口"
                rule="必须等于集群上 http_proxy 的端口"
                error={tunnelErrors.remotePort}
              >
                <input
                  className={INPUT}
                  value={tunnel.remotePort}
                  inputMode="numeric"
                  onChange={(event) => {
                    setTunnel((prev) => ({ ...prev, remotePort: event.target.value }))
                    setTunnelErrors((prev) => ({ ...prev, remotePort: undefined }))
                  }}
                />
              </Row>
              <Row
                label="本机代理端口"
                rule="你的代理软件真正监听的端口（Clash 常是 7897）"
                error={tunnelErrors.localPort}
              >
                <input
                  className={INPUT}
                  value={tunnel.localPort}
                  inputMode="numeric"
                  onChange={(event) => {
                    setTunnel((prev) => ({ ...prev, localPort: event.target.value }))
                    setTunnelErrors((prev) => ({ ...prev, localPort: undefined }))
                  }}
                />
              </Row>
            </div>

            {/*
              这一段是这一页的全部意义：默认值只对"和我一样的环境"成立。
              写死在代码里的话，用户开着隧道连不上代理时，根本想不到是端口。
            */}
            <div className="mt-3 rounded-surface border border-state-wait/25 bg-state-wait/[0.06] px-3 py-2.5 text-body leading-relaxed text-ink-800">
              <p className="font-medium">这两个值要按你的环境填，别直接照抄默认值</p>
              <ul className="mt-1.5 space-y-1.5">
                <li>
                  · <span className="font-mono">{TUNNEL_DEFAULTS.remotePort}</span> 必须和集群{' '}
                  <code className="font-mono">~/.profile</code> 里 <code className="font-mono">http_proxy</code>{' '}
                  的端口一致。不一致时集群上的 pip / conda / 各种命令行工具的代理会连不上，
                  而报错只会说"连接被拒绝"，指不到端口上来。核对：
                  <code className="mt-0.5 block break-all font-mono text-sub">
                    ssh hpc &quot;grep -n http_proxy ~/.profile&quot;
                  </code>
                </li>
                <li>
                  · <span className="font-mono">{TUNNEL_DEFAULTS.localPort}</span> 是你本机代理软件真正监听的端口——
                  Clash 默认 <span className="font-mono">7897</span>，V2Ray 常见{' '}
                  <span className="font-mono">10809</span>。开隧道前先确认它在跑。
                </li>
                <li>
                  · 别选 32768 以上的固定端口：那一段是系统临时端口区，会被别人的出站连接临时占用，
                  表现为"时好时坏、查又查不到"。
                </li>
              </ul>
            </div>

            {tunnelWarnings.length > 0 && (
              <ul className="mt-2 space-y-0.5">
                {tunnelWarnings.map((warning) => (
                  <li key={warning} className="text-sub leading-relaxed text-state-wait">
                    · {warning}
                  </li>
                ))}
              </ul>
            )}

            <Hint>
              不用代理也可以保持默认直接下一步——这两个值只是「隧道」页的初始值，不影响其它功能。
              之后想改，去「隧道」页手动填一次即可。
            </Hint>
          </Card>
        )}

        {step === 'done' && result && (
          <Card title="配好了">
            <div className="space-y-3">
              <p className="text-body leading-relaxed text-ink-800">
                配置文件已生成：
              </p>
              <div className="rounded-surface border border-ink-200 bg-ink-50 px-3 py-2">
                <Mono>{result.configPath}</Mono>
              </div>
              {result.warnings?.map((warning) => (
                <div
                  key={warning}
                  className="rounded-surface border border-state-wait/25 bg-state-wait/[0.06] px-3 py-2 text-body leading-relaxed text-ink-800"
                >
                  {warning}
                </div>
              ))}
              <Hint>
                下次启动不会再问这些。要改主机、换机器，去「设置 → 配置目录」和「设置 → 登录凭据」。
                也可以直接编辑上面那个 JSON 文件，改完重启应用即可。
              </Hint>
            </div>
          </Card>
        )}

        <div className="mt-4 flex items-center gap-2">
          {(step === 'connect' || step === 'tunnel') && (
            <button
              type="button"
              onClick={() => setStep(step === 'tunnel' ? 'connect' : 'where')}
              className="rounded-control border border-ink-200 bg-surface px-3 py-1.5 text-sub text-ink-700 transition hover:bg-ink-50"
            >
              上一步
            </button>
          )}
          {step !== 'done' && (
            <button
              type="button"
              onClick={next}
              disabled={busy}
              className="rounded-control bg-inverse px-4 py-1.5 text-sub font-medium text-white transition hover:bg-ink-800 disabled:opacity-40"
            >
              {busy ? '正在写入…' : step === 'tunnel' ? '生成配置' : '下一步'}
            </button>
          )}
          {step === 'done' && (
            <button
              type="button"
              onClick={() => {
                if (result?.restartRequired) void window.hpc.relaunch()
                else onDone()
              }}
              className="rounded-control bg-inverse px-4 py-1.5 text-sub font-medium text-white transition hover:bg-ink-800"
            >
              {result?.restartRequired ? '重启并进入' : '进入应用'}
            </button>
          )}
        </div>
    </PageShell>
  )
}
