import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  buildSbatchArguments,
  buildSbatchScript,
  describeStartTime,
  type JobSpec
} from '../../../main/domain/sbatch'
import { estimateCost, formatPoints, priceByType } from '../lib/price'
import { RemoteDirPicker } from './RemoteDirPicker'

interface SubmitJobDialogProps {
  /** 表单初值可以带上来（比如从资源页点某个型号进来的） */
  initialGpus?: number
  initialPartition?: string
  /** 锁定显卡型号；null = 不限，调度器给什么用什么 */
  initialGpuType?: string | null
  /** 这个型号的单价（点/卡/小时）；null = 没有报价，不显示预估 */
  unitCost?: number | null
  onClose: () => void
  onSubmitted: (jobId: string) => void
}

/** 脚本文件名里的时间戳：20261103-0015 */
function stamp(): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

/**
 * 提交作业弹框。
 *
 * 三步：填参数 → **看脚本并随便改** → 选目录提交。
 *
 * 第二步是刻意的：不在后台偷偷拼参数直接交。用户得知道交上去的到底是什么，
 * 否则跑错分区、时限太短被砍，根本没法排查。
 */
export function SubmitJobDialog({
  initialGpus = 1,
  initialPartition = 'compute',
  initialGpuType = null,
  unitCost = null,
  onClose,
  onSubmitted
}: SubmitJobDialogProps): JSX.Element {
  const [step, setStep] = useState<'form' | 'preview'>('form')
  const [mode, setMode] = useState<'command' | 'script'>('command')

  // —— 表单 ——
  const [jobName, setJobName] = useState('train')
  const [partition, setPartition] = useState(initialPartition)
  const [nodes, setNodes] = useState(1)
  const [cpus, setCpus] = useState(4)
  const [gpus, setGpus] = useState(initialGpus)
  const [hours, setHours] = useState(2)
  /**
   * 默认命令故意选了一条**不需要任何文件**的。
   *
   * 原来填的是 `python train.py`，结果用户连着提交 6 次全失败——
   * 那个目录里根本没有 train.py，这是我编的占位符误导的。
   * 现在这条一定能跑通，用户要跑自己的代码就改掉它。
   */
  const [command, setCommand] = useState(`python -c "print('hello')"`)
  const [existingScript, setExistingScript] = useState<string | null>(null)
  const [envSetup, setEnvSetup] = useState('')
  const [gpuType, setGpuType] = useState<string | null>(initialGpuType)
  /**
   * 指定机器（`--nodelist`）。null = 让调度器挑。
   *
   * 换型号时必须清掉：gpu10 上是 V100，选成 A100 之后这个节点名就对不上了，
   * `--gres=gpu:a100:1 --nodelist=gpu10` 会永远排不上。
   */
  const [node, setNode] = useState<string | null>(null)
  /**
   * 是否显示全部型号。
   *
   * 从型号卡片点「租这个」进来时默认 **false**：用户已经选定了一种卡，
   * 再给他看 32GB / 40GB 的型号只是干扰。想换再点「显示全部」。
   * 从作业页手动打开（没有 initialGpuType）时默认 true。
   */
  const [showAllTypes, setShowAllTypes] = useState(initialGpuType === null)

  // —— 预览 / 提交 ——
  const [scriptText, setScriptText] = useState('')
  /**
   * 脚本所在目录，同时作为作业的工作目录。
   *
   * 这个是踩出来的：第一版只把脚本写到选的目录，没设 --chdir，
   * 结果作业在用户 home 下运行，`python train.py` 直接 exit 2，
   * 输出文件也落在 home 里，用户连日志都找不到。
   * 既然用户选了目录，就该在那个目录里跑。
   */
  const [targetDir, setTargetDir] = useState<string | null>(null)
  const [pickingDir, setPickingDir] = useState(false)
  const [pickingScript, setPickingScript] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [dryRun, setDryRun] = useState<DryRunResponse | null>(null)
  const [dryRunning, setDryRunning] = useState(false)

  /** 可选型号（带库存和单价），从资源页那份数据来 */
  const [gpuOptions, setGpuOptions] = useState<
    Array<{ type: string; label: string; free: number; unitCost: number | null }>
  >([])
  /**
   * 完整的节点库存。选型号时要用它算「这个型号下有几台机器真能放下当前作业」——
   * 只看型号汇总的"空闲 10 张"是不够的，那 10 张可能分散在核已经占满的机器上。
   */
  const [inventory, setInventory] = useState<InventoryPayload | null>(null)
  /** 型号 → 预计启动时间的描述 */
  const [estimates, setEstimates] = useState<Record<string, string>>({})
  const [comparing, setComparing] = useState(false)
  const [error, setError] = useState<PlainError | null>(null)

  // 型号列表：Dialog 自己拉，这样从资源页进来和从作业页进来都能选型号
  useEffect(() => {
    void (async () => {
      try {
        const [nodeRes, priceRes] = await Promise.all([window.hpc.listNodes(), window.hpc.getPrices()])
        if (!nodeRes.ok || !nodeRes.inventory) return

        setInventory(nodeRes.inventory)
        const priceMap = priceByType(priceRes.ok ? (priceRes.prices ?? []) : [])
        setGpuOptions(
          nodeRes.inventory.gpuTypes.map((item) => ({
            type: item.type,
            label: item.label,
            free: item.free,
            unitCost: priceMap.get(item.type)?.min ?? null
          }))
        )
      } catch {
        // 拿不到型号列表就只留「任意型号」这一项，不影响提交
      }
    })()
  }, [])

  /**
   * 换型号就把"指定机器"清掉。
   *
   * 节点名和型号是绑死的：gpu10 上是 V100，用户改成 A100 之后
   * `--gres=gpu:a100:1 --nodelist=gpu10` 永远排不上，比不选型号还糟。
   */
  useEffect(() => {
    setNode(null)
  }, [gpuType])

  const spec: JobSpec = useMemo(
    () => ({
      jobName,
      partition,
      nodes,
      tasksPerNode: 1,
      cpusPerTask: cpus,
      gpusPerNode: gpus,
      gpuType,
      node,
      timeLimitMinutes: Math.max(1, Math.round(hours * 60)),
      outputPattern: '%x-%j.out',
      command,
      envSetup,
      workDir: targetDir
    }),
    [jobName, partition, nodes, cpus, gpus, gpuType, node, hours, command, envSetup, targetDir]
  )

  /**
   * 当前规格（要几张卡、几个核）能放下的机器。
   *
   * 为什么要算这个：型号汇总里的"空闲 10 张"是整型的数字，
   * 但实际可能分散在核已占满的机器上，选了半天排不上。
   * 这里逐台检查：这台机器的该型号卡够不够、空闲核够不够。
   */
  const feasibleNodesOf = (type: string): NodeInfo[] =>
    (inventory?.usableNodes ?? []).filter((node) => {
      const total = node.gpus.find((g) => g.type === type)?.count ?? 0
      const used = node.gpusUsed.find((g) => g.type === type)?.count ?? 0
      return total - used >= gpus && node.idleCpus >= cpus
    })

  /**
   * 某个型号下的**全部**机器（不只放得下的），带每台的余量。
   *
   * 为什么不只列放得下的：用户可能就想要 gpu11——它现在核满了，
   * 但半小时后别人的作业一结束就能跑。把"核不够"标出来让他自己判断，
   * 比直接藏起来好。状态色和资源页的机器明细保持一致。
   */
  const machinesOf = (type: string): Array<{
    name: string
    gpuFree: number
    gpuTotal: number
    idleCpus: number
    cpus: number
    freeMemoryMb: number | null
    fits: boolean
  }> =>
    (inventory?.usableNodes ?? [])
      .filter((node) => node.gpus.some((g) => g.type === type))
      .map((node) => {
        const gpuTotal = node.gpus.find((g) => g.type === type)?.count ?? 0
        const gpuUsed = node.gpusUsed.find((g) => g.type === type)?.count ?? 0
        const gpuFree = Math.max(0, gpuTotal - gpuUsed)
        return {
          name: node.name,
          gpuFree,
          gpuTotal,
          idleCpus: node.idleCpus,
          cpus: node.cpus,
          freeMemoryMb: node.freeMemoryMb,
          fits: gpuFree >= gpus && node.idleCpus >= cpus
        }
      })

  const visibleOptions = gpuOptions.filter((option) => feasibleNodesOf(option.type).length > 0)
  /** 一台都放不下时退回显示全部，否则列表会空掉、用户以为坏了 */
  const noFeasible = visibleOptions.length === 0 && gpuOptions.length > 0
  const shownOptions = noFeasible ? gpuOptions : visibleOptions

  // 锁定了型号就只显示那一个（哪怕它当前放不下，也要显示出来并标注状态）
  const lockedOption = initialGpuType ? gpuOptions.find((option) => option.type === initialGpuType) : undefined
  const listOptions = showAllTypes ? shownOptions : lockedOption ? [lockedOption] : shownOptions

  const totalGpus = nodes * gpus
  // 单价跟着选中的型号走：在表单里换了型号，预估点数要跟着变
  const activeUnitCost = gpuType
    ? (gpuOptions.find((option) => option.type === gpuType)?.unitCost ?? null)
    : unitCost
  const estimate = estimateCost(activeUnitCost, totalGpus, hours)

  /**
   * 「下一步」：命令模式先选目录（因为要写进 --chdir），再生成脚本。
   * 脚本模式不用选——工作目录就是脚本所在目录。
   */
  const goPreview = useCallback((): void => {
    if (mode === 'script') {
      const dir = existingScript ? existingScript.slice(0, existingScript.lastIndexOf('/')) : null
      setTargetDir(dir || null)
      setStep('preview')
      return
    }
    setPickingDir(true)
  }, [mode, existingScript])

  /** 选完目录后生成脚本（此时 --chdir 已经是真实路径） */
  const preparePreview = useCallback((dir: string): void => {
    setTargetDir(dir)
    setScriptText(buildSbatchScript({ ...spec, workDir: dir }))
    setPickingDir(false)
    setStep('preview')
  }, [spec])

  /** 预估什么时候能跑：--test-only 只做资源检查，不占资源 */
  const runDryRun = useCallback(async (): Promise<void> => {
    setDryRunning(true)
    setDryRun(null)
    try {
      const response = await window.hpc.dryRunJob({
        mode,
        scriptPath: mode === 'script' ? (existingScript ?? '') : `${targetDir ?? '/tmp'}/.dryrun.sbatch`,
        content: mode === 'command' ? scriptText : undefined,
        args: buildSbatchArguments(spec)
      })
      setDryRun(response)
    } catch (err) {
      setDryRun({ ok: false, error: { kind: 'ipc', message: '预估请求失败', raw: String(err) } })
    } finally {
      setDryRunning(false)
    }
  }, [mode, existingScript, targetDir, scriptText, spec])

  /**
   * 批量对比各型号的预计启动时间。
   *
   * 为什么要做这个：**能不能马上跑，比型号本身更影响选择**。
   * 如果 A100 要等 16 小时、V100 现在就能跑，用户应该看得到再决定。
   *
   * 每个型号要单独跑一次 `--test-only`（因为 --gres 不同），
   * 并发限 3，避免一次对集群打十来个请求。
   */
  const compareStarts = useCallback(async (): Promise<void> => {
    if (gpuOptions.length === 0) return
    setComparing(true)
    setEstimates({})

    const collected: Record<string, string> = {}
    const queue = [...gpuOptions]

    const runOne = async (option: (typeof gpuOptions)[number]): Promise<void> => {
      // 对比型号必须清掉 node：节点是绑定某个型号的，带过去会永远排不上
      const variant = { ...spec, gpuType: option.type, node: null, workDir: targetDir }
      try {
        const response = await window.hpc.dryRunJob({
          mode: 'command',
          scriptPath: `${targetDir ?? '/tmp'}/.dryrun.sbatch`,
          content: buildSbatchScript(variant),
          args: buildSbatchArguments(variant)
        })
        collected[option.type] =
          response.ok && response.startAt ? describeStartTime(response.startAt) : '排不出来'
      } catch {
        collected[option.type] = '查询失败'
      }
      // 每完成一个就刷新，用户能看到结果一个个冒出来
      setEstimates({ ...collected })
    }

    const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
      for (;;) {
        const next = queue.shift()
        if (!next) return
        await runOne(next)
      }
    })

    try {
      await Promise.all(workers)
    } finally {
      setComparing(false)
    }
  }, [gpuOptions, spec, targetDir])

  const doSubmit = useCallback(
    async (): Promise<void> => {
      setSubmitting(true)
      setError(null)
      try {
        const scriptPath =
          mode === 'script'
            ? (existingScript ?? '')
            : `${targetDir ?? '/'}${targetDir?.endsWith('/') ? '' : '/'}${jobName}-${stamp()}.sbatch`

        const response = await window.hpc.submitJob({
          mode,
          scriptPath,
          content: mode === 'command' ? scriptText : undefined,
          args: buildSbatchArguments(spec)
        })

        if (response.ok && response.jobId) {
          onSubmitted(response.jobId)
          return
        }
        setError(response.error ?? { kind: 'ipc', message: '提交失败', raw: JSON.stringify(response) })
      } catch (err) {
        setError({ kind: 'ipc', message: '提交请求失败', raw: String(err) })
      } finally {
        setSubmitting(false)
        setPickingDir(false)
      }
    },
    [mode, existingScript, jobName, scriptText, spec, targetDir, onSubmitted]
  )

  if (pickingScript) {
    return (
      <RemoteDirPicker
        title="选一个已有的 .sh 脚本"
        mode="file"
        filter={(name) => name.endsWith('.sh') || name.endsWith('.sbatch') || name.endsWith('.slurm')}
        onCancel={() => setPickingScript(false)}
        onPick={(file) => {
          setExistingScript(file)
          setPickingScript(false)
        }}
      />
    )
  }

  if (pickingDir) {
    return (
      <RemoteDirPicker
        title="脚本存到哪个目录（作业也会在这个目录下运行）"
        onCancel={() => setPickingDir(false)}
        onPick={preparePreview}
      />
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-inverse/25 px-6"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose()
      }}
    >
      <div className="flex max-h-[86vh] w-full max-w-[620px] flex-col overflow-hidden rounded-surface border border-ink-200 bg-surface shadow-pop">
        <header className="relative shrink-0 border-b border-ink-100 px-5 py-3 pr-12">
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="absolute right-3 top-3 grid h-6 w-6 place-items-center rounded text-ink-500 transition hover:bg-ink-100 hover:text-ink-700"
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
          <h2 className="text-emph font-semibold text-ink-900">
            {step === 'form' ? '提交作业' : '确认脚本'}
          </h2>
          <p className="mt-0.5 text-sub text-ink-500">
            {step === 'form'
              ? '填完点「看脚本」，下一步能看到并修改完整内容'
              : '这是要交上去的脚本，可以直接改。确认无误再选目录提交。'}
          </p>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {step === 'form' ? (
            <div className="space-y-3">
              <div className="flex gap-1 rounded-surface bg-ink-100/70 p-0.5">
                {(
                  [
                    { id: 'command' as const, label: '写命令' },
                    { id: 'script' as const, label: '用已有脚本' }
                  ]
                ).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setMode(item.id)}
                    className={
                      'flex-1 rounded-control px-3 py-1 text-body transition ' +
                      (mode === item.id ? 'bg-surface font-medium text-ink-900 shadow-card' : 'text-ink-500')
                    }
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="作业名">
                  <input
                    value={jobName}
                    onChange={(event) => setJobName(event.target.value)}
                    className="w-full rounded-surface border border-ink-200 px-2.5 py-1.5 text-body outline-none focus:border-state-info"
                  />
                </Field>
                <Field label="分区">
                  <input
                    value={partition}
                    onChange={(event) => setPartition(event.target.value)}
                    className="w-full rounded-surface border border-ink-200 px-2.5 py-1.5 text-body outline-none focus:border-state-info"
                  />
                </Field>
              </div>

              <div className="grid grid-cols-4 gap-3">
                <Field label="节点数">
                  <input
                    type="number"
                    min={1}
                    value={nodes}
                    onChange={(event) => setNodes(Number(event.target.value))}
                    className="w-full rounded-surface border border-ink-200 px-2.5 py-1.5 text-body outline-none focus:border-state-info"
                  />
                </Field>
                <Field label="每节点核数">
                  <input
                    type="number"
                    min={1}
                    value={cpus}
                    onChange={(event) => setCpus(Number(event.target.value))}
                    className="w-full rounded-surface border border-ink-200 px-2.5 py-1.5 text-body outline-none focus:border-state-info"
                  />
                </Field>
                <Field label="每节点卡数">
                  <input
                    type="number"
                    min={0}
                    value={gpus}
                    onChange={(event) => setGpus(Number(event.target.value))}
                    className="w-full rounded-surface border border-ink-200 px-2.5 py-1.5 text-body outline-none focus:border-state-info"
                  />
                </Field>
                <Field label="时限（小时）">
                  <input
                    type="number"
                    min={0.1}
                    step={0.1}
                    value={hours}
                    onChange={(event) => setHours(Number(event.target.value))}
                    className="w-full rounded-surface border border-ink-200 px-2.5 py-1.5 text-body outline-none focus:border-state-info"
                  />
                </Field>
              </div>

              <p className="text-sub text-ink-500">
                总共申请 <span className="font-mono text-ink-600">{totalGpus}</span> 张卡（{nodes} 节点 × {gpus} 卡/节点）。
                SLURM 的 <code className="font-mono">--gres</code> 是每节点语义。
              </p>

              {/* 有单价才显示预估；从作业页手动打开时没有单价，不硬编一个数 */}
              {estimate ? (
                <div className="flex items-baseline justify-between rounded-surface border border-state-info/25 bg-state-info/[0.05] px-3 py-2">
                  <span className="text-sub text-state-info">
                    预计消耗 {formatPoints(estimate.total)} 点
                    <span className="ml-1.5 text-state-info">
                      （{estimate.unitCost} 点/卡/小时 × {estimate.gpus} 卡 × {estimate.hours} 小时）
                    </span>
                  </span>
                </div>
              ) : (
                gpus > 0 && (
                  <p className="text-sub text-ink-500">
                    这个型号没有报价，估算不出点数。
                  </p>
                )
              )}

              {/* 本集群的配比限制：每卡最多 4 核。超了 sbatch 会直接拒，
                  在这里先提醒比等报错好——但只提醒不阻止，别的集群规则可能不一样 */}
              {gpus > 0 && cpus > gpus * 4 && (
                <p className="rounded-surface border border-state-wait/25 bg-state-wait/[0.06] px-3 py-1.5 text-sub leading-relaxed text-state-wait">
                  {gpus} 张卡配 {cpus} 个核，可能超过配比限制（本集群是每卡最多 4 核）。
                  建议把核数降到 {gpus * 4} 以内，或者把卡数加到 {Math.ceil(cpus / 4)} 张。
                </p>
              )}

              <Field label="显卡型号">
                {gpus === 0 && (
                  <p className="mb-1 text-meta text-ink-500">不申请显卡，型号无关紧要，保持「任意型号」就行。</p>
                )}

                {initialGpuType && (
                  <div className="mb-1 flex items-center justify-between text-meta">
                    <span className="text-ink-500">
                      {showAllTypes ? '正在显示全部型号' : '只看你点的那一种卡'}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setShowAllTypes((current) => !current)
                        if (showAllTypes) setGpuType(initialGpuType)
                      }}
                      className="rounded px-1.5 py-0.5 text-state-info transition hover:bg-state-info/[0.05]"
                    >
                      {showAllTypes ? '只看这个型号' : '换成别的型号'}
                    </button>
                  </div>
                )}

                {noFeasible && (
                  <p className="mb-1 rounded border border-state-wait/25 bg-state-wait/[0.06] px-2 py-1 text-meta leading-relaxed text-state-wait">
                    按现在的规格（{gpus} 卡、{cpus} 核），暂时没有机器能立刻放下。
                    下面列出全部型号，选了会排队等。
                  </p>
                )}

                <div className="space-y-1">
                  <button
                    type="button"
                    onClick={() => setGpuType(null)}
                    className={
                      'flex w-full items-center gap-2 rounded-surface border px-2.5 py-1.5 text-left text-body transition ' +
                      (gpuType === null
                        ? 'border-state-info/70 bg-state-info/[0.05] text-ink-900'
                        : 'border-ink-200 bg-surface text-ink-600 hover:bg-ink-50')
                    }
                  >
                    <span className="min-w-0 flex-1">任意型号</span>
                    <span className={'shrink-0 text-sub ' + (gpus > 0 ? 'text-state-wait' : 'text-ink-500')}>
                      {gpus > 0 ? '本集群要求写明型号' : '调度器有什么给什么'}
                    </span>
                  </button>

                  {listOptions.map((option) => {
                    const active = gpuType === option.type
                    const feasible = feasibleNodesOf(option.type).length
                    return (
                      <button
                        key={option.type}
                        type="button"
                        onClick={() => setGpuType(option.type)}
                        className={
                          'flex w-full items-center gap-2 rounded-surface border px-2.5 py-1.5 text-left text-body transition ' +
                          (active
                            ? 'border-state-info/70 bg-state-info/[0.05] text-ink-900'
                            : 'border-ink-200 bg-surface text-ink-700 hover:bg-ink-50')
                        }
                      >
                        <span className="w-3.5 shrink-0 text-state-info">{active ? '●' : ''}</span>
                        <span className="min-w-0 flex-1 truncate">{option.label}</span>
                        <span
                          className={`shrink-0 font-mono text-meta ${feasible > 0 ? 'text-state-ok' : 'text-ink-500'}`}
                          title={`这个型号共有 ${option.free} 张空闲卡，其中 ${feasible} 台机器放得下当前规格（${gpus} 卡 ${cpus} 核）`}
                        >
                          {feasible > 0 ? `可放 ${feasible} 台` : `空闲 ${option.free}`}
                        </span>
                        <span className="w-16 shrink-0 text-right text-meta text-ink-500">
                          {option.unitCost !== null ? `${option.unitCost} 点/时` : '无报价'}
                        </span>
                        {/* 对比过才显示，没对比留空，不占宽度 */}
                        <span className="w-40 shrink-0 text-right text-meta text-state-info">
                          {estimates[option.type] ?? ''}
                        </span>
                      </button>
                    )
                  })}
                </div>

                {/*
                  库存读不到时，型号列表只剩「任意型号」，没有任何解释——用户会以为是加载慢。
                  要把"为什么列不出来"和"能不能照样提交"说清楚。
                */}
                {gpuOptions.length === 0 && (
                  <p className="mt-1.5 rounded-surface border border-ink-200 bg-ink-50/70 px-3 py-1.5 text-sub leading-relaxed text-ink-600">
                    没有读到可选的显卡型号：可能是节点库存为空，或者这个集群没有 GPU 节点。
                    {gpus > 0
                      ? ' 现在申请显卡的话没法选型号，提交大概率会被拒——先去「资源」页看看库存，或者临时把卡数改成 0 换纯 CPU 作业。'
                      : ' 申请 0 张卡的话不受影响，可以直接提交。'}
                  </p>
                )}

                {/*
                  实测结论：本集群的 scir 扩展要求 --gres 必须带型号，
                  `--gres=gpu:1` 会被直接拒（tres format not match）。
                  只提醒不拦——别的集群允许不写型号，写死就不好移植了。
                */}
                {gpus > 0 && gpuType === null && (
                  <p className="mt-1.5 rounded-surface border border-state-wait/25 bg-state-wait/[0.06] px-3 py-1.5 text-sub leading-relaxed text-state-wait">
                    本集群要求写明型号：不选型号会生成 <code className="font-mono text-sub">--gres=gpu:{gpus}</code>，
                    sbatch 会以 <code className="font-mono text-sub">tres format not match</code> 拒绝。挑一个具体型号再提交。
                  </p>
                )}

                {Object.keys(estimates).length > 0 && (
                  <p className="mt-1.5 text-meta leading-relaxed text-ink-500">
                    排队久的常见原因是<strong className="font-medium text-ink-500">优先级不够</strong>
                    ——你申请的资源是空的，但队列里还有别人优先级更高的作业在等，
                    调度器要先把它们排上。不是没有卡，也不是程序算错了。
                    想快点跑就选排队短的那个型号。
                  </p>
                )}

                {gpuOptions.length > 0 && (
                  <div className="mt-1.5 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void compareStarts()}
                      disabled={comparing}
                      className="rounded border border-ink-200 px-2 py-0.5 text-sub text-ink-600 transition hover:bg-ink-50 disabled:opacity-50"
                    >
                      {comparing ? '逐个查询中…' : '对比各型号预计启动时间'}
                    </button>
                    <span className="text-meta text-ink-500">
                      每种型号单独问一次集群，约 0.1 秒
                    </span>
                  </div>
                )}
              </Field>

              {/*
                指定机器。

                为什么需要：同一个型号下几台机器的余量差别很大——资源页「机器明细」里
                就能看到 gpu10 卡8/核 30/48、gpu11 卡6/核 2/48，后者卡虽多但核已经满了，
                交上去大概率一直排队。让用户直接钉死一台，比在"可放 2 台"这种汇总数字上猜更靠谱。

                只有在选了具体型号后才出现：不选型号时机器是哪个型号的都不一定，
                指定机器没有意义（也可能是别的型号的机器，--gres 会对不上）。
              */}
              {gpuType !== null && (
                <Field label="指定机器">
                  <div className="space-y-1">
                    <button
                      type="button"
                      onClick={() => setNode(null)}
                      className={
                        'flex w-full items-center gap-2 rounded-surface border px-2.5 py-1.5 text-left text-body transition ' +
                        (node === null
                          ? 'border-state-info/70 bg-state-info/[0.05] text-ink-900'
                          : 'border-ink-200 bg-surface text-ink-600 hover:bg-ink-50')
                      }
                    >
                      <span className="w-3.5 shrink-0 text-state-info">{node === null ? '●' : ''}</span>
                      <span className="min-w-0 flex-1">不指定</span>
                      <span className="shrink-0 text-sub text-ink-500">调度器在放得下的机器里挑一台</span>
                    </button>

                    {machinesOf(gpuType).map((machine) => {
                      const active = node === machine.name
                      return (
                        <button
                          key={machine.name}
                          type="button"
                          onClick={() => setNode(machine.name)}
                          className={
                            'flex w-full items-center gap-2 rounded-surface border px-2.5 py-1.5 text-left font-mono text-sub transition ' +
                            (active
                              ? 'border-state-info/70 bg-state-info/[0.05] text-ink-900'
                              : 'border-ink-200 bg-surface text-ink-700 hover:bg-ink-50')
                          }
                          title={`${machine.name}：${gpuType} 剩 ${machine.gpuFree}/${machine.gpuTotal} 张，空闲核 ${machine.idleCpus}/${machine.cpus}`}
                        >
                          <span className="w-3.5 shrink-0 text-state-info">{active ? '●' : ''}</span>
                          <span className="w-12 shrink-0">{machine.name}</span>
                          <span className={machine.gpuFree > 0 ? 'text-state-ok' : 'text-ink-500'}>
                            卡{machine.gpuFree}
                          </span>
                          <span className={machine.idleCpus <= 0 ? 'text-state-wait' : 'text-ink-500'}>
                            核{machine.idleCpus}/{machine.cpus}
                          </span>
                          <span className="text-ink-500">
                            {machine.freeMemoryMb === null ? '—' : `${Math.round(machine.freeMemoryMb / 1024)}G`}
                          </span>
                          {/* 核满但还有卡：这是本集群混部造成的，最容易让人以为"有货却排不上" */}
                          {machine.fits ? (
                            <span className="ml-auto shrink-0 text-meta text-state-ok">放得下</span>
                          ) : (
                            <span className="ml-auto shrink-0 text-meta text-state-wait">
                              {machine.idleCpus < cpus ? '核不够' : '卡不够'}
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                  <p className="mt-1 text-meta leading-relaxed text-ink-500">
                    钉死一台的话，只是把排队范围缩小到这台机器上——它什么时候空出资源就什么时候跑。
                    想让调度器帮你找最快的，选「不指定」。
                  </p>
                </Field>
              )}

              {mode === 'command' ? (
                <Field label="要执行的命令">
                  <textarea
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                    rows={3}
                    className="w-full resize-y rounded-surface border border-ink-200 px-2.5 py-1.5 font-mono text-body outline-none focus:border-state-info"
                  />
                  <p className="mt-1 text-meta leading-relaxed text-ink-500">
                    默认这条不需要任何文件，可以直接交来验证链路通不通。
                    要跑自己的代码就改成 <code className="font-mono">python train.py</code> 之类——
                    <strong className="font-medium text-ink-500">先确认那个文件在上一步选的目录里存在</strong>，
                    否则作业会以「No such file」秒退。
                  </p>
                </Field>
              ) : (
                <Field label="已有脚本">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-sub text-ink-600">
                      {existingScript ?? '还没有选'}
                    </span>
                    <button
                      type="button"
                      onClick={() => setPickingScript(true)}
                      className="shrink-0 rounded border border-ink-200 px-2 py-0.5 text-sub text-ink-700 hover:bg-ink-50"
                    >
                      浏览…
                    </button>
                  </div>
                </Field>
              )}

              <Field label="环境准备">
                <textarea
                  value={envSetup}
                  onChange={(event) => setEnvSetup(event.target.value)}
                  rows={2}
                  placeholder={'module load cuda/12.1\nconda activate myenv'}
                  className="w-full resize-y rounded-surface border border-ink-200 px-2.5 py-1.5 font-mono text-sub outline-none focus:border-state-info"
                />
              </Field>
              <p className="-mt-2 text-sub text-ink-500">
                留空的话，脚本里会放注释掉的占位，你在下一步改。
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {/* /tmp 在集群上通常是每节点本地的，作业跑起来找不到脚本 */}
              {targetDir && /^\/tmp(\/|$)|^\/var\/tmp(\/|$)/.test(targetDir) && (
                <div className="rounded-surface border border-state-wait/25 bg-state-wait/[0.06] px-3 py-2">
                  <p className="text-sub leading-relaxed text-state-wait">
                    <strong className="font-medium">这个目录在工作节点上可能不存在。</strong>
                    <span className="font-mono">{targetDir}</span> 在 /tmp 下面，
                    而集群的 /tmp 通常是<strong className="font-medium">每台机器各自的</strong>，
                    不跨节点共享——作业跑起来会找不到脚本，日志也可能找不着。
                    换到 home 或项目目录下更稳妥。
                  </p>
                </div>
              )}

              <textarea
                value={mode === 'command' ? scriptText : `sbatch 参数：\n${buildSbatchArguments(spec).join('\n')}\n\n脚本：${existingScript ?? ''}`}
                onChange={(event) => setScriptText(event.target.value)}
                readOnly={mode === 'script'}
                rows={18}
                spellCheck={false}
                className="w-full resize-y rounded-surface border border-ink-200 bg-ink-50/40 px-3 py-2 font-mono text-sub leading-relaxed text-ink-800 outline-none focus:border-state-info read-only:text-ink-500"
              />
              {mode === 'command' && (
                <p className="text-sub text-ink-500">
                  改完直接提交，提交的是上面这份内容。文件名会是 <span className="font-mono">{jobName}-时间戳.sbatch</span>，
                  存在 <span className="font-mono">{targetDir ?? '?'}</span>，作业也在那个目录下运行。
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => void runDryRun()}
                  disabled={dryRunning}
                  className="rounded-surface border border-ink-200 bg-surface px-2.5 py-1 text-sub text-ink-700 transition hover:bg-ink-50 disabled:opacity-50"
                >
                  {dryRunning ? '估算中…' : '预估什么时候能跑'}
                </button>

                {dryRun?.ok && dryRun.startAt && (
                  <span className="text-sub text-state-ok">
                    预计 {describeStartTime(dryRun.startAt)} 启动
                    {dryRun.nodes ? `　·　${dryRun.nodes}` : ''}
                  </span>
                )}
                {dryRun?.ok && !dryRun.startAt && (
                  <span className="text-sub text-ink-500">集群没给出排程预测（可能资源排不开）</span>
                )}
                {dryRun && !dryRun.ok && (
                  <span className="text-sub text-state-bad">
                    {dryRun.error?.hint ?? dryRun.error?.message}
                    {dryRun.error?.raw && (
                      <span className="ml-1 font-mono text-meta text-state-bad">
                        （{dryRun.error.raw.slice(0, 120)}）
                      </span>
                    )}
                  </span>
                )}
              </div>

              {dryRun?.ok && dryRun.startAt && (
                <p className="text-meta leading-relaxed text-ink-500">
                  这是集群按当前排队情况给的最佳猜测，不是承诺。它也不检查集群的配比/配额限制，
                  所以估得出时间不代表一定交得上。
                </p>
              )}
            </div>
          )}

          {error && (
            <div className="mt-3 rounded-surface border border-state-bad/25 bg-state-bad/[0.06] px-3 py-2">
              <p className="selectable text-body font-medium text-state-bad">{error.message}</p>
              {error.hint && <p className="selectable mt-1 text-sub text-state-bad">→ {error.hint}</p>}
              {error.raw && (
                <pre className="selectable mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-surface/70 p-2 font-mono text-meta text-state-bad">
                  {error.raw}
                </pre>
              )}
            </div>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-ink-100 bg-ink-50/40 px-5 py-3">
          <button
            type="button"
            onClick={() => (step === 'form' ? onClose() : setStep('form'))}
            className="rounded-surface border border-ink-200 bg-surface px-3 py-1.5 text-body text-ink-700 transition hover:bg-ink-50"
          >
            {step === 'form' ? '取消' : '← 改参数'}
          </button>

          {step === 'form' ? (
            <button
              type="button"
              onClick={goPreview}
              disabled={mode === 'script' && !existingScript}
              className="rounded-surface bg-inverse px-4 py-1.5 text-body font-medium text-white transition hover:bg-ink-800 disabled:bg-ink-300"
            >
              {mode === 'script' ? '看脚本 →' : '选目录 →'}
            </button>
          ) : (
            <button
              type="button"
              disabled={submitting}
              onClick={() => void doSubmit()}
              className="rounded-surface bg-inverse px-4 py-1.5 text-body font-medium text-white transition hover:bg-ink-800 disabled:bg-ink-300"
            >
              {submitting ? '提交中…' : '提交作业'}
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-sub uppercase tracking-wide text-ink-500">{label}</span>
      {children}
    </label>
  )
}
