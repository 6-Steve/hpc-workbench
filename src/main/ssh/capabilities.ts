/**
 * 运行时能力探测。
 *
 * 为什么不写死：同一个 SLURM 版本里，有的命令有 --json，有的没有。
 * 23.02.3 的情况是 squeue/sacct 有、sinfo/scontrol 没有。
 * 写死的话，集群哪天升级到 23.11+，代码不会自动用上 JSON；降级也一样会崩。
 *
 * 探测成本：一次连接跑一遍，约 1-2 秒，结果随 profile 缓存进 store
 * （docs/03 §2.1）。
 */
import type { ResolvedProfile } from '../profiles'
import type { ExecResult, Session } from './session'
import { commandBinary, shq } from './shell'

export interface ProbeEvidence {
  command: string
  code: number | null
  /** 只留前 600 字，够诊断就行 */
  stderr: string
  durationMs: number
  truncated: boolean
}

export interface Capabilities {
  profileId: string
  host: string
  username: string
  /** 四个 JSON 能力，Adapter 据此二选一，绝不混用参数 */
  sinfoJson: boolean
  squeueJson: boolean
  sacctJson: boolean
  scontrolJson: boolean
  slurmVersion: string | null
  slurmVersionNumber: string | null
  os: string | null
  home: string | null
  sbatchAvailable: boolean
  quotaCommand: string
  quotaToolFound: boolean
  probedAt: string
  durationMs: number
  /** 人话结论，直接显示在"诊断"面板里 */
  notes: string[]
  /** 每条探测的原始证据：命令、退出码、stderr */
  evidence: Record<string, ProbeEvidence>
}

export interface ProbeDefinition {
  key: string
  command: string
  timeoutMs: number
}

const PROBE_TIMEOUT_MS = 15_000

export function buildProbes(profile: ResolvedProfile): ProbeDefinition[] {
  const quotaBin = commandBinary(profile.quotaCommand)
  return [
    { key: 'slurmVersion', command: 'sinfo -V', timeoutMs: 10_000 },
    { key: 'os', command: 'uname -srm', timeoutMs: 5_000 },
    { key: 'home', command: 'printf %s "$HOME"', timeoutMs: 5_000 },
    { key: 'sbatch', command: 'command -v sbatch', timeoutMs: 5_000 },
    {
      key: 'quotaTool',
      command: `test -x ${shq(quotaBin)} && echo found || echo missing`,
      timeoutMs: 5_000
    },
    { key: 'sinfoJson', command: 'sinfo --json', timeoutMs: PROBE_TIMEOUT_MS },
    { key: 'squeueJson', command: 'squeue --me --json', timeoutMs: PROBE_TIMEOUT_MS },
    { key: 'sacctJson', command: 'sacct --json -S now-1hours -E now', timeoutMs: PROBE_TIMEOUT_MS },
    { key: 'scontrolJson', command: 'scontrol show node --json', timeoutMs: PROBE_TIMEOUT_MS }
  ]
}

export async function probeCapabilities(session: Session, profile: ResolvedProfile): Promise<Capabilities> {
  const probes = buildProbes(profile)
  const startedAt = Date.now()

  const results = await Promise.all(
    probes.map(async (probe) => {
      const result = await session.exec(probe.command, { timeoutMs: probe.timeoutMs })
      return [probe.key, result] as const
    })
  )

  return interpretProbes(
    profile,
    Object.fromEntries(results),
    startedAt,
    Date.now() - startedAt
  )
}

/** 纯函数：把 exec 结果翻译成能力表，方便单测直接喂夹具 */
export function interpretProbes(
  profile: ResolvedProfile,
  results: Record<string, ExecResult>,
  startedAt: number,
  durationMs: number
): Capabilities {
  const evidence: Record<string, ProbeEvidence> = {}
  for (const [key, result] of Object.entries(results)) {
    evidence[key] = {
      command: result.command,
      code: result.code,
      stderr: result.stderr.trim().slice(0, 600),
      durationMs: result.durationMs,
      truncated: result.truncated
    }
  }

  const text = (key: string): string | null => {
    const r = results[key]
    if (!r || r.code !== 0) return null
    const value = r.stdout.trim()
    return value.length > 0 ? value : null
  }

  const sinfoJson = supportsJson(results.sinfoJson)
  const squeueJson = supportsJson(results.squeueJson)
  const sacctJson = supportsJson(results.sacctJson)
  const scontrolJson = supportsJson(results.scontrolJson)

  const slurmVersion = text('slurmVersion')
  const quotaToolFound = text('quotaTool') === 'found'

  const caps: Capabilities = {
    profileId: profile.id,
    host: profile.host,
    username: profile.username,
    sinfoJson,
    squeueJson,
    sacctJson,
    scontrolJson,
    slurmVersion,
    slurmVersionNumber: parseSlurmVersion(slurmVersion),
    os: text('os'),
    home: text('home'),
    sbatchAvailable: text('sbatch') !== null,
    quotaCommand: profile.quotaCommand,
    quotaToolFound,
    probedAt: new Date(startedAt).toISOString(),
    durationMs,
    notes: [],
    evidence
  }

  caps.notes = buildNotes(caps)
  return caps
}

function supportsJson(result: ExecResult | undefined): boolean {
  if (!result || result.code !== 0) return false
  // 只判断首个非空字符，不对几 MB 的 sacct 输出做全量 JSON.parse
  return result.stdout.trimStart().startsWith('{')
}

export function parseSlurmVersion(raw: string | null): string | null {
  if (!raw) return null
  const match = /(\d+\.\d+\.\d+)/.exec(raw)
  return match ? match[1]! : null
}

/** 版本 >= major.minor ？解析不出来时按 false 处理（保守） */
export function atLeastVersion(version: string | null, major: number, minor: number): boolean {
  if (!version) return false
  const [a, b] = version.split('.').map((part) => Number.parseInt(part, 10))
  if (Number.isNaN(a)) return false
  if (a! > major) return true
  if (a! < major) return false
  return (b ?? 0) >= minor
}

function buildNotes(caps: Capabilities): string[] {
  const notes: string[] = []

  if (caps.slurmVersionNumber) {
    notes.push(`SLURM ${caps.slurmVersionNumber}${caps.os ? ` · ${caps.os}` : ''}`)
  }

  if (caps.sinfoJson) {
    const v = caps.slurmVersionNumber
    notes.push(
      atLeastVersion(v, 23, 11)
        ? `sinfo 支持 --json（SLURM ${v}）→ 解析走结构化路径`
        : `sinfo 支持 --json（SLURM ${v ?? '版本未知'}，该构建回移了 data_parser）→ 不必写固定格式解析器`
    )
  } else {
    notes.push('sinfo 不支持 --json → 走固定格式 -o，注意 GRES 的 socket 后缀与 N/A')
  }

  if (caps.scontrolJson) {
    notes.push('scontrol show node 支持 --json')
  } else {
    notes.push('scontrol show node 不支持 --json → 走 -o 单行格式，注意值内含空格')
  }

  if (!caps.squeueJson) {
    notes.push('squeue 不支持 --json → 降级到表格解析，排队原因要从括号里抠')
  }
  if (!caps.sacctJson) {
    notes.push('sacct 不支持 --json → 必须用 --parsable2 并给足列宽，否则 JobName/AllocTRES 会被截断')
  }

  if (!caps.sbatchAvailable) {
    notes.push('找不到 sbatch：这台可能不是提交节点，或 PATH 里没有 SLURM 客户端')
  }

  if (!caps.quotaToolFound) {
    notes.push(`找不到配额工具 ${commandBinary(caps.quotaCommand)}，配额面板会显示"无法读取"并附原始输出`)
  }

  return notes
}

export const CAPABILITY_CACHE_PREFIX = 'capabilities.'

export function capabilityCacheKey(profileId: string): string {
  return `${CAPABILITY_CACHE_PREFIX}${profileId}`
}

/** 缓存里的结构，带写入时间，UI 上要显示"上次探测于 …" */
export interface CachedCapabilities {
  capabilities: Capabilities
  savedAt: string
}
