import { useCallback, useEffect, useState } from 'react'
import { formatSize } from '../lib/format'
import { NodeJobsDialog } from './NodeJobsDialog'
import { SubmitJobDialog } from './SubmitJobDialog'
import { VirtualList } from './VirtualList'
import { CACHE_KEYS, dedupe, readCache, writeCache } from '../lib/swr-cache'
import { estimateCost, formatPoints, formatPrice, priceByType, type PriceRange } from '../lib/price'
import { slotsOf, type SlotState } from '../../../shared/gpu-slots'
import { Card, Hint, PageHeader, PageShell, SectionTitle } from './ui'

/**
 * 一个格子的样式。
 *
 * 三态用**实心 / 实心灰 / 空心**区分：7px 太小，画不了斜线；
 * 而"空心"和"实心"的差别在缩略尺寸下也能认出来，色盲用户同样能分辨。
 * 只使用已注册的语义 token（`state-ok` / `ink-*`）。另起一套专用色板名会因为
 * 未注册而在构建产物里**静默无输出**——构建、tsc、测试全绿，格子就是没颜色。
 */
function slotClass(state: SlotState): string {
  const base = 'h-[7px] w-[7px] shrink-0 rounded-[1px]'
  if (state === 'free') return `${base} bg-state-ok`
  if (state === 'used') return `${base} bg-ink-300`
  return `${base} border border-ink-300 bg-transparent`
}

/** 节点状态的展示样式。区分「能用」「用满」「不能用」三种，这是用户唯一关心的 */
function nodeBadge(node: NodeInfo): { label: string; className: string } {
  if (node.blocked) {
    return { label: node.rawStates.join(' + ') || '不可用', className: 'border-ink-200 bg-ink-50 text-ink-500' }
  }

  const freeGpus = node.gpus.reduce((sum, item) => {
    const used = node.gpusUsed.find((u) => u.type === item.type)?.count ?? 0
    return sum + Math.max(0, item.count - used)
  }, 0)

  // ALLOCATED 但还空着卡 —— 这正是 scontrol 不返回 MIXED 的那个坑，
  // 界面上要表达成"部分占用"，不能笼统说"使用中"
  if (freeGpus > 0) {
    // 卡还有，核却一个不剩：这台机器实际上塞不进新的 GPU 作业。
    // 集群是混部的——别人的 CPU 作业把核吃光了，卡就白白闲着，
    // 光看"空闲 6 张卡"会让人以为能跑，必须单独标出来
    if (node.idleCpus <= 0 && node.gpus.length > 0) {
      return {
        label: '卡空着但核满',
        className: 'border-state-wait/25 bg-state-wait/[0.06] text-state-wait'
      }
    }
    return {
      label: node.gpus.length > 0 ? '部分空闲' : '部分占用',
      className: 'border-state-ok/25 bg-state-ok/[0.06] text-state-ok'
    }
  }

  if (node.gpus.length === 0) {
    return { label: node.idleCpus > 0 ? '空闲' : '占用中', className: node.idleCpus > 0
      ? 'border-state-info/25 bg-state-info/[0.05] text-state-info'
      : 'border-state-wait/25 bg-state-wait/[0.06] text-state-wait' }
  }

  return { label: '已用满', className: 'border-state-wait/25 bg-state-wait/[0.06] text-state-wait' }
}

/**
 * 存储配额卡片。
 *
 * 用**软限**算百分比（软限是"该清理了"的提醒线）；没设软限才用硬限；
 * 两个都没有就只显示已用，不画进度条——画一个满格的红条是误导。
 */
function QuotaCard({ quota }: { quota: Quota }): JSX.Element {
  const limit = quota.bytes.soft ?? quota.bytes.hard
  const ratio = limit !== null && limit > 0 ? quota.bytes.used / limit : null

  const tone =
    ratio === null
      ? 'bg-ink-400'
      : ratio >= 0.95
        ? 'bg-state-bad'
        : ratio >= 0.8
          ? 'bg-state-wait'
          : 'bg-state-ok'

  const fileLimit = quota.files.soft ?? quota.files.hard
  const fileRatio = fileLimit !== null && fileLimit > 0 ? quota.files.used / fileLimit : null

  return (
    <div className="rounded-surface border border-ink-200/80 bg-surface px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-mono text-body font-semibold text-ink-800">{quota.filesystem}</span>
        <span className="text-sub text-ink-500">
          {quota.type}
          {quota.bytes.grace !== 'none' && quota.bytes.grace !== '' && (
            <span className="ml-2 text-state-wait">宽限期 {quota.bytes.grace}</span>
          )}
        </span>
      </div>

      <div className="mt-2.5 space-y-2">
        <div>
          <div className="mb-1 flex items-baseline justify-between text-sub">
            <span className="text-ink-500">空间</span>
            <span className="font-mono text-ink-700">
              {formatSize(quota.bytes.used)}
              {limit !== null ? ` / ${formatSize(limit)}` : ''}
              {ratio !== null && <span className="ml-1.5 text-ink-500">({(ratio * 100).toFixed(1)}%)</span>}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-ink-100">
            {ratio !== null && (
              <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
            )}
          </div>
          {quota.bytes.hard !== null && quota.bytes.soft !== null && (
            <p className="mt-1 text-meta text-ink-500">硬上限 {formatSize(quota.bytes.hard)}，超了会被直接拒绝写入</p>
          )}
        </div>

        <div>
          <div className="mb-1 flex items-baseline justify-between text-sub">
            <span className="text-ink-500">文件数</span>
            <span className="font-mono text-ink-700">
              {quota.files.used.toLocaleString('zh-CN')}
              {fileLimit !== null ? ` / ${fileLimit.toLocaleString('zh-CN')}` : ''}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-ink-100">
            {fileRatio !== null && (
              <div
                className="h-full rounded-full bg-state-info"
                style={{ width: `${Math.min(100, fileRatio * 100)}%` }}
              />
            )}
          </div>
        </div>
      </div>

      {/* inDoubt 是 GPFS 尚未结算的量，正常现象，说明一下免得用户以为出错 */}
      {quota.bytes.inDoubt > 0 && (
        <p className="mt-2 text-meta text-ink-500">
          另有 {formatSize(quota.bytes.inDoubt)} 尚未结算（正常，配额统计有几分钟延迟）
        </p>
      )}
    </div>
  )
}

/**
 * 资源页：节点 / GPU 库存 + 存储配额。
 *
 * 回答一个非常具体的问题：**现在哪台机器上还有空着的卡，我能不能马上用。**
 *
 * 数据来自 `scontrol show node --json`（逐节点真值），不是 `sinfo`
 * ——后者是分区聚合，拿不到逐节点 GPU。
 */
export function ResourcesView({ refreshKey = 0 }: { refreshKey?: number } = {}): JSX.Element {
  const [inventory, setInventory] = useState<InventoryPayload | null>(null)
  const [error, setError] = useState<PlainError | null>(null)
  const [loading, setLoading] = useState(false)
  const [showBlocked, setShowBlocked] = useState(false)

  // 配额单独一份状态：它比节点慢（实测 ~550 ms），不该拖住节点表的渲染
  const [quotas, setQuotas] = useState<Quota[] | null>(null)
  const [quotaError, setQuotaError] = useState<PlainError | null>(null)
  const [quotaLoading, setQuotaLoading] = useState(false)

  // —— 显卡单价与费用试算 ——
  const [prices, setPrices] = useState<Map<string, PriceRange>>(new Map())
  const [priceError, setPriceError] = useState<PlainError | null>(null)
  const [calcType, setCalcType] = useState('')
  const [calcGpus, setCalcGpus] = useState(4)
  const [calcHours, setCalcHours] = useState(8)

  /** 从型号卡片点「租这个」时带过去的参数 */
  const [rent, setRent] = useState<{ type: string; gpus: number } | null>(null)
  const [rentNotice, setRentNotice] = useState<string | null>(null)
  /** 展开哪个型号看具体机器 */
  const [expandedType, setExpandedType] = useState<string | null>(null)
  /** 要查看「谁在用」的节点；null = 没打开弹框 */
  const [jobsNode, setJobsNode] = useState<{ name: string; cpuTotal: number } | null>(null)

  const load = useCallback(async (options?: { noCache?: boolean }): Promise<void> => {
    // 先出缓存再刷新：切回本页时不该白一下（方案三的 SWR）。
    // `noCache` 只给"用户主动点刷新"用——那时他想看的是新数据，不是旧数据。
    if (!options?.noCache) {
      const cached = readCache<InventoryPayload>(CACHE_KEYS.nodes)
      if (cached) setInventory(cached.value)
    }

    setLoading(true)
    setError(null)
    try {
      const response = await dedupe(CACHE_KEYS.nodes, () => window.hpc.listNodes())
      if (response.ok && response.inventory) {
        setInventory(response.inventory)
        writeCache(CACHE_KEYS.nodes, response.inventory)
        setError(null)
      } else {
        setError(response.error ?? { kind: 'ipc', message: '没有拿到节点信息', raw: JSON.stringify(response) })
      }
    } catch (err) {
      setError({ kind: 'ipc', message: '查询节点失败', raw: String(err) })
    } finally {
      setLoading(false)
    }
  }, [])

  const loadQuota = useCallback(async (options?: { noCache?: boolean }): Promise<void> => {
    if (!options?.noCache) {
      const cached = readCache<Quota[]>(CACHE_KEYS.quota)
      if (cached) setQuotas(cached.value)
    }

    setQuotaLoading(true)
    setQuotaError(null)
    try {
      const response = await dedupe(CACHE_KEYS.quota, () => window.hpc.getQuota())
      if (response.ok && response.quotas) {
        setQuotas(response.quotas)
        writeCache(CACHE_KEYS.quota, response.quotas)
      } else {
        setQuotaError(response.error ?? { kind: 'ipc', message: '没有拿到配额信息', raw: JSON.stringify(response) })
      }
    } catch (err) {
      setQuotaError({ kind: 'ipc', message: '查询配额失败', raw: String(err) })
    } finally {
      setQuotaLoading(false)
    }
  }, [])

  const loadPrices = useCallback(async (options?: { noCache?: boolean }): Promise<void> => {
    if (!options?.noCache) {
      const cached = readCache<Map<string, PriceRange>>(CACHE_KEYS.prices)
      if (cached) setPrices(cached.value)
    }

    setPriceError(null)
    try {
      const response = await dedupe(CACHE_KEYS.prices, () => window.hpc.getPrices())
      if (response.ok && response.prices) {
        const byType = priceByType(response.prices)
        setPrices(byType)
        writeCache(CACHE_KEYS.prices, byType)
      } else {
        // 价格拿不到不影响库存可用，只在试算区提示
        setPriceError(response.error ?? { kind: 'ipc', message: '没有拿到价格', raw: JSON.stringify(response) })
      }
    } catch (err) {
      setPriceError({ kind: 'ipc', message: '查询价格失败', raw: String(err) })
    }
  }, [])

  useEffect(() => {
    // 切了跳板机就得整份重拉：节点、配额、价格全是旧机器上的
    // （配额是每 5 分钟轮询的，不主动拉的话用户会对着 A 机的数字以为在看 B 机）
    setInventory(null)
    setQuotas(null)
    setPrices(new Map())
    void load()
    void loadQuota()
    void loadPrices()
    // refreshKey 是**故意**放进去的：它的唯一作用就是"变了就重新拉一遍"
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, loadQuota, loadPrices, refreshKey])

  const nodes = inventory
    ? showBlocked
      ? [...inventory.usableNodes, ...inventory.blockedNodes]
      : inventory.usableNodes
    : []

  // 默认选第一个型号，用户切过就用他的选择
  const activeType = calcType || inventory?.gpuTypes[0]?.type || ''

  return (
    <PageShell>
      <PageHeader
        title="资源"
        description={
          inventory
            ? `${inventory.totals.usableNodes} / ${inventory.totals.nodes} 台可用　·　显卡空闲 ${inventory.totals.gpuFree} / ${inventory.totals.gpuTotal}　·　空闲核心 ${inventory.totals.idleCpus}`
            : '正在读取…'
        }
        aside={
          <button
            type="button"
            onClick={() => {
              // 用户主动点刷新：绕过缓存，三个都重新拉
              void load({ noCache: true })
              void loadQuota({ noCache: true })
              void loadPrices({ noCache: true })
            }}
            disabled={loading}
            className="rounded-control border border-ink-200 bg-surface px-3 py-1.5 text-sub text-ink-700 transition hover:bg-ink-50 disabled:opacity-50"
          >
            {loading || quotaLoading ? '刷新中…' : '刷新'}
          </button>
        }
      />

      {rentNotice && (
        <div className="mb-4 flex items-start gap-2 rounded-surface border border-state-ok/25 bg-state-ok/[0.06] px-4 py-2">
          <p className="min-w-0 flex-1 text-body text-state-ok">{rentNotice}</p>
          <button
            type="button"
            onClick={() => setRentNotice(null)}
            className="shrink-0 rounded px-1.5 py-0.5 text-sub text-state-ok hover:bg-state-ok/15"
          >
            知道了
          </button>
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-surface border border-state-bad/25 bg-state-bad/[0.06] px-4 py-3">
          <p className="selectable text-body font-medium text-state-bad">{error.message}</p>
          {error.hint && <p className="selectable mt-1 text-sub text-state-bad">→ {error.hint}</p>}
          {error.raw && (
            <pre className="selectable mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-surface/70 p-2 font-mono text-meta text-state-bad">
              {error.raw}
            </pre>
          )}
        </div>
      )}

      {inventory && (
        <div className="grid gap-5 normal:grid-cols-[minmax(0,1fr)_320px]">
          <div className="min-w-0">
            {inventory.gpuTypes.length > 0 ? (
              <GpuTypeGrid
                inventory={inventory}
                prices={prices}
                expandedType={expandedType}
                onToggleExpand={(type) => setExpandedType(expandedType === type ? null : type)}
                onRent={(type, gpus) => {
                  setRentNotice(null)
                  setRent({ type, gpus })
                }}
                onOpenJobs={(node) => setJobsNode({ name: node.name, cpuTotal: node.cpus })}
              />
            ) : (
              <Card title="没有检测到 GPU">
                <p className="text-emph leading-relaxed text-ink-600">
                  这个集群的节点上没有配置可用的 GPU（或者 GRES 配置为空）。CPU 节点仍然可用。
                </p>
              </Card>
            )}

            <div className="mt-5">
              <SectionTitle
                aside={
                  <label className="flex cursor-pointer items-center gap-1.5 text-sub text-ink-500">
                    <input
                      type="checkbox"
                      checked={showBlocked}
                      onChange={(event) => setShowBlocked(event.target.checked)}
                      className="h-3 w-3 accent-ink-700"
                    />
                    显示维护中的机器
                  </label>
                }
              >
                节点（{nodes.length}）
              </SectionTitle>

              <NodeTable
                nodes={nodes}
                blockedCount={inventory.blockedNodes.length}
                showBlocked={showBlocked}
              />

              <Hint>
                「部分空闲」表示这台机器上还有作业在跑，但仍有空着的显卡可以再提交。
                「卡空着但核满」是集群混部造成的：别人的 CPU 作业把核占光了，
                显卡虽然闲着也塞不进新作业——光看空闲卡数会误判。
                维护/故障的机器整台不计入上面的库存统计。
              </Hint>
            </div>
          </div>

          {/*
            右栏：配额 + 试算。这两块"常看但不常改"，放窄栏里滚到哪都在视野内。
            原来四段纵向平铺要滚三屏才答完"我能不能马上跑"。
          */}
          <div className="min-w-0 space-y-5">
            <div>
              <SectionTitle>存储配额</SectionTitle>

              {quotaError && (
                <div className="rounded-control border border-state-bad/25 bg-state-bad/[0.06] px-3 py-2.5">
                  <p className="selectable text-body font-medium text-state-bad">{quotaError.message}</p>
                  {quotaError.hint && (
                    <p className="selectable mt-1 text-sub text-state-bad">→ {quotaError.hint}</p>
                  )}
                </div>
              )}

              {quotas !== null && quotas.length === 0 && !quotaError && (
                <p className="text-body text-ink-500">这个账号没有设置配额限制。</p>
              )}

              {quotas !== null && quotas.length > 0 && (
                <div className="space-y-2">
                  {quotas.map((quota) => (
                    <QuotaCard key={`${quota.filesystem}-${quota.type}`} quota={quota} />
                  ))}
                </div>
              )}
            </div>

            {inventory.gpuTypes.length > 0 && (
              <div>
                <SectionTitle>费用试算</SectionTitle>
                <CostEstimator
                  gpuTypes={inventory.gpuTypes}
                  prices={prices}
                  priceError={priceError}
                  activeType={activeType}
                  onTypeChange={setCalcType}
                  gpus={calcGpus}
                  onGpusChange={setCalcGpus}
                  hours={calcHours}
                  onHoursChange={setCalcHours}
                />
              </div>
            )}
          </div>
        </div>
      )}

    {jobsNode && (
      <NodeJobsDialog
        nodeName={jobsNode.name}
        cpuTotal={jobsNode.cpuTotal}
        onClose={() => setJobsNode(null)}
      />
    )}

    {rent && (
      <SubmitJobDialog
        initialGpuType={rent.type}
        initialGpus={rent.gpus}
        unitCost={prices.get(rent.type)?.min ?? null}
        onClose={() => setRent(null)}
        onSubmitted={(jobId) => {
          setRent(null)
          setRentNotice(`已提交，作业号 ${jobId}（锁定了 ${rent.type}）`)
          void load()
        }}
      />
    )}
    </PageShell>
  )
}

/**
 * 机型卡片网格。
 *
 * 分两组：**能马上用的排前面**，没货的收进「暂时租不到」折叠区。
 * 之前是平铺，10 个型号里有 8 个没货，能用的被埋在最上面一堆灰卡片里。
 */
function GpuTypeGrid({
  inventory,
  prices,
  expandedType,
  onToggleExpand,
  onRent,
  onOpenJobs
}: {
  inventory: InventoryPayload
  prices: Map<string, PriceRange>
  expandedType: string | null
  onToggleExpand: (type: string) => void
  onRent: (type: string, gpus: number) => void
  onOpenJobs: (node: NodeInfo) => void
}): JSX.Element {
  const available = inventory.gpuTypes.filter((item) => item.free > 0)
  const exhausted = inventory.gpuTypes.filter((item) => item.free <= 0)

  const card = (item: InventoryPayload['gpuTypes'][number]): JSX.Element => (
    <GpuTypeCard
      key={item.type}
      item={item}
      price={prices.get(item.type)}
      nodes={inventory.usableNodes}
      expanded={expandedType === item.type}
      onToggleExpand={() => onToggleExpand(item.type)}
      onRent={() => onRent(item.type, 1)}
      onOpenJobs={onOpenJobs}
    />
  )

  return (
    <div>
      {available.length > 0 && (
        <div className="grid grid-cols-2 gap-2.5 normal:grid-cols-3">{available.map(card)}</div>
      )}

      {exhausted.length > 0 && (
        <div className={available.length > 0 ? 'mt-3' : ''}>
          <details open={available.length === 0}>
            <summary className="cursor-pointer select-none text-sub text-ink-500 hover:text-ink-700">
              暂时租不到的 {exhausted.length} 个型号（当前无空闲卡）
            </summary>
            <div className="mt-2 grid grid-cols-2 gap-2.5 opacity-70 normal:grid-cols-3">
              {exhausted.map(card)}
            </div>
          </details>
        </div>
      )}
    </div>
  )
}

/** 单个机型卡片：库存数、价格、可展开的机器明细 */
function GpuTypeCard({
  item,
  price,
  nodes,
  expanded,
  onToggleExpand,
  onRent,
  onOpenJobs
}: {
  item: InventoryPayload['gpuTypes'][number]
  price: PriceRange | undefined
  nodes: NodeInfo[]
  expanded: boolean
  onToggleExpand: () => void
  onRent: () => void
  onOpenJobs: (node: NodeInfo) => void
}): JSX.Element {
  const mine = nodes.filter((node) => node.gpus.some((g) => g.type === item.type))

  return (
    <div
      className={
        'rounded-surface border px-3.5 py-3 ' +
        (item.free > 0 ? 'border-state-ok/25 bg-surface shadow-card' : 'border-ink-200/70 bg-ink-50/40')
      }
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-emph font-semibold text-ink-800" title={item.type}>
          {item.label}
        </span>
        <span
          className={
            'shrink-0 font-mono text-emph font-semibold ' + (item.free > 0 ? 'text-state-ok' : 'text-ink-500')
          }
        >
          {item.free}
        </span>
      </div>

      <p className={'mt-1 text-sub font-medium ' + (price ? 'text-ink-700' : 'text-ink-500')}>
        {/* scir-watch 只列出「当前可租」的机器，它的判断比 scontrol 严
            （还要看核和内存），所以没报价 = 现在租不到，不是查不到价 */}
        {price ? formatPrice(price) : item.free > 0 ? '有卡但核/内存不够，暂不可租' : '当前无空闲，租不到'}
      </p>
      <p className="text-meta text-ink-500">
        空闲 {item.free} / 共 {item.total}　·　{item.nodeCount} 台
      </p>

      {/*
        比例条：上面两个数字已经是精确答案了，这条只提供"还剩多少"的体感。
        只用已注册的 `bg-state-ok` / `bg-ink-100`，不新造 token。
      */}
      {item.total > 0 && (
        <div
          className="mt-1.5 flex h-1.5 overflow-hidden rounded-full bg-ink-100"
          role="img"
          aria-label={`空闲比例 ${item.free} / ${item.total}`}
        >
          <div
            className="bg-state-ok transition-[width] duration-200"
            style={{ width: `${Math.round((item.free / item.total) * 100)}%` }}
          />
        </div>
      )}

      <button
        type="button"
        onClick={onToggleExpand}
        className="mt-1 text-meta text-state-info underline-offset-2 transition hover:underline"
      >
        {expanded ? '收起机器明细 ▲' : `看是哪 ${item.freeNodes.length} 台 ▼`}
      </button>

      {expanded && (
        <div className="mt-1 space-y-0.5 border-t border-ink-100 pt-1">
          {mine.map((node) => {
            /*
             * 格子与数字都从 `slotsOf` 推出来，只留一个真相来源。
             * 之前这里是 `total - used` 现算，和格子两套算法迟早会打架。
             */
            const slots = slotsOf(node, item.type)
            const total = slots.length
            const free = slots.filter((slot) => slot === 'free').length
            const coreFull = node.idleCpus <= 0
            const memLow = node.freeMemoryMb !== null && node.freeMemoryMb < 8000

            return (
              <div
                key={node.name}
                className="flex flex-wrap items-center gap-x-1.5 gap-y-1 font-mono text-meta tabular-nums"
              >
                <span className="w-11 shrink-0 text-ink-600">{node.name}</span>
                {/*
                  一格一张卡。整簇是一个按钮（点一下看谁在用），
                  单个格子只带 title —— 7px 的按钮太小，点不中会让人烦。
                */}
                {slots.length > 0 && (
                  <button
                    type="button"
                    onClick={() => onOpenJobs(node)}
                    title={`${node.name} · ${item.label} · 共 ${total} 张，空闲 ${free}`}
                    aria-label={`${node.name} 的 ${item.label} 共 ${total} 张，空闲 ${free} 张`}
                    className="flex shrink-0 items-center gap-[2px] rounded-[1px] py-[1px] transition hover:bg-ink-100"
                  >
                    {slots.map((slot, index) => (
                      <span
                        key={index}
                        className={slotClass(slot)}
                        title={`${node.name} · 第 ${index + 1} 张 · ${
                          slot === 'free' ? '空闲' : slot === 'used' ? '已占用' : '不可用'
                        }`}
                      />
                    ))}
                  </button>
                )}
                <span className={free > 0 ? 'text-state-ok' : 'text-ink-500'}>
                  {free}/{total}
                </span>
                <span className={coreFull ? 'text-state-wait' : 'text-ink-500'}>
                  核{node.idleCpus}/{node.cpus}
                </span>
                <span className={memLow ? 'text-state-wait' : 'text-ink-500'}>
                  {node.freeMemoryMb === null ? '—' : `${Math.round(node.freeMemoryMb / 1024)}G`}
                </span>
                {coreFull && free > 0 && <span className="text-state-wait">核满</span>}
                <button
                  type="button"
                  onClick={() => onOpenJobs(node)}
                  className="ml-auto shrink-0 rounded px-1 text-meta text-state-info transition hover:bg-ink-50"
                >
                  谁在用
                </button>
              </div>
            )
          })}
        </div>
      )}

      {item.free > 0 ? (
        <p className="mt-1 truncate font-mono text-meta text-ink-500" title={item.freeNodes.join(', ')}>
          {item.freeNodes.slice(0, 4).join(', ')}
          {item.freeNodes.length > 4 ? ` +${item.freeNodes.length - 4}` : ''}
        </p>
      ) : (
        <p className="mt-1 text-meta text-ink-300">暂时没有空闲</p>
      )}

      {/* 没货也能点：可以先填好参数排队等。文案区分开，免得用户以为点了会立刻跑起来 */}
      <button
        type="button"
        onClick={onRent}
        className={
          'mt-2 w-full rounded-control border px-2 py-1 text-sub font-medium transition ' +
          (item.free > 0
            ? 'border-ink-200 bg-surface text-ink-700 hover:border-ink-300 hover:bg-ink-50'
            : 'border-ink-100 bg-ink-50/60 text-ink-500 hover:bg-ink-100/60')
        }
      >
        {item.free > 0 ? '租这个 →' : '预填排队 →'}
      </button>
    </div>
  )
}

/** 节点表。抽出来是因为它和机型卡片是两种粒度，放在一起会读混 */
/**
 * 节点表的固定行高。
 *
 * 虚拟滚动**必须**有确定行高（见 VirtualList 的前提说明），所以这里把行高
 * 写成常量而不是靠内容撑开：行内全部是单行文本 + 小徽章，`py-2` + `text-body`
 * 实测正好 33px。留 1px 余量，改字号时不用同时改两个地方。
 */
const NODE_ROW_HEIGHT = 34

/** 节点表最多占这么高，超出就表内滚动。没有上限时 60 个节点会把页面拉成三屏 */
const NODE_TABLE_MAX_HEIGHT = 'min(52vh, 460px)'

function NodeTable({
  nodes,
  blockedCount,
  showBlocked
}: {
  nodes: NodeInfo[]
  blockedCount: number
  showBlocked: boolean
}): JSX.Element {
  const header = (
    <div className="flex h-8 items-center gap-3 border-b border-ink-100 px-4 text-meta uppercase tracking-wide text-ink-500">
      <span className="w-20 shrink-0">节点</span>
      <span className="w-24 shrink-0">状态</span>
      <span className="min-w-0 flex-1">显卡</span>
      <span className="w-24 shrink-0">空闲核心</span>
      <span className="w-20 shrink-0">空闲内存</span>
      <span className="w-16 shrink-0">分区</span>
    </div>
  )

  return (
    <div className="overflow-hidden rounded-surface border border-ink-200/80 bg-surface shadow-card">
      {header}

      {/*
        空表要有说法。以前这里只剩一个表头，看着像界面坏了。
        而且要分开说：是"全是维护中"还是"真的没查到"——前者用户能自己解决。
      */}
      {nodes.length === 0 && (
        <div className="px-4 py-6 text-center">
          {!showBlocked && blockedCount > 0 ? (
            <>
              <p className="text-body text-ink-600">
                现在没有可用的机器，{blockedCount} 台都在维护中（DRAIN / DOWN）。
              </p>
              <p className="mt-1 text-sub text-ink-500">
                勾选上面的「显示维护中的机器」可以看到它们，以及各自被标记的原因。
              </p>
            </>
          ) : (
            <>
              <p className="text-body text-ink-600">没有查到任何节点。</p>
              <p className="mt-1 text-sub leading-relaxed text-ink-500">
                <code className="font-mono">scontrol show node</code> 返回了空列表。
                可能是这个分区没给你的账号权限，或者集群当前的节点全都不可见。
              </p>
            </>
          )}
        </div>
      )}

      {/*
        虚拟滚动。原来这里是 `nodes.map(...)`——本集群 60 多台机器，每台还带
        若干显卡 <span>，一次铺下来接近 800 个 DOM 节点，而这页每 20 秒轮询刷新一次。
        实测切到资源页时会掉帧，改完只渲染可视区的十几行。

        `resetKey` 用节点数：刷新后数量变了（机器下线/恢复）要回到顶部重算，
        否则可能停在"总高度变短"之后的一片空白里。
      */}
      {nodes.length > 0 && (
        <VirtualList
          items={nodes}
          rowHeight={NODE_ROW_HEIGHT}
          resetKey={`${nodes.length}-${showBlocked ? 'b' : 'n'}`}
          className="overflow-y-auto"
          style={{ maxHeight: NODE_TABLE_MAX_HEIGHT }}
          renderRow={(node) => {
            const badge = nodeBadge(node)
            const gpuText =
              node.gpus.length > 0
                ? node.gpus
                    .map((item) => {
                      const used = node.gpusUsed.find((u) => u.type === item.type)?.count ?? 0
                      return `${Math.max(0, item.count - used)} / ${item.count}`
                    })
                    .join('　')
                : '—'

            return (
              <div
                className={
                  'flex h-full items-center gap-3 border-b border-ink-50 px-4 text-body ' +
                  (node.blocked ? 'opacity-55' : 'hover:bg-ink-50/40')
                }
              >
                <span className="w-20 shrink-0 truncate font-mono text-sub text-ink-700" title={node.name}>
                  {node.name}
                </span>

                <span className="w-24 shrink-0">
                  <span
                    className={`inline-flex rounded-control border px-1.5 py-0.5 text-meta font-medium ${badge.className}`}
                  >
                    {badge.label}
                  </span>
                </span>

                <span className="min-w-0 flex-1 truncate font-mono text-sub text-ink-600" title={gpuText}>
                  {gpuText}
                </span>

                <span className="w-24 shrink-0 font-mono text-sub text-ink-500">
                  {node.idleCpus} / {node.cpus}
                </span>

                <span className="w-20 shrink-0 font-mono text-sub text-ink-500">
                  {node.freeMemoryMb === null ? '—' : formatSize(node.freeMemoryMb * 1024 * 1024)}
                </span>

                <span className="w-16 shrink-0 truncate text-sub text-ink-500" title={node.partitions.join(', ')}>
                  {node.partitions.join(', ') || '—'}
                </span>
              </div>
            )
          }}
        />
      )}
    </div>
  )
}

/**
 * 费用试算。
 *
 * 竖排：右栏只有 320px，横向排会挤成两行。三项输入 + 一个大号结果，
 * 结果放最下面，因为它是"看"的，不是"填"的。
 */
function CostEstimator({
  gpuTypes,
  prices,
  priceError,
  activeType,
  onTypeChange,
  gpus,
  onGpusChange,
  hours,
  onHoursChange
}: {
  gpuTypes: InventoryPayload['gpuTypes']
  prices: Map<string, PriceRange>
  priceError: PlainError | null
  activeType: string
  onTypeChange: (type: string) => void
  gpus: number
  onGpusChange: (value: number) => void
  hours: number
  onHoursChange: (value: number) => void
}): JSX.Element {
  const selectedPrice = activeType ? prices.get(activeType) : undefined
  const estimate = estimateCost(selectedPrice?.min, gpus, hours)

  if (priceError) {
    return (
      <div className="rounded-surface border border-ink-200/80 bg-surface px-3.5 py-3">
        <p className="text-sub text-ink-500">拿不到价格信息（{priceError.message}），没法试算。</p>
      </div>
    )
  }

  const inputClass =
    'w-full rounded-control border border-ink-200 px-2 py-1.5 font-mono text-body text-ink-800 outline-none focus:border-state-info'

  return (
    <div className="rounded-surface border border-ink-200/80 bg-surface px-3.5 py-3 shadow-card">
      <label className="block">
        <span className="mb-1 block text-meta uppercase tracking-wide text-ink-500">型号</span>
        <select value={activeType} onChange={(event) => onTypeChange(event.target.value)} className={inputClass}>
          {gpuTypes.map((item) => (
            <option key={item.type} value={item.type}>
              {item.label}（空闲 {item.free}）
            </option>
          ))}
        </select>
      </label>

      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="block">
          <span className="mb-1 block text-meta uppercase tracking-wide text-ink-500">卡数</span>
          <input
            type="number"
            min={1}
            value={gpus}
            onChange={(event) => onGpusChange(Number(event.target.value))}
            className={inputClass}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-meta uppercase tracking-wide text-ink-500">小时</span>
          <input
            type="number"
            min={1}
            step={0.5}
            value={hours}
            onChange={(event) => onHoursChange(Number(event.target.value))}
            className={inputClass}
          />
        </label>
      </div>

      <div className="mt-3 border-t border-ink-100 pt-2.5">
        <span className="block text-meta uppercase tracking-wide text-ink-500">预计花费</span>
        <span className="font-mono text-page font-semibold leading-tight text-ink-900">
          {estimate ? `${formatPoints(estimate.total)} 点` : '—'}
        </span>
      </div>

      <p className="mt-1.5 text-meta leading-relaxed text-ink-500">
        {estimate
          ? `按 ${estimate.unitCost} 点/卡/小时 × ${estimate.gpus} 卡 × ${estimate.hours} 小时。${
              selectedPrice && selectedPrice.min !== selectedPrice.max ? '这个型号不同机器价格不同，这里按最低价算。' : ''
            }`
          : selectedPrice
            ? '选一个型号并填好卡数和小时才能算。'
            : '这个型号现在没有报价（通常是因为没有空闲卡可租）。'}
        不含折扣或阶梯价——集群怎么计费我们不知道，不做假设。
      </p>
    </div>
  )
}
