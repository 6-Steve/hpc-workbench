/**
 * 凭据保险库：把密码加密后存盘，需要时取回来。
 *
 * ## 加密由谁做
 *
 * 不是自己做，而是交给操作系统的钥匙串（Windows DPAPI / macOS Keychain，
 * 通过 Electron 的 `safeStorage`）。这样有两个直接好处：
 *
 * 1. **零依赖**。`keytar` 那类库是原生模块，编译不过就整个项目装不上
 *    （硬约定 7）。`safeStorage` 是 Electron 内置的。
 * 2. **密钥不归我们管**。DPAPI 的密钥绑当前操作系统用户，别人拷走
 *    `credentials.json` 也解不开——这正好满足"应用发给他人"的目标：
 *    每个人存的是自己的，互相打不开。
 *
 * ## 加密后端是可注入的（`Cipher`）
 *
 * 这样这个文件不 import electron，能在纯 node 的测试里跑满整个流程：
 * 加密往返、scope 隔离、解密失败、不可用降级。真正的 `safeStorage`
 * 版本在 `safe-storage-cipher.ts` 里，只有十几行。
 *
 * ## 系统钥匙串不可用时**绝不静默降级成明文**
 *
 * 在 Linux 上没装 keyring、或者某些精简 Windows 环境里，
 * `safeStorage.isEncryptionAvailable()` 会返回 false。这时正确的做法是
 * **明确拒绝保存**，只提供"本次会话记住"（进程退出即忘）。
 *
 * 静默退回明文是最坏的选择：用户以为存的是加密的，实际上
 * `credentials.json` 里躺着一份可以直接读的密码。
 *
 * ## 会话缓存是必需的，不是优化
 *
 * 即使钥匙串可用，也有人不想把密码落盘（共用电脑）。所以取密码的顺序是：
 * **会话缓存 → 磁盘密文 → 没有**。前者是用户明确说了"就这一次"的。
 */
import type { KVStore } from '../store/kv'
import {
  credentialKey,
  isCredentialKind,
  type CredentialKind
} from './types'

/** 加密后端。真实实现见 `safe-storage-cipher.ts`，测试里注入假的 */
export interface Cipher {
  /** 这台机器现在能不能加密。false 时**不允许保存** */
  available: boolean
  /** 给用户看的后端名字，如「Windows DPAPI」「macOS 钥匙串」 */
  backend: string
  /** 明文 → base64 密文。失败要抛 */
  encrypt(plain: string): string
  /** base64 密文 → 明文。解不开要抛 */
  decrypt(cipher: string): string
}

/** 磁盘上每条凭据的样子。**没有任何可用于猜密码的元信息** */
interface StoredCredential {
  /** base64 密文 */
  cipher: string
  /** ISO 时间，只用于界面显示"什么时候存的" */
  savedAt: string
}

export interface CredentialInfo {
  kind: CredentialKind
  scope: string
  /** 存在磁盘上的时间；只在本次会话里记着时为 null */
  savedAt: string | null
  /** true = 没落盘，退出应用就没了 */
  sessionOnly: boolean
}

export type CredentialLookup =
  | { ok: true; secret: string; source: 'session' | 'disk' }
  | { ok: false; reason: 'missing' | 'undecryptable' }

export interface VaultStatus {
  /** 系统钥匙串能不能用。false 时界面要禁用"保存"并说明原因 */
  available: boolean
  backend: string
  /** 磁盘上存了几条 */
  stored: number
  /** 本次会话临时记了几条 */
  sessionOnly: number
}

export interface CredentialVaultOptions {
  store: KVStore
  cipher: Cipher
  /** 注入时钟，测试里好断言 savedAt */
  now?: () => Date
}

export class CredentialVault {
  private readonly store: KVStore
  private readonly cipher: Cipher
  private readonly now: () => Date

  /**
   * 只在本次进程里活着的密码。
   *
   * key 是完整的 `credentialKey`，所以和磁盘记录天然隔离——
   * 同一条凭据可以"没落盘但本次记住"，两者不会打架。
   */
  private readonly session = new Map<string, string>()

  /**
   * 解密结果缓存（同一条凭据只解一次）。
   *
   * ## 为什么必须有
   *
   * `safeStorage.decryptString` 在 Windows 上是**同步**的 DPAPI 调用，
   * 会阻塞主进程的事件循环。而 `ProfileState.current()` 每次被调用都会走一遍
   * 凭据解析——启动时渲染层并发发起 4 个请求（启动检查 + 三个轮询），
   * 就是 4 次串行的同步 DPAPI。
   *
   * 更糟的是 `current()` 还在**每个**网络操作前被调用（作业 20 秒一轮、
   * 配额 5 分钟一轮、每次开终端/隧道/传输）。不缓存的话，一个纯读取的操作
   * 也要付一次系统调用。
   *
   * ## 关于"明文常驻内存"的取舍
   *
   * 解密后的明文本来就要交给 `ssh2` 做认证，连接期间它就在
   * `profile.auth.password` 里。缓存在这里只是把"每次连接都解密一次"
   * 变成"每条凭据解密一次"，暴露面没有实质变化（都在同一个进程的内存里）。
   *
   * 增删改**必须**清掉对应项，否则用户改了密码、程序还拿旧的去连——
   * 那会表现成"改了也没用"，比慢严重得多。
   */
  private readonly decrypted = new Map<string, string>()

  constructor(options: CredentialVaultOptions) {
    this.store = options.store
    this.cipher = options.cipher
    this.now = options.now ?? (() => new Date())
  }

  status(): VaultStatus {
    const records = this.readRecords()
    return {
      available: this.cipher.available,
      backend: this.cipher.backend,
      stored: records.size,
      sessionOnly: this.session.size
    }
  }

  /** 落盘的凭据清单。不返回任何密文，界面用不上 */
  list(): CredentialInfo[] {
    const records = this.readRecords()
    const out: CredentialInfo[] = []

    for (const [key, record] of records) {
      const parsed = parseKey(key)
      if (!parsed) continue
      out.push({ ...parsed, savedAt: record.savedAt, sessionOnly: false })
    }
    // 会话里的那些如果没落盘，也要出现在清单里，否则用户"设了却看不到"
    for (const key of this.session.keys()) {
      if (records.has(key)) continue
      const parsed = parseKey(key)
      if (!parsed) continue
      out.push({ ...parsed, savedAt: null, sessionOnly: true })
    }
    return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.scope.localeCompare(b.scope))
  }

  has(kind: CredentialKind, scope: string): boolean {
    const key = safeKey(kind, scope)
    if (!key) return false
    return this.session.has(key) || this.readRecords().has(key)
  }

  /**
   * 存一条，落盘。
   *
   * 钥匙串不可用时**直接抛**，不写任何东西——调用方应该先查 `status().available`
   * 并给用户"只能本次记住"的选项，而不是走到这里。
   */
  set(kind: CredentialKind, scope: string, secret: string): void {
    if (secret.length === 0) {
      throw new Error('密码是空的，没有可存的内容')
    }
    if (!this.cipher.available) {
      throw new Error(`这台机器上${this.cipher.backend}不可用，无法保存密码（只能用"本次记住"）`)
    }

    const key = credentialKey(kind, scope)
    const records = this.readRecords()
    records.set(key, { cipher: this.cipher.encrypt(secret), savedAt: this.now().toISOString() })
    this.writeRecords(records)
    // 密文换了，旧的解密结果必须作废——否则改了密码还会拿旧值去连
    this.decrypted.delete(key)
    // 已经落盘了，会话缓存就没必要留一份明文在内存里
    this.session.delete(key)
  }

  /** 只在本次运行内记住，不落盘 */
  rememberForSession(kind: CredentialKind, scope: string, secret: string): void {
    if (secret.length === 0) return
    const key = credentialKey(kind, scope)
    this.session.set(key, secret)
    this.decrypted.delete(key)
  }

  remove(kind: CredentialKind, scope: string): void {
    const key = safeKey(kind, scope)
    if (!key) return

    this.session.delete(key)
    this.decrypted.delete(key)
    const records = this.readRecords()
    if (records.delete(key)) this.writeRecords(records)
  }

  /**
   * 删掉某条 profile 的登录密码。
   *
   * 为什么只删 `ssh-password` 而不"按 scope 全删"：
   * 私钥口令的 scope 是**文件路径**，同一把 key 可能被多条 profile 共用。
   * 跟着某条 profile 一起删，会把还在用的那条也弄哑——表现是"切回另一台
   * 机器突然要密码了"，而且极难联想到是因为删了别的 profile。
   *
   * 第一版写的是 `removeScope(scope)` 按字符串比，对路径类永远匹配不上
   * （存的是规范化后的绝对路径），等于安静地什么都没删。
   */
  removeProfileCredentials(profileId: string): void {
    this.remove('ssh-password', profileId)
  }

  /**
   * 取密码。
   *
   * 区分 `missing` 和 `undecryptable` 很有必要：
   * - `missing`：用户没存过 → 提示"去设置里填"
   * - `undecryptable`：存过但解不开 → 多半是换了 Windows 账户 / 重装了系统 /
   *   文件被别的机器拷过来。提示完全不同，用户要做的事也不同（重新输一次）。
   *
   * **永远不要把 `secret` 写进日志或错误信息。**
   */
  get(kind: CredentialKind, scope: string): CredentialLookup {
    const key = safeKey(kind, scope)
    if (!key) return { ok: false, reason: 'missing' }

    const cached = this.session.get(key)
    if (cached !== undefined) return { ok: true, secret: cached, source: 'session' }

    // 解密一次就够了（见 `decrypted` 的注释：DPAPI 是同步阻塞调用）
    const already = this.decrypted.get(key)
    if (already !== undefined) return { ok: true, secret: already, source: 'disk' }

    const record = this.readRecords().get(key)
    if (!record) return { ok: false, reason: 'missing' }

    try {
      const secret = this.cipher.decrypt(record.cipher)
      this.decrypted.set(key, secret)
      return { ok: true, secret, source: 'disk' }
    } catch {
      return { ok: false, reason: 'undecryptable' }
    }
  }

  private readRecords(): Map<string, StoredCredential> {
    const raw = this.store.get<Record<string, unknown>>(STORAGE_NAMESPACE)
    const records = new Map<string, StoredCredential>()
    if (!raw || typeof raw !== 'object') return records

    for (const [key, value] of Object.entries(raw)) {
      if (!value || typeof value !== 'object') continue
      const entry = value as Partial<StoredCredential>
      if (typeof entry.cipher !== 'string' || entry.cipher.length === 0) continue
      if (typeof entry.savedAt !== 'string') continue
      records.set(key, { cipher: entry.cipher, savedAt: entry.savedAt })
    }
    return records
  }

  private writeRecords(records: Map<string, StoredCredential>): void {
    if (records.size === 0) {
      // 空的时候就整块删掉，别在磁盘上留一个 `{"credentials":{}}` 的壳
      this.store.delete(STORAGE_NAMESPACE)
      return
    }
    this.store.set(STORAGE_NAMESPACE, Object.fromEntries(records))
  }
}

/**
 * 整个保险库在 KV 里只占一个键。
 *
 * 用一个命名空间而不是"每条凭据一个键"，是为了让 `list()` 一次读完，
 * 也让"删掉全部"变成一次写。
 */
const STORAGE_NAMESPACE = 'credentials.vault'

function parseKey(key: string): { kind: CredentialKind; scope: string } | null {
  const index = key.indexOf('::')
  if (index <= 0) return null
  const kind = key.slice(0, index)
  const scope = key.slice(index + 2)
  if (!isCredentialKind(kind) || scope.length === 0) return null
  return { kind, scope }
}

/** 调用方传进来的 scope 可能不合法（空的、乱填的），这里统一吞掉异常 */
function safeKey(kind: CredentialKind, scope: string): string | null {
  try {
    return credentialKey(kind, scope)
  } catch {
    return null
  }
}

/**
 * 面向界面的一层包装：把 `CredentialVault` 的异常转成可显示的结果。
 *
 * 为什么要这一层：IPC handler 里如果直接抛，渲染层拿到的是
 * `Error invoking remote method`——用户完全看不懂。这里统一成
 * `{ ok:false, reason }`，理由是人话。
 */
export function explainVaultError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (message.includes('不可用')) return message
  // 注意判「空」而不是「为空」：抛出来的原文是"密码是空的"，差一个字就落到兜底
  if (message.includes('空')) return '密码是空的'
  if (message.includes('scope')) return '这条凭据缺少归属（不知道属于哪个跳板机 / 文件 / 账号）'
  return `保存失败：${message}`
}
