import { describe, expect, it } from 'vitest'
import type { ResolvedProfile } from '../src/main/profiles'
import type { ExecResult } from '../src/main/ssh/session'
import { atLeastVersion, buildProbes, interpretProbes, parseSlurmVersion } from '../src/main/ssh/capabilities'

function makeProfile(overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
  return {
    id: 'cluster',
    label: 'cluster',
    host: 'login.example.edu.cn',
    port: 22,
    username: 'user01',
    auth: { method: 'key', privateKeyPath: '/home/user01/.ssh/id_ed25519' },
    maxConcurrent: 5,
    connectTimeoutMs: 15000,
    keepaliveIntervalMs: 10000,
    trustNewHostKey: true,
    quotaCommand: '/usr/lpp/mmfs/bin/mmlsquota --block-size auto',
    ...overrides
  }
}

function execOf(command: string, code: number | null, stdout = '', stderr = ''): ExecResult {
  return { command, code, signal: null, stdout, stderr, durationMs: 12, truncated: false }
}

/** 23.02.3 的实测情况：只有 squeue / sacct 有 --json */
function resultsFor2302(): Record<string, ExecResult> {
  return {
    slurmVersion: execOf('sinfo -V', 0, 'slurm 23.02.3\n'),
    os: execOf('uname -srm', 0, 'Linux 5.15.0-186-generic x86_64\n'),
    home: execOf('printf %s "$HOME"', 0, '/home/user01'),
    sbatch: execOf('command -v sbatch', 0, '/usr/bin/sbatch\n'),
    quotaTool: execOf('test -x /usr/lpp/mmfs/bin/mmlsquota && echo found || echo missing', 0, 'found\n'),
    sinfoJson: execOf('sinfo --json', 1, '', "sinfo: unrecognized option '--json'"),
    squeueJson: execOf('squeue --me --json', 0, '{"jobs": []}'),
    sacctJson: execOf('sacct --json -S now-1hours -E now', 0, '{"jobs": []}'),
    scontrolJson: execOf('scontrol show node --json', 1, '', 'scontrol: error: Invalid option --json')
  }
}

describe('interpretProbes', () => {
  it('按实测的 23.02.3 情况给出能力表', () => {
    const caps = interpretProbes(makeProfile(), resultsFor2302(), 0, 1234)

    expect(caps.sinfoJson).toBe(false)
    expect(caps.scontrolJson).toBe(false)
    expect(caps.squeueJson).toBe(true)
    expect(caps.sacctJson).toBe(true)
    expect(caps.slurmVersionNumber).toBe('23.02.3')
    expect(caps.home).toBe('/home/user01')
    expect(caps.sbatchAvailable).toBe(true)
    expect(caps.quotaToolFound).toBe(true)
    expect(caps.durationMs).toBe(1234)
    expect(caps.profileId).toBe('cluster')
  })

  it('集群升级到 23.11+ 后自动全部走 JSON，不用改代码', () => {
    const results = resultsFor2302()
    results.sinfoJson = execOf('sinfo --json', 0, '{"sinfo": []}')
    results.scontrolJson = execOf('scontrol show node --json', 0, '{"nodes": []}')
    results.slurmVersion = execOf('sinfo -V', 0, 'slurm 24.05.1\n')

    const caps = interpretProbes(makeProfile(), results, 0, 100)
    expect(caps.sinfoJson).toBe(true)
    expect(caps.scontrolJson).toBe(true)
    expect(caps.notes.join('\n')).toContain('结构化路径')
  })

  it('版本仍是 23.02 但构建回移了 data_parser 时，结论不把版本说错', () => {
    // SCIR 跳板机实测：sinfo -V 是 23.02.3，但 sinfo --json 可用（data_parser/v0.0.39）
    const results = resultsFor2302()
    results.sinfoJson = execOf('sinfo --json', 0, '{"sinfo": []}')

    const caps = interpretProbes(makeProfile(), results, 0, 1)
    expect(caps.sinfoJson).toBe(true)
    expect(caps.notes.join('\n')).toContain('data_parser')
  })

  it('退出码 0 但输出不是 JSON 时不算支持（防止假阳性）', () => {
    const results = resultsFor2302()
    results.sinfoJson = execOf('sinfo --json', 0, 'PARTITION AVAIL TIMELIMIT\n')
    expect(interpretProbes(makeProfile(), results, 0, 1).sinfoJson).toBe(false)
  })

  it('配额工具缺失时明确写进结论，并给出将走降级的暗示', () => {
    const results = resultsFor2302()
    results.quotaTool = execOf('test -x ...', 0, 'missing\n')
    const caps = interpretProbes(makeProfile(), results, 0, 1)

    expect(caps.quotaToolFound).toBe(false)
    expect(caps.notes.join('\n')).toContain('找不到配额工具')
  })

  it('sbatch 不在机器上时提示可能不是提交节点', () => {
    const results = resultsFor2302()
    results.sbatch = execOf('command -v sbatch', 1, '')
    expect(interpretProbes(makeProfile(), results, 0, 1).notes.join('\n')).toContain('找不到 sbatch')
  })

  it('squeue 不可用 JSON 时提醒原因要从括号里抠', () => {
    const results = resultsFor2302()
    results.squeueJson = execOf('squeue --me --json', 1, '', 'unrecognized')
    expect(interpretProbes(makeProfile(), results, 0, 1).notes.join('\n')).toContain('括号')
  })

  it('原始证据带命令、退出码、stderr，且 stderr 截到 600 字', () => {
    const results = resultsFor2302()
    results.sinfoJson = execOf('sinfo --json', 1, '', 'E'.repeat(2000))

    const caps = interpretProbes(makeProfile(), results, 0, 1)
    const evidence = caps.evidence.sinfoJson!

    expect(evidence.command).toBe('sinfo --json')
    expect(evidence.code).toBe(1)
    expect(evidence.stderr.length).toBe(600)
  })

  it('probedAt 用传入的时间戳，便于缓存里显示"上次探测于"', () => {
    const stamp = Date.UTC(2026, 9, 31, 8, 0, 0)
    const caps = interpretProbes(makeProfile(), resultsFor2302(), stamp, 1)
    expect(caps.probedAt).toBe(new Date(stamp).toISOString())
  })
})

describe('buildProbes', () => {
  it('配额命令只取二进制路径，带 shell 元字符时转义', () => {
    const normal = buildProbes(makeProfile()).find((p) => p.key === 'quotaTool')!
    expect(normal.command).toBe('test -x /usr/lpp/mmfs/bin/mmlsquota && echo found || echo missing')

    const weird = buildProbes(makeProfile({ quotaCommand: '/opt/x$(id)/mmlsquota --block-size auto' })).find(
      (p) => p.key === 'quotaTool'
    )!
    expect(weird.command).toContain("'/opt/x$(id)/mmlsquota'")
  })

  it('探测项覆盖四类 JSON 与基础环境', () => {
    const keys = buildProbes(makeProfile()).map((p) => p.key)
    expect(keys).toEqual([
      'slurmVersion',
      'os',
      'home',
      'sbatch',
      'quotaTool',
      'sinfoJson',
      'squeueJson',
      'sacctJson',
      'scontrolJson'
    ])
  })
})

describe('parseSlurmVersion', () => {
  it('从各种写法里抠出版本号', () => {
    expect(parseSlurmVersion('slurm 23.02.3')).toBe('23.02.3')
    expect(parseSlurmVersion('SLURM 24.11.0-rc1')).toBe('24.11.0')
    expect(parseSlurmVersion('no version here')).toBeNull()
    expect(parseSlurmVersion(null)).toBeNull()
  })
})

describe('atLeastVersion', () => {
  it('按主次版本比较', () => {
    expect(atLeastVersion('23.02.3', 23, 11)).toBe(false)
    expect(atLeastVersion('23.11.0', 23, 11)).toBe(true)
    expect(atLeastVersion('24.05.1', 23, 11)).toBe(true)
    expect(atLeastVersion('22.05.8', 23, 11)).toBe(false)
  })

  it('解析不出来时保守返回 false', () => {
    expect(atLeastVersion(null, 23, 11)).toBe(false)
    expect(atLeastVersion('garbage', 23, 11)).toBe(false)
  })
})
