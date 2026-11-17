import { describe, expect, it } from 'vitest'
import { Semaphore } from '../src/main/ssh/semaphore'
import { commandBinary, shq } from '../src/main/ssh/shell'

describe('Semaphore', () => {
  it('并发不超过 limit', async () => {
    const sem = new Semaphore(3)
    let running = 0
    let peak = 0

    await Promise.all(
      Array.from({ length: 12 }, () =>
        sem.run(async () => {
          running += 1
          peak = Math.max(peak, running)
          await new Promise((resolve) => setTimeout(resolve, 5))
          running -= 1
        })
      )
    )

    expect(peak).toBe(3)
    expect(sem.inFlight).toBe(0)
    expect(sem.waiting).toBe(0)
  })

  it('任务抛异常也会释放名额', async () => {
    const sem = new Semaphore(1)

    await expect(sem.run(async () => Promise.reject(new Error('x')))).rejects.toThrow('x')
    expect(sem.inFlight).toBe(0)

    // 名额没泄漏，后续任务还能跑
    await expect(sem.run(async () => 'ok')).resolves.toBe('ok')
  })

  it('重复调用释放函数只生效一次，不会把计数减成负数', async () => {
    const sem = new Semaphore(2)
    const first = await sem.acquire()
    const second = await sem.acquire()

    first()
    first() // 重复释放必须是 no-op
    expect(sem.inFlight).toBe(1)

    second()
    expect(sem.inFlight).toBe(0)
  })

  it('limit 非法时直接拒绝构造', () => {
    expect(() => new Semaphore(0)).toThrowError(RangeError)
    expect(() => new Semaphore(1.5)).toThrowError(RangeError)
  })
})

describe('shq', () => {
  it('安全字符不加引号，保持日志可读', () => {
    expect(shq('/usr/lpp/mmfs/bin/mmlsquota')).toBe('/usr/lpp/mmfs/bin/mmlsquota')
    expect(shq('user01')).toBe('user01')
  })

  it('特殊字符一律单引号包裹', () => {
    expect(shq('a b')).toBe("'a b'")
    expect(shq("it's")).toBe("'it'\\''s'")
    expect(shq('$(rm -rf ~)')).toBe("'$(rm -rf ~)'")
    expect(shq('a|b;c')).toBe("'a|b;c'")
    expect(shq('')).toBe("''")
  })
})

describe('commandBinary', () => {
  it('取第一段，忽略参数', () => {
    expect(commandBinary('/usr/lpp/mmfs/bin/mmlsquota --block-size auto')).toBe('/usr/lpp/mmfs/bin/mmlsquota')
    expect(commandBinary('  sinfo   -V ')).toBe('sinfo')
  })
})
