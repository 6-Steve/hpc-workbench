/**
 * 读集群上登录 shell 默认用的代理端口（`~/.profile` 里的 `http_proxy`）。
 *
 * ## 为什么需要它
 *
 * 反向隧道（`-R`）的**集群侧监听端口**必须和集群上 `http_proxy` 指向的端口一致，
 * 否则隧道开得再成功也没人用——集群上的程序还在敲另一个门。
 * 这是一个纯隐性的约定：两边各写一个数字，看起来都"开了"，实际谁也没连上。
 *
 * 实测用户环境：
 *
 * ```bash
 * # ~/.profile 第 31-36 行
 * export http_proxy="http://127.0.0.1:55555"
 * export https_proxy="$http_proxy"   # 后面五个都引用它
 * ```
 *
 * ## 为什么不直接 `echo $http_proxy`
 *
 * `session.exec()` 走的是 sshd 的 exec 通道，跑的是**非登录** shell，
 * `~/.profile` 根本不会被读，`$http_proxy` 是空的。
 * 改成 `bash -lc` 又会把 motd / conda 初始化那堆东西一起吐出来，还改工作目录。
 *
 * 直接读文件更准：我们要的本来就是"**新开的终端会拿到什么**"，
 * 而不是"某个正在跑的进程身上是什么"（那个值可能是临时 export 的，我们无从得知）。
 *
 * ## 为什么远端只做 grep，不做 sed
 *
 * 早期版本让 sed 在远端把端口抠出来。问题不在 sed 本身，而在于**那段逻辑没法单测**：
 * 本机 spawn `bash` 在沙箱里会 EBUSY，测试只能静默跳过，等于没测。
 * 现在远端只负责把那一行原文捞回来，解析放在 `parseProxyLine` 里用 JS 做，
 * 于是各种写法（带引号、不带引号、带路径、没有端口）都能用真实字符串覆盖到。
 */
import type { CommandRunner } from './port-owner'

/** 按登录 shell 的实际读取顺序找；找到第一条就停 */
export const PROXY_FILES = ['.profile', '.bash_profile', '.bashrc']

/**
 * 打印第一条 `http_proxy=...` 原文。
 *
 * 注意不能写成 `do;`——空命令开头是 shell 语法错误（docs/04 E27）。
 */
export function proxyLineCommand(): string {
  const files = PROXY_FILES.map((name) => `"$HOME/${name}"`).join(' ')
  const pattern = "'^[[:space:]]*(export[[:space:]]+)?http_proxy='"
  return (
    `for f in ${files}; do ` +
    `[ -r "$f" ] || continue; ` +
    `if grep -m1 -E ${pattern} "$f" 2>/dev/null; then break; fi; ` +
    `done`
  )
}

/**
 * 从那一行里抠出端口。
 *
 * 认得的写法：`export http_proxy="http://127.0.0.1:55555"`、`http_proxy=http://10.0.0.5:3128`、
 * 末尾带个 `/` 的、以及带单引号的。没写端口时按协议默认值（http 80 / https 443）。
 */
export function parseProxyLine(raw: string): number | null {
  const line = raw
    .split('\n')
    .map((item) => item.trim())
    .find((item) => /http_proxy\s*=/i.test(item))
  if (!line) return null

  const assigned = /http_proxy\s*=\s*(["']?)([^"'\s]+)/i.exec(line)
  const url = assigned?.[2]
  if (!url) return null

  const withPort = /:(\d{1,5})\/?$/.exec(url)
  if (withPort) {
    const port = Number(withPort[1])
    return port >= 1 && port <= 65535 ? port : null
  }

  // 没写端口就是协议默认值；认不出协议就不猜
  if (/^https:/i.test(url)) return 443
  if (/^http:/i.test(url)) return 80
  return null
}

export async function readProxyPort(run: CommandRunner): Promise<number | null> {
  try {
    const result = await run.exec(proxyLineCommand())
    return parseProxyLine(result.stdout)
  } catch {
    return null
  }
}
