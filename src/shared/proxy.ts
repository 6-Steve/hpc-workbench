/**
 * 反向隧道和集群代理之间的那个"隐性约定"。
 *
 * 反向隧道要有人用，集群上的程序必须知道往哪个端口连——实际就是 `http_proxy`
 * 里的那个数字。这个文件把那段命令集中在一处：界面上的提示、文档、以及
 * 反向隧道页的补救办法都用它，避免三处各写一份然后慢慢走偏。
 */

/**
 * 在集群终端里临时把代理指到 `port`（**只对当前这个 shell 生效**）。
 *
 * 为什么要"一次性"这一档：默认端口万一被别人占了，隧道只能开在别的端口上，
 * 这时改 `~/.profile` 是多余的动作——用户可能只是今天要用一下。
 * 临时 export 完就能用，关掉终端就恢复默认。
 */
export function proxyExportSnippet(port: number): string {
  const url = `http://127.0.0.1:${port}`
  return [
    `export http_proxy=${url}`,
    'export https_proxy="$http_proxy" all_proxy="$http_proxy"',
    'export HTTP_PROXY="$http_proxy" HTTPS_PROXY="$http_proxy" ALL_PROXY="$http_proxy"'
  ].join('\n')
}
