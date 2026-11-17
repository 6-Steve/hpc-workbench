/**
 * 主机指纹（TOFU）记录。
 *
 * 为什么不用 ~/.ssh/known_hosts：那是 OpenSSH 的格式（可能带 hashed hostname、多种 key type），
 * 完整解析成本高且容易出错。这里用自己的一份 JSON，语义清晰：
 *
 *   - 首次连接某个 host:port → 记录指纹，打出 SHA256 让人肉核对
 *   - 再连时指纹一致     → 放行
 *   - 指纹变了           → 拒绝连接，并明确告诉用户去哪删记录
 *
 * 指纹变了绝不自动放行——那正是中间人攻击的样子。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface KnownHostRecord {
  algorithm: string
  fingerprint: string
  firstSeenAt: string
}

export type HostVerdict = 'known' | 'new' | 'mismatch'

interface KnownHostsFile {
  version: 1
  hosts: Record<string, KnownHostRecord[]>
}

/** 由 SSH 握手时的 host key blob 算出 OpenSSH 风格的指纹 */
export function fingerprintOf(key: Buffer): { algorithm: string; fingerprint: string } {
  let algorithm = 'unknown'
  if (key.length >= 4) {
    const len = key.readUInt32BE(0)
    if (len > 0 && 4 + len <= key.length) algorithm = key.subarray(4, 4 + len).toString('ascii')
  }
  const digest = createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
  return { algorithm, fingerprint: `SHA256:${digest}` }
}

export class KnownHostsStore {
  private readonly file: string | null
  private data: KnownHostsFile

  /** file 传 null 表示不落盘、只在本进程内记忆（单测和临时连接用） */
  constructor(file: string | null) {
    this.file = file
    this.data = this.load()
  }

  private static key(host: string, port: number): string {
    return `${host.trim().toLowerCase()}:${port}`
  }

  private load(): KnownHostsFile {
    if (!this.file || !existsSync(this.file)) return { version: 1, hosts: {} }
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<KnownHostsFile>
      if (parsed && typeof parsed.hosts === 'object' && parsed.hosts) {
        return { version: 1, hosts: parsed.hosts }
      }
    } catch {
      // 文件损坏不该阻塞连接，重建即可；旧内容不删，改名留证
      try {
        renameSync(this.file, `${this.file}.corrupt-${Date.now()}`)
      } catch {
        /* 连改名都失败就忽略，下面会重新写 */
      }
    }
    return { version: 1, hosts: {} }
  }

  private save(): void {
    if (!this.file) return
    const dir = dirname(this.file)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8')
    renameSync(tmp, this.file) // 原子替换，避免写一半断电留下坏文件
  }

  verify(host: string, port: number, algorithm: string, fingerprint: string): HostVerdict {
    const records = this.data.hosts[KnownHostsStore.key(host, port)]
    if (!records || records.length === 0) return 'new'

    // 同算法必须完全匹配
    const sameAlgo = records.filter((r) => r.algorithm === algorithm)
    if (sameAlgo.length > 0) {
      return sameAlgo.some((r) => r.fingerprint === fingerprint) ? 'known' : 'mismatch'
    }
    // 服务端换了 host key 算法（例如新增 ed25519）：当作未见过，按首次处理
    return 'new'
  }

  remember(host: string, port: number, algorithm: string, fingerprint: string): void {
    const k = KnownHostsStore.key(host, port)
    const existing = this.data.hosts[k] ?? []
    if (existing.some((r) => r.algorithm === algorithm && r.fingerprint === fingerprint)) return

    // 同一算法只保留一条：一对 host:port 在一个算法下只有一把真钥匙，
    // 留多条会让"旧指纹永远有效"，指纹变更的告警就形同虚设
    const records = existing.filter((r) => r.algorithm !== algorithm)
    records.push({ algorithm, fingerprint, firstSeenAt: new Date().toISOString() })
    this.data.hosts[k] = records
    this.save()
  }

  expectedFingerprint(host: string, port: number, algorithm: string): string | null {
    const records = this.data.hosts[KnownHostsStore.key(host, port)] ?? []
    return records.find((r) => r.algorithm === algorithm)?.fingerprint ?? null
  }

  forget(host: string, port: number): boolean {
    const k = KnownHostsStore.key(host, port)
    if (!this.data.hosts[k]) return false
    delete this.data.hosts[k]
    this.save()
    return true
  }

  list(): Record<string, KnownHostRecord[]> {
    return this.data.hosts
  }
}
