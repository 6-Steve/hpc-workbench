/**
 * 纯 Node 的 KV 实现：单个 JSON 文件 + 原子写。
 *
 * 给命令行探针用（不依赖 Electron）。写盘策略：先写临时文件再原子改名，
 * 避免写到一半断电留下坏文件。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { KVStore } from './kv'

interface FileShape {
  version: 1
  data: Record<string, unknown>
}

export class FileKVStore implements KVStore {
  private readonly file: string
  private data: Record<string, unknown>

  constructor(file: string) {
    this.file = file
    this.data = this.load()
  }

  private load(): Record<string, unknown> {
    if (!existsSync(this.file)) return {}
    try {
      const text = readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '')
      const parsed = JSON.parse(text) as Partial<FileShape> | Record<string, unknown>
      if (parsed && typeof parsed === 'object' && 'data' in parsed && typeof parsed.data === 'object') {
        return (parsed as FileShape).data ?? {}
      }
      // 兼容"直接就是键值对"的老格式
      return parsed as Record<string, unknown>
    } catch {
      return {}
    }
  }

  private flush(): void {
    const dir = dirname(this.file)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const payload: FileShape = { version: 1, data: this.data }
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    try {
      renameSync(tmp, this.file)
    } catch (err) {
      // Windows 上目标文件被占用时 rename 会失败，退化成覆盖写
      try {
        unlinkSync(tmp)
      } catch {
        /* ignore */
      }
      writeFileSync(this.file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      void err
    }
  }

  get<T>(key: string): T | undefined {
    return this.data[key] as T | undefined
  }

  set<T>(key: string, value: T): void {
    this.data[key] = value
    this.flush()
  }

  delete(key: string): void {
    if (!(key in this.data)) return
    delete this.data[key]
    this.flush()
  }

  keys(): string[] {
    return Object.keys(this.data)
  }
}
