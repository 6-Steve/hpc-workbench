/**
 * 给假集群补上一小套「远端 shell」语义：`test -d` / `du -sb` / `tar -cf -`。
 *
 * 为什么要这个：tar 下载的**成功路径**必须能测——只测"目录不存在时报错"是自欺欺人，
 * 那样 `.partial` 改名、解包路径校验、远端退出码检查全是没跑过的代码。
 *
 * 只实现我们真正发出的那几条命令的形状，不做通用 shell 解析。
 * 认不出来就返回 false 交回给 canned command。
 */
import type { ServerChannel } from 'ssh2'
import { pack as createTar } from 'tar-stream'
import type { FakeCluster } from './fake-cluster'

/**
 * 命令里单引号包起来的所有参数。
 *
 * 注意 `shq()` 只在"需要"时才加引号（路径里没有特殊字符就裸着写），
 * 所以这里**不能只认带引号的**，否则一条正经命令会被判成空参数。
 */
function quotedArgs(command: string): string[] {
  return Array.from(command.matchAll(/'((?:[^']|'\\'')*)'/g)).map((match) => match[1]!.replace(/'\\''/g, "'"))
}

/** 按下标取"第几个路径参数"，带引号优先，没有就按空格切 */
function pathArg(command: string, index: number): string | undefined {
  const quoted = quotedArgs(command)
  if (quoted.length > index) return quoted[index]

  // 退化路径：`test -d /home/user01/out && ...` 这种裸参数
  const tokens = command.split(/\s+/)
  const bare = tokens.filter((token) => token.startsWith('/'))
  return bare[index]
}

/** 目录（含所有子孙）的总字节数，模拟 `du -sb` */
function duBytes(cluster: FakeCluster, dir: string): number {
  const normalized = dir.replace(/\/+$/, '') || '/'
  const prefix = normalized === '/' ? '/' : `${normalized}/`

  let total = 0
  for (const [path, data] of cluster.fs.entries()) {
    if (path.startsWith(prefix)) total += data.length
  }
  // du 会把目录项本身也算进去，给个非零基数更接近真实
  return total + 4096
}

/** 目录下所有文件（去掉目录前缀），按名字排序 */
function listFilesUnder(cluster: FakeCluster, dir: string): Array<{ rel: string; data: Buffer }> {
  const normalized = dir.replace(/\/+$/, '') || '/'
  const prefix = normalized === '/' ? '/' : `${normalized}/`

  const out: Array<{ rel: string; data: Buffer }> = []
  for (const [path, data] of cluster.fs.entries()) {
    if (path.startsWith(prefix)) out.push({ rel: path.slice(prefix.length), data })
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

/**
 * 把一堆文件打成 tar 写进 channel。
 *
 * 两个必须踩对的点：
 * 1. **先 pipe 再写 entry**：`pack.entry()` 的回调要等 entry 被下游读走才触发，
 *    没有下游时写第一条就永久挂住。
 * 2. **逐条 await callback**：tar-stream v2 的 pack 是严格串行的，不等上一条读完就写
 *    下一条会抛错 / 丢数据。
 */
async function streamTar(
  stream: ServerChannel,
  base: string,
  files: Array<{ rel: string; data: Buffer }>
): Promise<void> {
  const pack = createTar()

  const drained = new Promise<void>((resolve, reject) => {
    pack.on('end', resolve)
    pack.on('error', reject)
    pack.pipe(stream, { end: false })
  })

  const writeEntry = (header: Parameters<typeof pack.entry>[0], data?: Buffer): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const entry = pack.entry(header, (err) => (err ? reject(err) : resolve()))
      entry.on('error', reject)
      if (data) entry.end(data)
      else entry.end()
    })

  // 顶层目录项必须在最前面，解包端才有目录结构
  await writeEntry({ name: `${base}/`, type: 'directory', mode: 0o755 })
  for (const file of files) {
    await writeEntry({ name: `${base}/${file.rel}`, size: file.data.length, type: 'file', mode: 0o644 }, file.data)
  }

  pack.finalize()
  await drained

  // tar 格式靠结尾两个 512 字节的全零块判定"归档结束"。
  // 真实 tar 一定会写它们；不补的话 extract 会一直等更多数据。
  await new Promise<void>((resolve) => {
    stream.write(Buffer.alloc(1024), () => resolve())
  })
}

/**
 * 装一个 handleCommand。
 *
 * 支持：
 * - `test -d '<path>' && du -sb '<path>' 2>/dev/null | cut -f1 || echo __missing__`
 * - `tar -cf - -C '<parent>' '<base>'`
 */
export function createShellHandler(
  next?: (command: string, stream: ServerChannel, cluster: FakeCluster) => boolean
): (command: string, stream: ServerChannel, cluster: FakeCluster) => boolean {
  return (command, stream, cluster) => {
    // —— test -d + du ——
    if (command.includes('test -d') && command.includes('du -sb')) {
      const target = pathArg(command, 0)
      if (!target || !cluster.fs.isDir(target)) {
        stream.write('__missing__\n')
        stream.exit(0)
        stream.end()
        return true
      }
      stream.write(`${duBytes(cluster, target)}\n`)
      stream.exit(0)
      stream.end()
      return true
    }

    // —— rm -rf（删除目录时用） ——
    if (command.startsWith('rm -rf ')) {
      const target = pathArg(command, 0)
      if (!target) {
        stream.stderr.write('rm: missing operand\n')
        stream.exit(1)
        stream.end()
        return true
      }
      // 真实 rm -rf 对不存在的路径也返回 0（-f 的含义），这里保持一致
      cluster.fs.removeTree(target)
      stream.exit(0)
      stream.end()
      return true
    }

    // —— tar 打包到 stdout ——
    if (command.startsWith('tar -cf - -C ')) {
      // 形状固定：`tar -cf - -C <parent> <base>`，base 是相对名，不一定带引号
      const quoted = quotedArgs(command)
      const tokens = command.split(/\s+/)
      const parent = quoted[0] ?? tokens[4]
      const base = quoted[1] ?? tokens[5]
      if (!parent || !base) {
        stream.stderr.write('tar: 参数解析失败\n')
        stream.exit(2)
        stream.end()
        return true
      }

      const dir = parent === '/' ? `/${base}` : `${parent}/${base}`
      if (!cluster.fs.isDir(dir)) {
        stream.stderr.write(`tar: ${base}: Cannot open: No such file or directory\n`)
        stream.exit(2)
        stream.end()
        return true
      }

      const files = listFilesUnder(cluster, dir)
      void streamTar(stream, base, files).then(
        () => {
          stream.exit(0)
          // 打完之后必须显式收尾，否则客户端的 channel 永远等不到 close
          stream.end()
        },
        (err: Error) => {
          stream.stderr.write(`tar: ${err.message}\n`)
          stream.exit(1)
          stream.end()
        }
      )
      return true
    }

    return next ? next(command, stream, cluster) : false
  }
}
