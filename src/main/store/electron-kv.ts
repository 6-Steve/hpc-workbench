/**
 * electron-store 适配器。
 *
 * 一开始只用到"能力探测缓存"，那份缓存刻意走 FileKVStore（和命令行探针共用同一个文件，
 * 便于两边对照排查）。这里留给后续的设置项、作业历史、传输记录
 * （用 JSON 不用 SQLite，避免 node-gyp 编译）。
 */
import Store from 'electron-store'
import type { KVStore } from './kv'

type RawStore = {
  get(key: string): unknown
  set(key: string, value: unknown): void
  delete(key: string): void
  readonly store: Record<string, unknown>
}

export class ElectronKVStore implements KVStore {
  private readonly store: RawStore

  constructor(name = 'hpc-workbench') {
    this.store = new Store({ name }) as unknown as RawStore
  }

  get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined
  }

  set<T>(key: string, value: T): void {
    this.store.set(key, value)
  }

  delete(key: string): void {
    this.store.delete(key)
  }

  keys(): string[] {
    return Object.keys(this.store.store ?? {})
  }
}
