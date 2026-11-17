/**
 * 启动页的结构守卫。
 *
 * ## 这里防的两个 bug 都真实发生过
 *
 * ### ① 启动检查跑了 7 遍
 *
 * `leave` 曾经依赖 `onDone`，而 App 传的是内联箭头函数 → 父组件每次重渲染都
 * 生成新函数 → `leave` 变 → effect 重跑 → 又发一次启动检查。实测 7 次，
 * 主进程真连了 7 次集群。
 *
 * ### ② 修①之后启动页**永久卡死**
 *
 * 用了一个 flag 早退来防重复，配上 `StrictMode` 的双调用就死锁：
 * 第一次 effect 发请求后被 cleanup 置 `cancelled = true`，第二次 effect 被 flag
 * 拦住不发请求，于是唯一那次请求的结果无人接收，`status` 永远是 `null`。
 *
 * ## ⚠️ 源码断言必须先剥掉注释
 *
 * 第一版这里直接对源码做 `toContain` / `not.toContain`。结果 bug ② 修完后，
 * 断言 `toContain('requestedRef')` **仍然通过**——因为解释这个坑的注释里
 * 恰好写着这个词。**注释把守卫骗过去了**，而这种守卫比没有更糟（它给人安全感）。
 *
 * 所以下面所有断言都在 `stripComments()` 之后做。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const SOURCE = 'src/renderer/src/components/BootSplash.tsx'

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8')
}

/** 去掉块注释与行注释，避免断言被注释里的示例代码骗过 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('启动页 · 结构守卫', () => {
  const code = stripComments(read(SOURCE))

  it('`leave` 的依赖数组里不能有 onDone', () => {
    /*
     * `[onDone]` 会让 leave 每次父渲染都变，进而让 effect 重跑。
     * 正确写法是 `[]` + 用 ref 保存 onDone。
     */
    expect(code).not.toMatch(/\}\s*,\s*\[onDone\]\s*\)/)
  })

  it('onDone 通过 ref 取用（这样 leave 才能稳定）', () => {
    expect(code).toContain('onDoneRef')
    expect(code).toMatch(/onDoneRef\.current\s*=\s*onDone/)
  })

  it('用 createOncePerAttempt 去重，而不是自己写 flag 早退', () => {
    /*
     * flag 早退的写法（`if (requestedRef.current === attempt) return`）会让
     * 那次 effect 完全不挂 `.then`，结果就没人接。
     * 正确做法是缓存 Promise，让每个 effect 实例都能挂上去。
     */
    expect(code).toContain('createOncePerAttempt')
    expect(code).not.toContain('requestedRef')
  })

  it('effect 里必须有 catch，别让失败的请求变成"永远等"', () => {
    // 没有 catch 时 rejection 无人处理，status 停在 null，启动页同样卡死
    expect(code).toMatch(/bootOnce\(\s*attempt\s*\)[\s\S]{0,600}?\.catch\(/)
  })

  it('启动检查的调用点只有一个', () => {
    const calls = code.match(/hpc\.bootStatus\(/g) ?? []
    expect(calls).toHaveLength(1)
  })
})
