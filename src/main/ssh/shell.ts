/**
 * Shell 参数转义。
 *
 * 任何要把"变量"拼进远端命令的地方都必须过这里：
 * SFTP 与 tar 天然安全，真正容易手滑的是"建目录""改权限""test -x"这类拼接。
 * 远程一律是 POSIX shell，用单引号包裹 + 转义内部单引号是最稳的做法。
 */
export function shq(value: string): string {
  if (value === '') return "''"
  // 只含安全字符时不必加引号，便于日志可读
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** 从一条完整命令里取出可执行文件路径（用于 `test -x`），不解析参数
 *
 *  约定：二进制路径本身不能含空格（Linux 上不现实，真遇到了请改成绝对路径 + 符号链接）。
 *  参数里可以有空格，这里只取第一段。
 */
export function commandBinary(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? ''
  return first
}
