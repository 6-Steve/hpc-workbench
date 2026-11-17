/**
 * preload 新鲜度判定。
 *
 * 这组断言锁的是一件容易被改坏的事：`apiVersion` 缺失必须判为"旧"。
 * 如果哪天有人把它写成 `api?.apiVersion ?? PRELOAD_API_VERSION`，
 * 旧 preload（字段不存在）就会假阳性地判成"新的"，
 * 于是横幅永远不出现，用户又回到对着 `is not a function` 猜的状态。
 */
import { describe, expect, it } from 'vitest'
import {
  explainIpcError,
  formatPlainError,
  isMissingMethodError,
  isStalePreload,
  stalePreloadError
} from '../src/renderer/src/lib/preload'
import { PRELOAD_API_VERSION } from '../src/shared/api-version'

describe('isStalePreload', () => {
  it('版本号一致时判为新鲜', () => {
    expect(isStalePreload({ apiVersion: PRELOAD_API_VERSION })).toBe(false)
  })

  it('没有 apiVersion 字段（旧 preload）判为过期', () => {
    expect(isStalePreload({})).toBe(true)
  })

  it('preload 整个没加载上时判为过期', () => {
    expect(isStalePreload(undefined)).toBe(true)
    expect(isStalePreload(null)).toBe(true)
  })

  it('版本号对不上判为过期', () => {
    expect(isStalePreload({ apiVersion: PRELOAD_API_VERSION + 1 })).toBe(true)
    expect(isStalePreload({ apiVersion: 0 })).toBe(true)
  })
})

describe('isMissingMethodError', () => {
  it('认得出 is not a function', () => {
    expect(isMissingMethodError(new TypeError('window.hpc.readJobLog is not a function'))).toBe(true)
    expect(isMissingMethodError('window.hpc.readJobLog is not a function')).toBe(true)
  })

  it('别的错误不算', () => {
    expect(isMissingMethodError(new Error('网络断了'))).toBe(false)
    expect(isMissingMethodError(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe(false)
  })
})

describe('explainIpcError', () => {
  it('方法不存在时翻成"preload 是旧版本"，并且带上重启提示', () => {
    const error = explainIpcError(new TypeError('window.hpc.readJobLog is not a function'), '作业日志')

    expect(error.kind).toBe('preload-stale')
    expect(error.message).toContain('作业日志')
    expect(error.message).toContain('旧版本')
    // hint 是用户唯一的行动指引，不能为空
    expect(error.hint).toBeTruthy()
    // raw 必须保留原始异常，否则排查时还是两眼一抹黑
    expect(error.raw).toContain('is not a function')
  })

  it('其它异常保持原样，不会被误报成 preload 问题', () => {
    const error = explainIpcError(new Error('连接超时'), '作业日志')

    expect(error.kind).toBe('ipc')
    expect(error.raw).toBe('Error: 连接超时')
    expect(error.message).not.toContain('旧版本')
  })

  it('非 Error 的抛出物也能处理', () => {
    expect(explainIpcError('随便一个字符串', '作业列表').raw).toBe('随便一个字符串')
  })
})

describe('stalePreloadError / formatPlainError', () => {
  it('功能名进到 message 里，用户才知道是哪块坏了', () => {
    expect(stalePreloadError('作业日志').message).toContain('作业日志')
  })

  it('拍成一行时 message 和 hint 都不丢', () => {
    const line = formatPlainError(stalePreloadError('查这台机器的占用'))

    expect(line).toContain('查这台机器的占用')
    expect(line).toContain('npm run dev')
  })
})
