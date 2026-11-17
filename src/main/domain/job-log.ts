/**
 * 定位作业的输出文件。
 *
 * 抽成独立模块是为了能单测：这段逻辑有三条路径（scontrol 精确值 / 文件不存在 /
 * sacct 命名约定兜底），塞在 IPC handler 里只能靠真机试。
 *
 * ## 为什么不能只猜文件名
 *
 * 最早的实现是拿 `sacct` 的 `working_directory` 再试
 * `<名>-<号>.out` / `<名>.out` / `slurm-<号>.out`。这对**本应用提交的作业**
 * 和 **SLURM 默认命名**有效，但凡是自己写了 `--output` 的作业一律猜不中：
 * 实测别人的作业输出叫 `demo-train-203815.log`——**`.log` 不是 `.out`**。
 *
 * 而且 `sacct` 只记已经结束的作业，运行中的作业连工作目录都拿不到，
 * 等于"作业还在跑的时候看不了日志"，而这恰恰是最需要看的时候。
 *
 * 所以顺序是：
 *
 * 1. `scontrol show job <id> --json` 的 `standard_output`——**精确路径**，
 *    运行中 / 排队中 / 刚结束的作业都能拿到。
 * 2. 作业已从控制器清理（`MinJobAge`，默认结束后 5 分钟）时才退回
 *    `sacct` 的 `working_directory` + 命名约定，一次 shell 循环问完所有候选。
 */
import { parseScontrolJob, scontrolJobCommand } from '../adapters/scontrol-job'
import { shq } from '../ssh/shell'

/** 只需要 exec，不需要整个 Session——这样测试可以传假实现 */
export interface ShellRunner {
  exec(command: string): Promise<{ stdout: string; code: number | null; stderr: string }>
}

export interface LogPathHints {
  jobName?: string | null
  workDir?: string | null
}

export interface ResolvedLog {
  path: string
  source: 'scontrol' | 'sacct'
  /** 文件**此刻**在不在。不在时流式跟随仍可启动（`tail -F` 会等它出现） */
  exists: boolean
}

export interface LogPathFailure {
  tried: string[]
  reason: string
  hint: string
  raw: string
}

export type LogPathResult = { ok: true; data: ResolvedLog } | ({ ok: false } & LogPathFailure)

/** sacct 兜底时试的命名。`.out` 和 `.log` 都要有——真实集群上两种都见过 */
export function candidateLogPaths(workDir: string, jobName: string, jobId: string): string[] {
  const dir = workDir.replace(/\/+$/, '')
  return [
    `${dir}/${jobName}-${jobId}.out`,
    `${dir}/${jobName}.out`,
    `${dir}/slurm-${jobId}.out`,
    `${dir}/${jobName}-${jobId}.log`,
    `${dir}/${jobName}.log`,
    `${dir}/slurm-${jobId}.log`
  ]
}

export async function resolveJobLogPath(
  run: ShellRunner,
  jobId: string,
  hints: LogPathHints
): Promise<LogPathResult> {
  const tried: string[] = []

  // —— 第一步：问 scontrol 要精确路径 ——
  try {
    const raw = await run.exec(scontrolJobCommand(jobId))
    const parsed = parseScontrolJob(raw.stdout)

    if (parsed.ok && parsed.data.stdoutPath !== null) {
      const path = parsed.data.stdoutPath
      tried.push(path)
      const probe = await run.exec(`test -f ${shq(path)} && echo __YES__ || echo __NO__`)

      // 路径是权威的，文件不在也**不能**再去猜别的地方：
      // 作业可能还没写出第一行，或者文件被移走了。如实说比乱猜有用。
      return { ok: true, data: { path, source: 'scontrol', exists: probe.stdout.includes('__YES__') } }
    }
  } catch {
    // scontrol 这条命令本身失败（老构建去掉 --json、临时抖动）：不致命，继续走 sacct。
    // 连接层的问题会在调用方那层被 catch 成 SshError，不会走到这里。
  }

  // —— 第二步：sacct 的工作目录 + 命名约定 ——
  const workDir = hints.workDir?.trim() || null
  if (workDir === null || !workDir.startsWith('/')) {
    return {
      ok: false,
      tried,
      reason: '查不到这个作业的输出路径',
      hint: '调度器里已经没有这个作业的记录了，而历史记录里也没有工作目录。',
      raw: `jobId=${jobId} workDir=${JSON.stringify(hints.workDir ?? null)}`
    }
  }

  const jobName = (hints.jobName ?? '').trim() || 'job'
  const candidates = candidateLogPaths(workDir, jobName, jobId)
  tried.push(...candidates)

  const command = [
    'for f in',
    ...candidates.map((path) => shq(path)),
    '; do if [ -f "$f" ]; then echo "__FOUND__$f"; exit 0; fi; done;',
    'echo "__NOT_FOUND__"'
  ].join(' ')

  const result = await run.exec(command)
  const marker = result.stdout.indexOf('__FOUND__')
  if (marker >= 0) {
    const path = result.stdout.slice(marker + '__FOUND__'.length).split('\n')[0]?.trim() ?? ''
    if (path.length > 0) return { ok: true, data: { path, source: 'sacct', exists: true } }
  }

  return {
    ok: false,
    tried,
    reason: '没找到日志文件',
    hint: '作业可能没产生输出，或者输出写在了别的地方。去文件页按目录找找。',
    raw: [`workDir=${workDir}`, `jobName=${jobName}`, '试过：', ...candidates].join('\n')
  }
}
