/**
 * 诊断包：真的打一个包出来，再解开逐项检查。
 *
 * 这里不 mock 文件系统——「打出来的文件能不能被解开、里面到底有什么」
 * 正是这个功能唯一需要证明的事。所以用真的 tar-stream 写、真的 gunzip 读。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReadStream } from 'node:fs'
import { createGunzip } from 'node:zlib'
import { extract } from 'tar-stream'
import { afterEach, describe, expect, it } from 'vitest'
import { buildDiagnosticsBundle, type BundleSources } from '../src/main/diagnostics/bundle'
import type { TraceEntry, TraceRecord } from '../src/shared/trace'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempTarget(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hpc-diag-'))
  dirs.push(dir)
  return join(dir, 'hpc-diagnose-test.tar.gz')
}

/** 把 tar.gz 解开，返回 文件名 → 内容 */
async function readArchive(path: string): Promise<Record<string, string>> {
  const entries: Record<string, string> = {}
  await new Promise<void>((resolve, reject) => {
    const unzip = createGunzip()
    const untar = extract()
    untar.on('entry', (header, stream, next) => {
      let body = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        body += chunk
      })
      stream.on('end', () => {
        entries[header.name] = body
        next()
      })
      stream.on('error', reject)
      stream.resume()
    })
    untar.on('finish', resolve)
    untar.on('error', reject)
    unzip.on('error', reject)
    createReadStream(path).pipe(unzip).pipe(untar)
  })
  return entries
}

function entry(id: number, command: string): TraceEntry {
  return {
    id,
    at: 1_700_000_000_000 + id,
    profileId: 'hpc',
    host: '192.0.2.46',
    command,
    code: 0,
    durationMs: 120,
    stdout: 'ok',
    stderr: '',
    stdoutChars: 2,
    stderrChars: 0,
    truncated: false
  } as TraceEntry
}

function record(id: number, command: string, fullStdout: string): TraceRecord {
  return { ...entry(id, command), fullStdout, fullStderr: '' }
}

const PROFILES = JSON.stringify({
  version: 2,
  defaultProfile: 'hpc',
  profiles: [
    {
      id: 'hpc',
      label: 'hpc',
      host: '192.0.2.46',
      port: 2223,
      username: 'alice',
      auth: { method: 'key', privateKeyPath: 'C:\\Users\\alice\\.ssh\\id_rsa' }
    }
  ]
})

function sources(patch: Partial<BundleSources> = {}): BundleSources {
  const records = new Map<number, TraceRecord>()
  return {
    appInfo: {
      name: 'HPC 工作台',
      version: '0.1.0',
      platform: 'win32',
      arch: 'x64',
      configPath: 'C:\\Users\\alice\\AppData\\Roaming\\hpc\\profiles.json'
    },
    configDir: {
      dir: 'C:\\Users\\alice\\AppData\\Roaming\\hpc',
      source: 'default'
    },
    profilesRaw: PROFILES,
    knownHostsRaw: JSON.stringify({
      version: 1,
      hosts: { '192.0.2.46:2223': [{ algorithm: 'ssh-ed25519', fingerprint: 'SHA256:abc' }] }
    }),
    trace: {
      list: () => [entry(1, 'squeue --me'), entry(2, 'export TOKEN=abcd1234')],
      detail: (id) => records.get(id) ?? null
    },
    probe: null,
    ...patch
  }
}

describe('诊断包 · 内容', () => {
  it('该有的文件都在', async () => {
    const target = tempTarget()
    const result = await buildDiagnosticsBundle(sources(), { target })

    expect(result.failed).toEqual([])
    const files = await readArchive(target)
    for (const name of [
      'README.txt',
      'manifest.json',
      'app-info.json',
      'config-dir.json',
      'profiles.redacted.json',
      'known-hosts.redacted.json',
      'trace/recent.json'
    ]) {
      expect(Object.keys(files), name).toContain(name)
    }
    // 包本身是真的写到了磁盘
    expect(readFileSync(target).byteLength).toBeGreaterThan(0)
  })

  it('manifest 记录了小节成败与脱敏说明', async () => {
    const target = tempTarget()
    await buildDiagnosticsBundle(sources(), { target })
    const manifest = JSON.parse((await readArchive(target))['manifest.json']!)

    expect(manifest.sections.ok.length).toBeGreaterThan(0)
    expect(manifest.sections.failed).toEqual([])
    expect(manifest.redaction.freeText).toContain('***')
  })

  it('配置被脱敏，但端口和 id 保留（诊断需要）', async () => {
    const target = tempTarget()
    await buildDiagnosticsBundle(sources(), { target })
    const redacted = JSON.parse((await readArchive(target))['profiles.redacted.json']!)

    expect(redacted.profiles[0]).toMatchObject({
      id: 'hpc',
      host: '192.0.*.*',
      port: 2223,
      username: 'a***e(5)',
      auth: { method: 'key', privateKeyPath: '~/.ssh/id_rsa' }
    })
  })

  it('命令记录里的秘密被替换', async () => {
    const target = tempTarget()
    await buildDiagnosticsBundle(sources(), { target })
    const trace = (await readArchive(target))['trace/recent.json']!
    expect(trace).toContain('TOKEN=***')
    expect(trace).not.toContain('abcd1234')
  })

  it('主机在命令记录里也脱敏了', async () => {
    const target = tempTarget()
    await buildDiagnosticsBundle(sources(), { target })
    expect((await readArchive(target))['trace/recent.json']).toContain('192.0.*.*')
  })
})

describe('诊断包 · 容错', () => {
  /*
   * 最需要诊断包的时刻，正是各项都半死不活的时候。
   * 所以"配置读不到"必须仍然产出包，而不是抛异常。
   */
  it('读不到配置 / known_hosts → 仍生成，失败项写进 manifest', async () => {
    const target = tempTarget()
    const result = await buildDiagnosticsBundle(
      sources({ profilesRaw: null, knownHostsRaw: null }),
      { target }
    )

    expect(result.failed.map((item) => item.name).sort()).toEqual(['known-hosts', 'profiles'])

    const files = await readArchive(target)
    expect(Object.keys(files)).toContain('README.txt')
    expect(Object.keys(files)).toContain('trace/recent.json')

    const manifest = JSON.parse(files['manifest.json']!)
    expect(manifest.sections.failed).toHaveLength(2)
  })

  it('配置文件是坏 JSON → 只这一项失败', async () => {
    const target = tempTarget()
    const result = await buildDiagnosticsBundle(sources({ profilesRaw: '{ 坏掉的' }), { target })

    expect(result.failed.map((item) => item.name)).toEqual(['profiles'])
    expect(Object.keys(await readArchive(target))).toContain('known-hosts.redacted.json')
  })

  it('trace 的 detail 返回 null 不会崩（那条跳过）', async () => {
    const target = tempTarget()
    const result = await buildDiagnosticsBundle(sources(), { target })
    expect(result.failed).toEqual([])
  })
})

describe('诊断包 · 完整输出上限', () => {
  it('最多带 20 条完整输出', async () => {
    const records = new Map<number, TraceRecord>()
    const list: TraceEntry[] = []
    for (let i = 1; i <= 40; i += 1) {
      list.push(entry(i, `cmd ${i}`))
      records.set(i, record(i, `cmd ${i}`, `output ${i}`))
    }

    const target = tempTarget()
    await buildDiagnosticsBundle(
      sources({ trace: { list: () => list, detail: (id) => records.get(id) ?? null } }),
      { target }
    )

    const files = await readArchive(target)
    const full = Object.keys(files).filter((name) => name.startsWith('trace/full/'))
    expect(full).toHaveLength(20)
  })
})

describe('诊断包 · 泄露硬断言', () => {
  /*
   * 这条是防回归用的：以后谁往包里多加一个字段、或者改了脱敏实现，
   * 只要把已知密码带了出去，这里就会炸。
   */
  it('把已知密码塞进配置和命令，包全文都搜不到', async () => {
    const secret = 'MyPassw0rd!2026'
    const target = tempTarget()

    await buildDiagnosticsBundle(
      sources({
        profilesRaw: JSON.stringify({
          version: 2,
          defaultProfile: 'hpc',
          profiles: [
            {
              id: 'hpc',
              label: 'hpc',
              host: '192.0.2.46',
              port: 2223,
              username: 'alice',
              auth: { method: 'password', password: secret }
            }
          ]
        }),
        trace: {
          list: () => [entry(1, `mysql -uroot -p${secret}`), entry(2, `export PASSWORD=${secret}`)],
          detail: (id) =>
            id === 1 ? record(1, `mysql -uroot -p${secret}`, `token: ${secret}`) : null
        }
      }),
      { target }
    )

    const files = await readArchive(target)
    const all = Object.entries(files).map(([name, body]) => `${name}\n${body}`).join('\n')
    expect(all).not.toContain(secret)
    // 脱敏是有痕迹的，不是整段删掉
    expect(all).toContain('***')
  })
})
