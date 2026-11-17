/**
 * 从拖放事件的 `text/uri-list` 里解析出本地路径。
 *
 * 为什么要这条兜底路：主路是 `webUtils.getPathForFile(file)`，
 * 它需要把渲染进程的 `File` 对象穿过 contextBridge 传到 preload。
 * 这条路在 Electron 官方示例里是标准写法，但它依赖 File 对象在隔离世界之间
 * 保持内部关联——一旦某个版本行为变了，表现就是"全部返回空串"，
 * 用户只会看到"拖进去没反应"，很难排查。
 *
 * `text/uri-list` 是 Chromium 在拖放时另外附带的一份纯文本（`file:///C:/a.txt`），
 * 不依赖任何跨 context 的对象传递，所以留它当第二道。
 *
 * 注意：这是**兜底**，不是主路。uri-list 在部分场景（虚拟文件、压缩包内拖动）
 * 本来就没有内容，两条都空时要如实报错。
 */

/** URI 列表里可能有注释行（以 # 开头）和空行，都要跳过 */
export function parseUriList(raw: string): string[] {
  if (!raw || raw.trim().length === 0) return []

  const paths: string[] = []

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    if (!trimmed.toLowerCase().startsWith('file://')) continue

    const path = fileUrlToPath(trimmed)
    if (path) paths.push(path)
  }

  return paths
}

/**
 * `file:///C:/Users/a.txt` → `C:\Users\a.txt`
 * `file:///home/user/a.txt` → `/home/user/a.txt`
 *
 * 不用 `new URL().pathname`：它在 Windows 上会给出 `/C:/Users/...` 这种带前导斜杠的
 * 形式，还要再剥一层，反而不如自己处理直观。
 */
export function fileUrlToPath(url: string): string | null {
  try {
    const withoutScheme = decodeURIComponent(url.replace(/^file:\/\//i, ''))
    if (withoutScheme.length === 0) return null

    // Windows：/C:/Users/... → C:/Users/...
    if (/^\/[a-zA-Z]:/.test(withoutScheme)) return withoutScheme.slice(1)

    // 单斜杠开头的是 UNC 之前的形态，保留；其余原样返回
    return withoutScheme
  } catch {
    // decodeURIComponent 遇到畸形转义会抛，这种条目直接放弃
    return null
  }
}
