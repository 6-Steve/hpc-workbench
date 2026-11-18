/**
 * 把「隧道能不能用」的两次探测结果翻译成一句人话。
 *
 * 判断依据只有一条：**集群经隧道出去的 IP，和本机经 Clash 出去的 IP 是不是同一个**。
 * 一致说明请求确实绕回了你的电脑；不一致说明那个端口上蹲着别人的服务——
 * 这正是「看着通了、其实走别人的代理」那种最难发现的情况。
 *
 * 抽成纯函数是为了能单测：五种组合（两边都通且一致 / 通了但不一致 / 只有集群侧通 /
 * 只有本机通 / 两边都不通）各自该说什么话，都写死在这里。
 */

export interface EgressProbeLike {
  ip: string | null
  error: string | null
}

export type VerifyTone = 'ok' | 'warn' | 'bad'

export interface VerifyVerdict {
  tone: VerifyTone
  text: string
}

export function describeVerify(
  cluster: EgressProbeLike,
  local: EgressProbeLike,
  /** 探测期间隧道计数器是否动过；null/undefined = 无从判断 */
  moved?: boolean | null,
  /**
   * 探测时用的本机端口。
   *
   * 传进来是为了让提示说"检查 7890"而不是永远说 7897——用户的代理端口
   * 未必是 Clash 默认值，指错端口会让他去查一个根本没在用的进程。
   */
  localPort?: number | null
): VerifyVerdict {
  // 1. 两边都通：比对出口 IP，这是唯一能证明"走的是你这台电脑"的证据
  if (cluster.ip && local.ip) {
    if (cluster.ip === local.ip) {
      return { tone: 'ok', text: `可用 · 出口 ${cluster.ip}，和你本机一致` }
    }

    /*
     * 出口不同，但字节确实穿过了本机这条隧道。
     *
     * 这种情况**不是故障**：Clash 用 url-test / load-balance 节点组时，
     * 两次请求落到不同上游节点，出口 IP 天然不同。原来的判定在这里会报
     * "没连到你的电脑"，把正常配置说成坏的——比不报更糟。
     */
    if (moved === true) {
      return {
        tone: 'warn',
        text:
          `通：流量确实走了这条隧道（计数器在涨）。出口是 ${cluster.ip}，你本机经代理是 ${local.ip} —— ` +
          '不同通常是你代理有上游节点/负载均衡，属正常。若你的代理是直连，那才说明端口上蹲着别的服务。'
      }
    }

    return {
      tone: 'bad',
      text: `集群出口 ${cluster.ip}，你本机是 ${local.ip} —— 这条隧道没连到你的电脑`
    }
  }

  // 2. 集群侧通、本机取不到：隧道可能没问题，但没法证明
  if (cluster.ip) {
    const where = localPort ? `在 ${localPort} 上监听` : '在监听'
    return {
      tone: 'warn',
      text: `集群侧通了（出口 ${cluster.ip}），但本机代理没响应，没法比对。检查你的代理软件是否${where}`
    }
  }

  // 3. 本机通、集群侧不通：隧道路径断了（端口没绑上 / 隧道已被关）
  if (local.ip) {
    return {
      tone: 'bad',
      text: `集群上走这个端口不通（${cluster.error ?? '未知原因'}）—— 隧道没生效，或者它已经被关了`
    }
  }

  // 4. 两边都不通：先把代理打开再谈隧道
  return {
    tone: 'bad',
    text: `两边都不通（本机：${local.error ?? '未知'}）。先确认 Clash 开着、能上网，再看隧道`
  }
}
