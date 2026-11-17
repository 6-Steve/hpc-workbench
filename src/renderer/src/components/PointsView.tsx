/**
 * 点数页：余额 / 消耗记录 / 赠送。
 *
 * ## 三件事的粒度完全不同，所以没有合成一个轮询
 *
 * | 区域 | 数据源 | 频率 | 理由 |
 * |---|---|---|---|
 * | 余额 | `scir-account -d` | 5 分钟 + 手动 | 变化慢，实测 197 ms |
 * | 消耗记录 | `scir-account details -r` | **只按需** | 一次返回全部历史（实测 19 条 / 43 行），没有时间过滤参数 |
 * | 赠送 | `scir-account transfer` | 用户触发 | 会扣钱，绝不能自动跑 |
 *
 * 消耗记录不轮询的原因很实在：`details` 没有 `--since` 之类的参数，
 * 拉一次就是全量。按 5 分钟轮询等于每 5 分钟重传一遍一模一样的表。
 *
 * ## 一个必须诚实展示的事实
 *
 * 逐条相加的扣费 **不等于** 表尾的 `Used`（实测 0.01 vs 0.02）。
 * 这不是解析错误——每条只给 2 位小数，平台自己舍入过。
 * 界面把两个数分开列，并且**不报警**，否则用户会以为程序算错了。
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { PageShell, PageHeader, Card, EmptyState, Hint } from './ui'
import { usePoll } from '../lib/use-poll'
import { formatPoints } from '../lib/price'

interface PointsViewProps {
  /** 切换跳板机后 +1，用来清空旧机器的数字 */
  refreshKey: number
}

/** 余额区多久拉一次。和标题栏一致，都是 5 分钟（配额/点数几乎不变） */
const POINTS_POLL_MS = 5 * 60_000

export function PointsView({ refreshKey }: PointsViewProps): JSX.Element {
  const [usage, setUsage] = useState<PointsUsage | null>(null)
  const [usageError, setUsageError] = useState<string | null>(null)
  const [usageLoading, setUsageLoading] = useState(false)
  const [usageLoadedAt, setUsageLoadedAt] = useState<number | null>(null)

  const balance = usePoll(
    useCallback(async () => {
      const response = await window.hpc.getPoints()
      if (!response.ok) throw new Error(response.error?.message ?? '读取点数失败')
      return response.points ?? null
    }, []),
    POINTS_POLL_MS,
    true,
    refreshKey
  )

  /** 消耗记录单独拉，不进轮询 */
  const loadUsage = useCallback(async (): Promise<void> => {
    setUsageLoading(true)
    setUsageError(null)
    try {
      const response = await window.hpc.getPointsUsage()
      if (!response.ok || !response.usage) {
        setUsageError(response.error?.message ?? '读取消耗记录失败')
        setUsage(null)
        return
      }
      setUsage(response.usage)
      setUsageLoadedAt(Date.now())
    } catch (err) {
      setUsageError(err instanceof Error ? err.message : String(err))
      setUsage(null)
    } finally {
      setUsageLoading(false)
    }
  }, [])

  const points = balance.data

  return (
    <PageShell>
      <PageHeader
        title="点数"
        description="余额、每个作业扣了多少、以及怎么把点数转给别人。"
      />

      {/* —————————————— 余额 —————————————— */}
      <div className="mb-5 grid gap-3 compact:grid-cols-3">
        <BalanceTile
          label="可用"
          value={points ? formatPoints(points.avail) : null}
          tone="primary"
          loading={balance.pending}
        />
        <BalanceTile label="已用" value={points ? formatPoints(points.used) : null} loading={balance.pending} />
        <BalanceTile label="总额度" value={points ? formatPoints(points.total) : null} loading={balance.pending} />
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-3 text-sub text-ink-500">
        <button
          type="button"
          onClick={balance.refresh}
          disabled={balance.refreshing}
          className="rounded-control border border-ink-200 bg-surface px-3 py-1.5 text-emph text-ink-700 shadow-card transition hover:bg-ink-50 disabled:opacity-60"
        >
          {balance.refreshing ? '刷新中…' : '刷新余额'}
        </button>
        <span>
          {balance.pending
            ? '正在读取…'
            : balance.updatedAt
              ? `上次更新 ${new Date(balance.updatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`
              : '还没读成功过'}
        </span>
        {balance.error !== null && (
          <span className="text-state-bad">
            {balance.error instanceof Error ? balance.error.message : String(balance.error)}
          </span>
        )}
      </div>

      {/* —————————————— 消耗记录 —————————————— */}
      <div className="mb-6">
        <Card
          title="消耗记录"
          aside={
            <div className="flex items-center gap-2">
              {usageLoadedAt !== null && (
                <span className="text-sub text-ink-500">
                  {new Date(usageLoadedAt).toLocaleTimeString('zh-CN', { hour12: false })} 拉取
                </span>
              )}
              <button
                type="button"
                onClick={() => void loadUsage()}
                disabled={usageLoading}
                className="rounded-control border border-ink-200 bg-surface px-3 py-1 text-sub text-ink-700 transition hover:bg-ink-50 disabled:opacity-60"
              >
                {usageLoading ? '读取中…' : usage === null ? '加载记录' : '重新加载'}
              </button>
            </div>
          }
        >
          {usageError !== null ? (
            <p className="text-emph text-state-bad">{usageError}</p>
          ) : usage === null ? (
            <p className="text-emph text-ink-500">
              还没有加载。这个表不给按时间筛选，一次就是账号下全部作业记录，所以它不会自动刷新。
            </p>
          ) : (
            <UsageTable usage={usage} />
          )}
        </Card>
      </div>

      {/* —————————————— 赠送 —————————————— */}
      <div className="grid gap-4 wide:grid-cols-2">
        <TransferCard
          available={points?.avail ?? null}
          onDone={() => {
            // 转账成功后立刻刷新余额和记录——这是唯一能证明"点数真的动了"的东西
            balance.refresh()
            if (usage !== null) void loadUsage()
          }}
        />
        <GiftRequestCard />
      </div>
    </PageShell>
  )
}

function BalanceTile({
  label,
  value,
  tone = 'plain',
  loading
}: {
  label: string
  value: string | null
  tone?: 'plain' | 'primary'
  loading: boolean
}): JSX.Element {
  return (
    <div className="rounded-surface border border-ink-200/80 bg-surface px-5 py-4 shadow-card">
      <div className="text-sub text-ink-500">{label}</div>
      <div
        className={
          'mt-1 font-mono text-page leading-tight tabular-nums ' +
          (tone === 'primary' ? 'text-ink-900' : 'text-ink-700')
        }
      >
        {value ?? (loading ? '…' : '—')}
      </div>
    </div>
  )
}

/** 表格一次最多渲染多少行。`details` 没有时间过滤，历史长了就是几百条 */
const MAX_ROWS = 200

function UsageTable({ usage }: { usage: PointsUsage }): JSX.Element {
  const [expanded, setExpanded] = useState<string | null>(null)
  const [showResources, setShowResources] = useState(false)
  const [sortDesc, setSortDesc] = useState(true)
  const [hideZero, setHideZero] = useState(false)

  const rows = useMemo(() => {
    const filtered = hideZero ? usage.rows.filter((row) => row.points > 0) : usage.rows
    // 按点数排，再按作业号排（点数相同时作业号大的在上，也就是新的在上）
    const sorted = [...filtered].sort((a, b) => {
      if (a.points !== b.points) return sortDesc ? b.points - a.points : a.points - b.points
      return Number(b.jobId) - Number(a.jobId)
    })
    return sorted
  }, [usage.rows, sortDesc, hideZero])

  const zeroCount = usage.rows.length - usage.rows.filter((row) => row.points > 0).length

  if (usage.rows.length === 0) {
    return <EmptyState title="还没有任何作业记录" hint="跑过作业之后这里就会有数。" />
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3 text-sub">
        <button
          type="button"
          onClick={() => setSortDesc((v) => !v)}
          className="rounded-control border border-ink-200 px-2 py-1 text-ink-700 transition hover:bg-ink-50"
        >
          按扣费 {sortDesc ? '从多到少' : '从少到多'}
        </button>
        <label className="flex cursor-pointer items-center gap-1.5 text-ink-600">
          <input
            type="checkbox"
            checked={showResources}
            onChange={(event) => setShowResources(event.target.checked)}
            className="accent-ink-700"
          />
          显示资源列
        </label>
        {zeroCount > 0 && (
          <label className="flex cursor-pointer items-center gap-1.5 text-ink-600">
            <input
              type="checkbox"
              checked={hideZero}
              onChange={(event) => setHideZero(event.target.checked)}
              className="accent-ink-700"
            />
            只看扣过费的（{usage.rows.length - zeroCount}）
          </label>
        )}
        <span className="text-ink-500">
          显示 {rows.length} / {usage.rows.length} 条
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="text-emph text-ink-500">没有扣过点数的作业。</p>
      ) : (
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-emph">
          <thead>
            <tr className="border-b border-ink-200 text-left text-sub text-ink-500">
              <th className="py-2 pr-3 font-medium">作业号</th>
              <th className="py-2 pr-3 font-medium">作业名</th>
              {showResources && <th className="py-2 pr-3 font-medium">资源</th>}
              <th className="py-2 pr-3 text-right font-medium">用时</th>
              <th className="py-2 pr-3 text-right font-medium">时长上限</th>
              <th className="py-2 text-right font-medium">扣费</th>
            </tr>
          </thead>
          <tbody>
            {/*
              key 必须放在 Fragment 上：放在里面的 tr 上不算数，
              React 会拿索引复用，展开行会跑到别的作业下面去。
            */}
            {rows.slice(0, MAX_ROWS).map((row) => {
              const isOpen = expanded === row.jobId
              return (
                <Fragment key={row.jobId}>
                  <tr
                    onClick={() => setExpanded(isOpen ? null : row.jobId)}
                    className={
                      'cursor-pointer border-b border-ink-100 transition ' +
                      (isOpen ? 'bg-ink-50' : 'hover:bg-ink-50')
                    }
                  >
                    <td className="py-1.5 pr-3 font-mono text-ink-700">{row.jobId}</td>
                    <td className="py-1.5 pr-3 text-ink-800">{row.jobName || '—'}</td>
                    {showResources && (
                      <td className="max-w-[280px] truncate py-1.5 pr-3 font-mono text-sub text-ink-600">
                        {row.gpuType ? `${row.gpuType} × ${row.gpuCount ?? '?'}` : row.resources ? 'CPU' : '—'}
                      </td>
                    )}
                    <td className="py-1.5 pr-3 text-right font-mono tabular-nums text-ink-700">
                      {row.hours.toFixed(2)} h
                    </td>
                    <td className="py-1.5 pr-3 text-right font-mono tabular-nums text-ink-500">
                      {row.limitHours.toFixed(2)} h
                    </td>
                    <td
                      className={
                        'py-1.5 text-right font-mono tabular-nums ' +
                        (row.points > 0 ? 'text-ink-900' : 'text-ink-500')
                      }
                    >
                      {row.points.toFixed(2)}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="border-b border-ink-100 bg-ink-50/60">
                      <td colSpan={showResources ? 6 : 5} className="px-3 py-2">
                        <UsageDetail row={row} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
      )}
      {rows.length > MAX_ROWS && (
        <p className="mt-2 text-sub text-ink-500">
          只显示了前 {MAX_ROWS} 条。这个命令没有按时间筛选的参数，要全部列出来请用
          <span className="font-mono"> scir-account details -r </span>直接在终端里看。
        </p>
      )}

      {/* 汇总：两个数分开展示，且说明为什么不相等 */}
      <div className="mt-3 rounded-control bg-ink-50 px-3 py-2 text-sub text-ink-600">
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <span>
            逐条相加 <span className="font-mono text-ink-800">{usage.sum.points.toFixed(2)}</span>
          </span>
          {usage.totals && (
            <span>
              合计已用 <span className="font-mono text-ink-800">{usage.totals.used.toFixed(2)}</span>
            </span>
          )}
          {usage.sum.diff !== null && usage.sum.diff !== 0 && (
            <span className="text-ink-500">差 {usage.sum.diff.toFixed(2)}</span>
          )}
        </div>
        {usage.sum.diff !== null && usage.sum.diff !== 0 && (
          <p className="mt-1 text-ink-500">
            两个数不完全相等是正常的：每条记录只保留两位小数，平台自己已经四舍五入过一轮。
            这是它自己的账目口径，不是这里算错了。
          </p>
        )}
      </div>
    </div>
  )
}

function UsageDetail({ row }: { row: PointsUsageRow }): JSX.Element {
  return (
    <div className="space-y-1 font-mono text-sub text-ink-600">
      <div>
        计费权重 billing = <span className="text-ink-800">{row.billing ?? '—'}</span>
        <span className="ml-2 text-ink-500">（SLURM 的权重，不是点数）</span>
      </div>
      {row.gpuType && (
        <div>
          GPU = <span className="text-ink-800">{row.gpuType}</span> × {row.gpuCount ?? '?'}
        </div>
      )}
      {row.resources ? (
        <div className="break-all">
          <span className="text-ink-500">Resources: </span>
          {row.resources}
        </div>
      ) : (
        <div className="text-ink-500">这条没有资源明细（数据里没带 -r 那一列）</div>
      )}
    </div>
  )
}

/**
 * 「我送别人」。
 *
 * ⚠️ 这是全应用唯一会扣钱的表单，所以三件事都做足：
 * 1. 提交前弹确认，把"账号 / 点数 / 有效期"再念一遍
 * 2. 密码只在这一刻存在于组件状态里，提交后立刻清掉
 * 3. 成功之后用**重新查到的余额**说话，不是用退出码说话
 */
function TransferCard({ available, onDone }: { available: number | null; onDone: () => void }): JSX.Element {
  const [target, setTarget] = useState('')
  const [points, setPoints] = useState('')
  const [month, setMonth] = useState('1')
  const [password, setPassword] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 平台原话。LDAP 那类错误只有原文能看出是"密码错"还是"账号被锁" */
  const [errorRaw, setErrorRaw] = useState<string | null>(null)

  /**
   * 凭据库里有没有存过平台账号密码。
   *
   * `null` = 还不知道（第一次查）。有这个状态才能决定是显示
   * 「用已保存的密码」还是直接要输入框——不然用户会先看到一个空的密码框，
   * 以为必须手输。
   */
  const [storedReady, setStoredReady] = useState<boolean | null>(null)
  const [useStored, setUseStored] = useState(false)

  useEffect(() => {
    let alive = true
    void window.hpc
      .listCredentials()
      .then((response) => {
        if (!alive) return
        const has = (response.targets ?? []).some(
          (item) => item.kind === 'platform-password' && item.configured
        )
        setStoredReady(has)
        setUseStored(has)
      })
      .catch(() => {
        if (alive) setStoredReady(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const amount = Number(points)
  const months = Number(month)
  /** 密码要么用存的，要么当场输。只勾"用已保存"时不要求输入框有内容 */
  const passwordReady = useStored || password.length > 0
  const canSubmit =
    target.trim().length > 0 &&
    Number.isInteger(amount) &&
    amount > 0 &&
    Number.isInteger(months) &&
    months >= 1 &&
    passwordReady &&
    !busy

  const overBalance = available !== null && Number.isInteger(amount) && amount > available

  const submit = async (): Promise<void> => {
    setConfirming(false)
    setBusy(true)
    setError(null)
    setErrorRaw(null)
    setMessage(null)
    try {
      const response = await window.hpc.transferPoints({
        target: target.trim(),
        points: amount,
        month: months,
        // 用已保存的就不把明文传出去——主进程自己去库里取
        ...(useStored ? { useStoredPassword: true } : { password })
      })
      if (!response.ok) {
        const plain = response.error
        setError(
          plain?.hint ? `${plain.message}。${plain.hint}` : (plain?.message ?? '转账失败')
        )
        setErrorRaw(plain?.raw ?? null)
        return
      }
      const after = response.points
      setMessage(
        after
          ? `转账完成。现在可用 ${formatPoints(after.avail)} 点。`
          : '转账完成。刷新余额确认一下。'
      )
      // 密码用完立刻丢掉，不在内存里多留一秒
      setPassword('')
      setPoints('')
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="送点数给别人">
      <div className="space-y-3">
        <label className="block">
          <span className="text-sub text-ink-500">对方账号</span>
          <input
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            placeholder="例如 zhangsan"
            className="mt-1 w-full rounded-control border border-ink-200 px-3 py-1.5 font-mono text-emph text-ink-800 outline-none focus:border-ink-400"
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-sub text-ink-500">点数</span>
            <input
              value={points}
              onChange={(event) => setPoints(event.target.value)}
              inputMode="numeric"
              placeholder="整数"
              className="mt-1 w-full rounded-control border border-ink-200 px-3 py-1.5 font-mono text-emph text-ink-800 outline-none focus:border-ink-400"
            />
          </label>
          <label className="block">
            <span className="text-sub text-ink-500">有效期（月）</span>
            <input
              value={month}
              onChange={(event) => setMonth(event.target.value)}
              inputMode="numeric"
              className="mt-1 w-full rounded-control border border-ink-200 px-3 py-1.5 font-mono text-emph text-ink-800 outline-none focus:border-ink-400"
            />
          </label>
        </div>

        {/*
          存过密码就默认用存的——这是"存了就该省事"的兑现。
          没存过、或者用户想临时换一个，才展开输入框。
        */}
        {storedReady === true && (
          <label className="flex cursor-pointer items-center gap-1.5 text-sub text-ink-600">
            <input
              type="checkbox"
              checked={useStored}
              onChange={(event) => {
                setUseStored(event.target.checked)
                if (event.target.checked) setPassword('')
              }}
              className="h-3 w-3 accent-ink-700"
            />
            用已保存的平台密码
            <span className="text-meta text-ink-500">（设置 → 登录凭据）</span>
          </label>
        )}

        {!useStored && (
          <label className="block">
            <span className="text-sub text-ink-500">集群密码</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="只用于这一次转账"
              autoComplete="off"
              className="mt-1 w-full rounded-control border border-ink-200 px-3 py-1.5 text-emph text-ink-800 outline-none focus:border-ink-400"
            />
          </label>
        )}

        <Hint>
          {useStored
            ? '用「设置 → 登录凭据」里保存的平台账号密码。密码不经过界面，由主程序直接取用。'
            : '平台的这个命令走 LDAP 密码认证，SSH 密钥认证不到它。密码只经过这一次调用，不写盘、不进命令记录。'}
        </Hint>

        {overBalance && (
          <p className="text-sub text-state-wait">这比你现在的可用点数（{formatPoints(available ?? 0)}）还多。</p>
        )}

        {!confirming ? (
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => setConfirming(true)}
            className="w-full rounded-control bg-inverse px-3 py-2 text-emph font-medium text-white transition hover:bg-ink-800 disabled:opacity-40"
          >
            {busy ? '转账中…' : '送点数'}
          </button>
        ) : (
          <div className="rounded-control border border-state-wait/40 bg-state-wait/10 px-3 py-2">
            <p className="text-emph text-ink-800">
              确认把 <span className="font-mono">{amount}</span> 点送给{' '}
              <span className="font-mono">{target.trim()}</span>，{months} 个月后到期？
            </p>
            <p className="mt-1 text-sub text-ink-600">这一步会真的扣点数，扣了要不回来。</p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => void submit()}
                className="rounded-control bg-state-wait px-3 py-1.5 text-sub font-medium text-white"
              >
                确认送出
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-control border border-ink-200 px-3 py-1.5 text-sub text-ink-700"
              >
                取消
              </button>
            </div>
          </div>
        )}

        {error !== null && (
          <div className="space-y-1">
            <p className="text-sub text-state-bad">{error}</p>
            {errorRaw !== null && (
              <details className="rounded-control border border-ink-200 bg-ink-50 px-3 py-2">
                <summary className="cursor-pointer text-sub text-ink-600">平台原话</summary>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-sub text-ink-700">
                  {errorRaw}
                </pre>
              </details>
            )}
          </div>
        )}
        {message !== null && <p className="text-sub text-state-ok">{message}</p>}
      </div>
    </Card>
  )
}

/**
 * 「别人送我」。
 *
 * 平台**没有**"向某人要点数"的命令（实测 `transfer` 只有付出方向），
 * 所以这里能做的是「生成一段给对方的说明」——里面填好我的账号名，
 * 对方复制过去一跑就把点数转过来了。
 */
function GiftRequestCard(): JSX.Element {
  const [points, setPoints] = useState('')
  const [month, setMonth] = useState('1')
  const [text, setText] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const generate = async (): Promise<void> => {
    setError(null)
    setCopied(false)
    const response = await window.hpc.getPointsGiftInstruction({
      points: points.trim() === '' ? undefined : Number(points),
      month: month.trim() === '' ? undefined : Number(month)
    })
    if (!response.ok || !response.text) {
      setError(response.error?.message ?? '生成失败')
      return
    }
    setText(response.text)
  }

  const copy = async (): Promise<void> => {
    if (text === null) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      // 2 秒后收回「已复制」：一直挂着会让人不确定下一次复制有没有生效
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('复制失败，可以手动选中下面的文字')
    }
  }

  return (
    <Card title="让别人送给我">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-sub text-ink-500">想让他送多少点</span>
            <input
              value={points}
              onChange={(event) => setPoints(event.target.value)}
              inputMode="numeric"
              placeholder="可留空"
              className="mt-1 w-full rounded-control border border-ink-200 px-3 py-1.5 font-mono text-emph text-ink-800 outline-none focus:border-ink-400"
            />
          </label>
          <label className="block">
            <span className="text-sub text-ink-500">有效期（月）</span>
            <input
              value={month}
              onChange={(event) => setMonth(event.target.value)}
              inputMode="numeric"
              className="mt-1 w-full rounded-control border border-ink-200 px-3 py-1.5 font-mono text-emph text-ink-800 outline-none focus:border-ink-400"
            />
          </label>
        </div>

        <button
          type="button"
          onClick={() => void generate()}
          className="w-full rounded-control border border-ink-200 bg-surface px-3 py-2 text-emph text-ink-800 shadow-card transition hover:bg-ink-50"
        >
          生成给他人的说明
        </button>

        {error !== null && <p className="text-sub text-state-bad">{error}</p>}

        {text !== null && (
          <div>
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-control bg-ink-50 px-3 py-2 font-mono text-sub text-ink-700">
              {text}
            </pre>
            <button
              type="button"
              onClick={() => void copy()}
              className="mt-2 rounded-control bg-inverse px-3 py-1.5 text-sub font-medium text-white transition hover:bg-ink-800"
            >
              {copied ? '已复制' : '复制这段'}
            </button>
          </div>
        )}
      </div>
    </Card>
  )
}
