/**
 * 极小的键值存储抽象。
 *
 * 为什么抽一层：能力探测缓存、settings、传输记录都要落盘，但落盘方式对
 * 调用方不该有区别。桌面应用里用 electron-store（刻意不用 SQLite），
 * 命令行探针（scripts/probe.ts）跑在纯 Node 里，用同语义的 JSON 文件实现。
 */
export interface KVStore {
  get<T>(key: string): T | undefined
  set<T>(key: string, value: T): void
  delete(key: string): void
  keys(): string[]
}

/** 读-改-写一个子结构，省掉各处手工展开 */
export function updateKV<T>(kv: KVStore, key: string, updater: (current: T | undefined) => T): T {
  const next = updater(kv.get<T>(key))
  kv.set(key, next)
  return next
}
