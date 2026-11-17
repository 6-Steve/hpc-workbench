/**
 * preload 新鲜度判定 + IPC 错误翻译。
 *
 * 背景见 `src/shared/api-version.ts`：改了 preload 不会热更新，窗口里还是旧的，
 * 新方法一调就 `window.hpc.readJobLog is not a function`。
 * 这个报错本身完全看不出发生了什么，得翻译。
 */
import { PRELOAD_API_VERSION } from '../../../shared/api-version'

interface VersionedApi {
  readonly apiVersion?: number
}

/**
 * 这个模块自己声明的错误形状，**刻意不用全局的 `PlainError`**。
 *
 * `PlainError` 是全局声明在 `src/preload/index.d.ts` 里的，但那个文件和
 * `src/preload/index.ts` 同名，TypeScript 会当成它的声明输出而跳过——
 * 于是 node 侧的 tsconfig 看不见它，这个模块的单测就跑不起来。
 *
 * 这里只列出本模块真正会填的字段，结构上是 `PlainError` 的子集，可以直接赋过去。
 */
interface IpcError {
  kind: string
  message: string
  hint?: string
  raw: string
}

/**
 * 传进来的 preload 对象是不是旧的。
 *
 * 旧 preload 上 `apiVersion` 是 `undefined`（字段本身还不存在），
 * 所以 `undefined !== 1` 天然成立，不需要额外的哨兵值。
 */
export function isStalePreload(api: VersionedApi | undefined | null): boolean {
  return api?.apiVersion !== PRELOAD_API_VERSION
}

/** 读当前窗口的 preload 判断新鲜度；preload 整个挂掉时也视为过期 */
export function preloadStale(): boolean {
  const api = (globalThis as { hpc?: VersionedApi }).hpc
  return isStalePreload(api)
}

/** 判断一个异常是不是"方法不存在"这类（TypeError: x is not a function） */
export function isMissingMethodError(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  return /is not a function/i.test(text)
}

const RESTART_HINT =
  '改 preload 不会热更新。把应用窗口完全关掉，重新 npm run dev（或重新打开打包好的应用）。'

/**
 * preload 过期导致某个功能不可用时，界面上该显示什么。
 *
 * `raw` 优先用调用方给的原始异常文本——"失败必须带 raw"是项目契约，
 * 翻成人话是为了让用户看懂，不是为了把证据抹掉。
 */
export function stalePreloadError(feature: string, raw?: string): IpcError {
  return {
    kind: 'preload-stale',
    message: `${feature}没生效：窗口里的 preload 是旧版本。`,
    hint: RESTART_HINT,
    raw: raw ?? 'preload 版本不一致（window.hpc.apiVersion 与渲染层期望值不同）'
  }
}

/** 把错误拍成一行，给只显示字符串的界面用（不要丢掉 hint） */
export function formatPlainError(error: IpcError): string {
  return [error.message, error.hint].filter(Boolean).join(' · ')
}

/**
 * 把调 IPC 时抛出的异常翻成界面能显示的错误。
 *
 * `feature` 是给人看的名字，用来把话说完整，比如「作业日志」→
 * 「作业日志没生效：窗口里的 preload 是旧版本」。
 * 不要把它写成技术名词，用户看到的是这句话。
 */
export function explainIpcError(err: unknown, feature: string): IpcError {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err)

  if (isMissingMethodError(err)) return stalePreloadError(feature, raw)

  return {
    kind: 'ipc',
    message: `调用主进程失败（${feature}）。`,
    hint: '如果反复出现，看开发终端的日志，必要时重启应用。',
    raw
  }
}
