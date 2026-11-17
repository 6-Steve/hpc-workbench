/**
 * 反向隧道：默认端口被占时，退到一个临时端口。
 *
 * ## 为什么需要这层
 *
 * `127.0.0.1` 在登录节点上是全用户共享的。用户把默认端口定成
 * 55556，别人恰好也在用，`-R` 就会整条失败——而这时候**换一个端口就能通**，
 * 只是代价变成"这一次临时改一下代理指向"。这个代价是可接受的，
 * 完全失败则不可接受。
 *
 * ## 为什么"临时"要说清楚
 *
 * 换端口不写回 `~/.profile`：写文件是改用户的持久环境，副作用太大，
 * 而且用户可能只是今天要用一下。所以这里只负责"把隧道开在一个能用的端口上"，
 * 提示怎么写、要不要持久化，交给界面（`shared/proxy.ts` 有现成的命令片段）。
 *
 * ## 为什么抽成独立模块
 *
 * 这段逻辑有三条分支（一次就成 / 占了换一个 / 换不了），塞在 IPC handler 里
 * 就只能靠真机碰运气。这里用 `tryOpen` 注入，测试可以精确模拟"哪些端口被占"。
 */
import {
  findFreePort,
  lookupPortOwner,
  suggestPorts,
  type CommandRunner,
  type PortOwner
} from './port-owner'

export interface FallbackInfo {
  /** 用户填的端口 */
  requested: number
  /** 实际开起来的端口 */
  actual: number
  /** 占着 requested 的那个账号；查不到是 null */
  owner: PortOwner | null
  /**
   * 占着端口的账号**就是当前登录账号**。
   *
   * 这个字段存在的唯一原因是文案。反向隧道的监听端口是 sshd 以你的身份
   * 在集群上创建的，所以「被账号 alice 的进程占着」在你自己开了两条隧道时
   * 指的是**你自己**——不点明的话，用户会以为集群上有别人的进程，
   * 甚至怀疑是不是 Codex 单独建了一条。
   */
  ownerIsSelf?: boolean
}

export interface OpenResult<T> {
  tunnel: T
  /** null = 顺利开在用户要的端口上 */
  fallback: FallbackInfo | null
}

/**
 * ssh2 在服务端拒绝绑定时给的就是这句。它是 ssh2 本地拼的字符串，
 * 协议里没有原因字段——但在这里它足以区分"绑定被拒"和"别的错"。
 */
export function isBindFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /unable to bind/i.test(message)
}

export async function openWithFallback<T extends { listenPort: number }>(options: {
  run: CommandRunner
  requested: number
  tryOpen: (port: number) => Promise<T>
  /** 候选端口；默认从 requested+1 往后取 12 个 */
  candidates?: number[]
  /** 最多试几个候选，默认 3。给多次机会是因为"探测时空闲"不等于"bind 时还空闲" */
  attempts?: number
  /** 当前登录账号，用来判断"占用者是不是你自己" */
  selfUsername?: string
}): Promise<OpenResult<T>> {
  const { run, requested, tryOpen } = options

  try {
    return { tunnel: await tryOpen(requested), fallback: null }
  } catch (err) {
    // 不是"绑定被拒"就原样抛：连接层问题、参数问题都不该被这里悄悄改端口
    if (!isBindFailure(err)) throw err

    const owner = await lookupPortOwner(run, requested)
    const maxAttempts = Math.max(1, options.attempts ?? 3)
    let remaining = (options.candidates ?? suggestPorts(requested, 12)).filter(
      (port) => port !== requested
    )

    // 探测和 bind 之间有一个几毫秒的窗口：端口可能刚好被别人的新连接抓走
    // （临时端口段里尤其常见）。所以候选要一个个真试，失败就换下一个。
    for (let attempt = 0; attempt < maxAttempts && remaining.length > 0; attempt += 1) {
      const free = await findFreePort(run, remaining)
      if (free === null) break

      try {
        const tunnel = await tryOpen(free)
        return {
          tunnel,
          fallback: {
            requested,
            actual: tunnel.listenPort,
            owner,
            ownerIsSelf: Boolean(
              owner?.username && options.selfUsername && owner.username === options.selfUsername
            )
          }
        }
      } catch (retryError) {
        if (!isBindFailure(retryError)) throw retryError
        remaining = remaining.filter((port) => port !== free)
      }
    }

    // 帮不上忙就把**原始错误**抛回去，让上层照常翻译成"被谁占着"的话术。
    // 这里不能编一个新错误，否则真正的失败原因会被盖掉。
    throw err
  }
}
