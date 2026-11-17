/**
 * 诊断包生成：采集 → 脱敏 → 打成 `tar.gz`。
 *
 * ## 三条设计约束
 *
 * 1. **每项独立容错**。出问题的时候正是"各项都半死不活"的时候：
 *    配置文件可能坏了、集群可能连不上、上次探测可能没有结果。
 *    所以每个 section 单独 try/catch，失败写进 `manifest.json` 的 `failed`，
 *    **绝不让一项拖垮整包**——否则最需要它的时候它恰好生不出来。
 * 2. **配置走白名单**（见 `shared/diagnostic.ts`），自由文本走黑名单扫描。
 * 3. **打包不引入新依赖**：`tar-stream` 已经是生产依赖（`transfer/tar-download.ts` 用它的 extract），
 *    这里用它的 `pack`，配 `zlib.createGzip()`。Windows 上也不需要装 tar。
 */
import { createWriteStream } from 'node:fs'
import { createGzip } from 'node:zlib'
import { pack as tarPack } from 'tar-stream'
import {
  maskHomePath,
  maskHost,
  redactKnownHosts,
  redactProfilesFile,
  scrubSecrets
} from '../../shared/diagnostic'
import type { TraceEntry, TraceRecord } from '../../shared/trace'

/** 列表里最多带多少条命令 */
const RECENT_LIMIT = 200
/** 完整输出最多带多少条（每条 ≤16KB，20 条 ≈ 320KB 原始） */
const FULL_LIMIT = 20
/** 单条预览在这里再截一刀，防止 4000 字的预览把包撑大 */
const PREVIEW_CAP = 2000
/** 原始内容超过这个量就不再追加完整输出。gzip 后通常只有十分之一 */
const RAW_SIZE_LIMIT = 5 * 1024 * 1024

export interface BundleSources {
  appInfo: unknown
  configDir: unknown
  /** `profiles.json` 原文；读不到传 null */
  profilesRaw: string | null
  /** `known_hosts.json` 原文；读不到传 null */
  knownHostsRaw: string | null
  trace: {
    list(): TraceEntry[]
    detail(id: number): TraceRecord | null
  }
  /** 用户勾了"顺便测一次连接"才会有 */
  probe?: (() => Promise<unknown>) | null
}

export interface BundleOptions {
  /** 目标文件绝对路径 */
  target: string
  includeProbe?: boolean
  now?: () => number
}

export interface BundleResult {
  path: string
  bytes: number
  files: string[]
  /** 因为超限而没带上完整输出 */
  truncated: boolean
  /** 采集失败的小节（包仍然生成） */
  failed: Array<{ name: string; error: string }>
}

const README = `HPC 工作台 · 诊断包
====================

这是什么
  出问题时导出的现场快照，用来排查"连不上/命令失败/结果不对"。

文件说明
  manifest.json              生成时间、应用版本、各小节是否采集成功
  app-info.json              应用版本、Electron/Node/Chrome 版本、配置目录
  config-dir.json            当前用的是哪种配置目录（默认/便携/自定义/环境变量）
  profiles.redacted.json     **脱敏后**的主机配置（主机、用户名、私钥路径都做了遮蔽）
  known-hosts.redacted.json  主机指纹（算法 + 指纹保留，主机名遮蔽）
  trace/recent.json          最近 200 条命令（含退出码、耗时、输出预览）
  trace/full/                最近若干条的完整输出
  notes/probe.txt            连接探测结果（只有在导出时勾选了"顺便测一次"才有）

脱敏说明
  主机地址保留前两段（192.0.*.*），用户名打星，私钥路径只留文件名；
  命令与输出里的 password=/token=/sk-… /-pXXXX 一律替换成 ***。

包里**没有**什么
  密码、私钥内容、终端历史、你传过的文件内容、凭据文件。

怎么回传
  直接把整个 .tar.gz 发出去即可；想先自查，搜一下自己的密码能不能搜到（应该搜不到）。
`

export async function buildDiagnosticsBundle(
  sources: BundleSources,
  options: BundleOptions
): Promise<BundleResult> {
  const now = options.now ?? Date.now
  const generatedAt = new Date(now()).toISOString()
  const files: string[] = []
  const failed: BundleResult['failed'] = []
  let rawBytes = 0
  let truncated = false

  const archive = tarPack()
  const gzip = createGzip({ level: 9 })
  const sink = createWriteStream(options.target)
  archive.pipe(gzip).pipe(sink)

  const add = (name: string, text: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const body = Buffer.from(text, 'utf8')
      rawBytes += body.byteLength
      files.push(name)
      // 0600：命令历史里可能有路径之类的东西，不该被同机其它用户读到
      archive.entry({ name, size: body.byteLength, mode: 0o600 }, body, (err) =>
        err ? reject(err) : resolve()
      )
    })

  const addJson = (name: string, value: unknown): Promise<void> =>
    add(name, `${JSON.stringify(value, null, 2)}\n`)

  /** 每个小节独立容错：失败记进 manifest，继续下一个 */
  const section = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run()
    } catch (err) {
      failed.push({ name, error: err instanceof Error ? err.message : String(err) })
    }
  }

  try {
    await add('README.txt', README)

    await section('app-info', () => addJson('app-info.json', scrubDeep(sources.appInfo)))
    await section('config-dir', () => addJson('config-dir.json', scrubDeep(sources.configDir)))

    await section('profiles', async () => {
      if (!sources.profilesRaw) throw new Error('读不到 profiles.json')
      const parsed: unknown = JSON.parse(sources.profilesRaw)
      await addJson('profiles.redacted.json', {
        // 白名单重建：不认识的字段一律不带
        ...redactProfilesFile(parsed),
        $note: '主机/用户名/私钥路径已脱敏；密码不在文件里，也不在包里。'
      })
    })

    await section('known-hosts', async () => {
      if (!sources.knownHostsRaw) throw new Error('读不到 known_hosts.json')
      const parsed: unknown = JSON.parse(sources.knownHostsRaw)
      await addJson('known-hosts.redacted.json', redactKnownHosts(parsed))
    })

    await section('trace', async () => {
      const entries = sources.trace.list().slice(-RECENT_LIMIT)
      await addJson(
        'trace/recent.json',
        entries.map((entry) => ({
          id: entry.id,
          at: entry.at,
          profileId: entry.profileId,
          host: maskHost(entry.host),
          command: scrubSecrets(entry.command),
          code: entry.code,
          durationMs: entry.durationMs,
          stdout: scrubSecrets(cap(entry.stdout, PREVIEW_CAP)),
          stderr: scrubSecrets(cap(entry.stderr, PREVIEW_CAP)),
          stdoutChars: entry.stdoutChars,
          stderrChars: entry.stderrChars
        }))
      )

      // 完整输出：从最新往前取，超限就停（并且明确记下"被截了"）
      const recentIds = entries.slice(-FULL_LIMIT).reverse()
      for (const entry of recentIds) {
        if (rawBytes > RAW_SIZE_LIMIT) {
          truncated = true
          break
        }
        const record = sources.trace.detail(entry.id)
        if (!record) continue
        await addJson(`trace/full/${entry.id}.json`, {
          id: record.id,
          at: record.at,
          host: maskHost(record.host),
          command: scrubSecrets(record.command),
          code: record.code,
          durationMs: record.durationMs,
          stdout: scrubSecrets(record.fullStdout),
          stderr: scrubSecrets(record.fullStderr)
        })
      }
    })

    if (options.includeProbe && sources.probe) {
      await section('probe', async () => {
        const result = await sources.probe!()
        await add('notes/probe.txt', `${scrubSecrets(JSON.stringify(result, null, 2))}\n`)
      })
    }

    // manifest 最后写：它要汇总前面各节的成败
    const manifest = {
      generatedAt,
      app: (sources.appInfo as { name?: string; version?: string } | null)?.name ?? 'HPC 工作台',
      version: (sources.appInfo as { version?: string } | null)?.version ?? null,
      platform: (sources.appInfo as { platform?: string } | null)?.platform ?? null,
      sections: {
        ok: files.filter((name) => !name.startsWith('trace/full/')),
        failed
      },
      truncated,
      redaction: {
        host: '前两段保留（192.0.*.*）',
        username: '首尾字符 + 长度',
        keyPath: '只留文件名',
        freeText: 'password=/token=/sk-… /-pXXXX → ***'
      }
    }
    await addJson('manifest.json', manifest)
  } finally {
    await finish()
  }

  return {
    path: options.target,
    bytes: rawBytes,
    files,
    truncated,
    failed
  }

  function finish(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const fail = (err: Error): void => reject(err)
      sink.once('error', fail)
      gzip.once('error', fail)
      sink.once('finish', () => resolve())
      archive.finalize()
    })
  }
}

function cap(text: string, limit: number): string {
  const value = text ?? ''
  return value.length > limit ? `${value.slice(0, limit)}…（已截断，原长 ${value.length}）` : value
}

/**
 * 递归扫一遍字符串值。
 *
 * appInfo/configDir 里只有一个路径字段需要处理，但用递归更省心：
 * 以后这些结构里多塞一个路径，也不会因为忘了处理而漏出去。
 */
function scrubDeep(value: unknown): unknown {
  if (typeof value === 'string') return maskHomePath(scrubSecrets(value))
  if (Array.isArray(value)) return value.map(scrubDeep)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrubDeep(inner)
    }
    return out
  }
  return value
}
