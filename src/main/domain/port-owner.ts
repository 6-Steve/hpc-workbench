/**
 * 反查「集群侧这个端口到底是谁占着」。
 *
 * ## 为什么非要真去查一次
 *
 * 反向转发（`-R`）绑不上时，ssh2 抛的是
 * `Unable to bind to 127.0.0.1:55555`。
 *
 * 这句话是 **ssh2 在本地拼出来的字符串**（`node_modules/ssh2/lib/client.js:1347`）：
 * 服务端对 `tcpip-forward` 请求只回一个 `SSH_MSG_REQUEST_FAILURE`，
 * **协议里根本没有携带原因的地方**。所以它的真实含义是
 * 「服务端拒绝了，我不知道为什么」，而不是「端口被占了」。
 *
 * 第一版据此写了「多半是你自己手敲的 ssh -R 还开着」，真机一验就错了：
 * 占着 55555 的是**另一个账号**。根因是 `127.0.0.1` 在登录节点上
 * 是**全体用户共享**的一张网卡——谁的进程先绑了，其他人就都绑不上，
 * 跟你本地开没开那条命令毫无关系。
 *
 * 所以失败后要读一次事实：
 * `/proc/net/tcp` 的 `uid` 字段所有用户可读（不需要 root），
 * 拿到 uid 再用 `getent passwd` 翻成用户名。
 */

/** 只需要 exec，不需要整个 Session——这样测试可以传假实现 */
export interface CommandRunner {
  exec(command: string): Promise<{ stdout: string; code: number | null; stderr: string }>
}

export interface PortOwner {
  uid: number
  /** 查不到名字时是 `null`（可能是 LDAP 抽风，也可能用户已删） */
  username: string | null
}

/**
 * 拼出反查命令。
 *
 * 只认 `0A`（LISTEN）状态的 socket：`/proc/net/tcp` 里同一个端口
 * 还有已建立连接的条目（状态 `01`），那些是「谁在用它」而不是「谁在听」，
 * 混进来会把所有者报错。
 */
export function portOwnerCommand(port: number): string {
  // 端口在 /proc/net/tcp 里是 4 位大写十六进制
  const hex = Math.floor(port).toString(16).toUpperCase().padStart(4, '0')
  // 注意必须写成一条完整的单行脚本：按 `; ` 把片段拼起来会在 `do` 后面
  // 多出一个 `do;`，那是**语法错误**（`sh` 和 `bash` 都不接受空命令开头）。
  // tests/port-owner.test.ts 里有一条真的把命令喂给 `bash -n` 的用例挡这个。
  //
  // 只看 `$2`（本地地址），不看 `$3`（对端）：连到 55556 的客户端，它的本地端口
  // 是随机临时端口，不该被算成"占着 55556 的人"。
  //
  // **不按状态过滤**：占着端口的未必是 LISTEN。实测见过一个人的**客户端**把源端口
  // 显式绑到 55556 再连出去（`/proc/net/tcp` 里是一对 ESTAB，没有 LISTEN），
  // 这时候我们去 bind 一样是 EADDRINUSE。只认 0A 会得出"没人占"的错误结论。
  return (
    `for f in /proc/net/tcp /proc/net/tcp6; do ` +
    `if [ -r "$f" ]; then awk -v pat=":${hex}$" '$2 ~ pat { print $8 }' "$f"; fi; ` +
    `done | sort -u | while read -r u; do ` +
    `n=$(getent passwd "$u" 2>/dev/null | cut -d: -f1); echo "$u:\${n:-}"; ` +
    `done`
  )
}

/**
 * 解析结果。输出是 `uid:name` 一行一条；name 为空表示查不到。
 * 没有输出 = 查不到（端口已释放，或对方在别的网络命名空间里）。
 */
export function parsePortOwner(raw: string): PortOwner | null {
  for (const line of raw.split('\n')) {
    const match = /^\s*(\d+):(.*)$/.exec(line)
    if (!match) continue
    const uid = Number(match[1])
    if (!Number.isInteger(uid) || uid < 0) continue
    const username = match[2]?.trim() || null
    return { uid, username }
  }
  return null
}

/**
 * 查端口被谁听着。**任何失败都返回 null**——这是失败路径上的诊断，
 * 诊断本身再抛异常只会把真正的错误盖掉。
 */
export async function lookupPortOwner(
  run: CommandRunner,
  port: number
): Promise<PortOwner | null> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  try {
    const result = await run.exec(portOwnerCommand(port))
    if (result.code !== 0 && result.stdout.trim() === '') return null
    return parsePortOwner(result.stdout)
  } catch {
    return null
  }
}

/** 端口冲突时给几个备选，从原端口往后找 */
export function suggestPorts(port: number, count = 2): number[] {
  const out: number[] = []
  for (let candidate = port + 1; candidate <= 65535 && out.length < count; candidate += 1) {
    out.push(candidate)
  }
  return out
}

/**
 * 在给定候选里挑第一个**没有任何 socket 绑定**的。
 *
 * 为什么一次问一批而不是一个个试：每试一次就是一个 SSH 往返（~100ms），
 * 挑端口是失败路径上的补救动作，不该让用户等三秒。
 *
 * 判据是"`/proc/net/tcp` 里有没有以这个端口为**本地端口**的条目"，不看状态：
 * - LISTEN 当然算占用；
 * - 一个把源端口显式绑到该端口的**客户端**也算（实测踩过，见 `portOwnerCommand` 的注释）；
 * - TIME_WAIT 也算——那正是"刚关掉马上重开"会失败的原因。
 *
 * 即便如此，**拿到的端口仍然要真的 bind 一次才算数**：临时端口段里的端口
 * 随时可能被别人的新连接抓走，探测和 bind 之间有个几毫秒的窗口。
 */
export function freePortProbeCommand(candidates: number[]): string {
  const hexes = candidates.map((port) => Math.floor(port).toString(16).toUpperCase().padStart(4, '0'))
  return (
    `for p in ${hexes.join(' ')}; do ` +
    `if ! awk -v pat=":$p$" '$2 ~ pat { f = 1 } END { exit !f }' ` +
    `/proc/net/tcp /proc/net/tcp6 2>/dev/null; then echo "$p"; break; fi; ` +
    `done`
  )
}

/** 解析 `freePortProbeCommand` 的输出（十六进制），没有输出就是全占着 */
export function parseFreePort(raw: string): number | null {
  const token = raw.trim().split(/\s+/)[0] ?? ''
  if (!/^[0-9A-Fa-f]{1,4}$/.test(token)) return null
  const port = Number.parseInt(token, 16)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
}

/**
 * 找第一个空闲端口。**任何失败都返回 null**——这是失败路径上的补救，
 * 它自己再抛异常只会把真正的绑定错误盖掉。
 */
export async function findFreePort(
  run: CommandRunner,
  candidates: number[]
): Promise<number | null> {
  const ports = candidates.filter(
    (port) => Number.isInteger(port) && port >= 1 && port <= 65535
  )
  if (ports.length === 0) return null
  try {
    const result = await run.exec(freePortProbeCommand(ports))
    return parseFreePort(result.stdout)
  } catch {
    return null
  }
}

/**
 * 给用户看的解释。查到了就说清是谁，查不到就老实说查不到。
 *
 * 不写成「端口被占用」了事，是因为用户的第一反应会是「我没开那个东西啊」——
 * 必须点明 `127.0.0.1` 在这台机器上是全用户共享的，
 * 否则他会一直在自己机器上找一个不存在的进程。
 */
export function portBusyHint(port: number, owner: PortOwner | null): string {
  const where = `集群登录节点上的 127.0.0.1:${port}`
  const alternative = `换一个端口再试（比如 ${suggestPorts(port).join(' 或 ')}）。`

  if (owner === null) {
    return (
      `${where} 绑不上，但没查到是谁占着（可能刚好释放，也可能对方在别的网络命名空间里）。` +
      alternative
    )
  }

  const who =
    owner.username === null ? `uid ${owner.uid} 的进程` : `账号 ${owner.username} 的进程`

  return (
    `${where} 现在被${who}占着。` +
    '注意 127.0.0.1 在登录节点上是所有用户共享的，别人的进程占了你也绑不上——' +
    alternative
  )
}
