/**
 * 假集群：进程内的 ssh2 Server，提供 exec 与 SFTP 两个子系统。
 *
 * 用途只有一个——让连接层和传输层能被自动化测试覆盖。
 * 假集群的 CLI 返回值与 `fixtures/` 里的真实样本保持一致，**不要在这里编造格式**。
 */
import { posix } from 'node:path'
import { Server, type Attributes, type ServerChannel, type SFTPWrapper } from 'ssh2'
import type { AddressInfo } from 'node:net'
import { makeTestKey } from './test-key'

/** SFTP 状态码（draft-ietf-secsh-filexfer），ssh2 没有导出这些常量 */
const STATUS = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4
} as const

/** OPEN 的 flags 位（同上，协议常量） */
const OPEN = {
  READ: 0x0001,
  WRITE: 0x0002,
  APPEND: 0x0004,
  CREAT: 0x0008,
  TRUNC: 0x0010,
  EXCL: 0x0020
} as const

export interface CannedCommand {
  stdout?: string
  stderr?: string
  code: number
}

/**
 * 内存文件系统。只实现传输层用得到的那部分语义。
 * 路径一律 POSIX 绝对路径，父目录自动补齐（省得每个用例都先 mkdir）。
 */
export class MemoryFs {
  private readonly files = new Map<string, Buffer>()
  /** 每个文件的修改时间（毫秒）。真实 SFTP 的 STAT 会返回它，缓存校验靠这个 */
  private readonly mtimes = new Map<string, number>()
  private readonly dirs = new Set<string>(['/'])
  /** 记录 MKDIR 调用，用来断言"该建目录时真的建了" */
  readonly mkdirCalls: string[] = []
  /** 记录 OPENDIR 调用，用来断言缓存有没有真的省掉一次读目录 */
  readonly opendirCalls: string[] = []
  /** 测试用：超过这个长度的写入会被截断，模拟"远端悄悄少写了" */
  limitSize?: number

  constructor(initialFiles: Record<string, string | Buffer> = {}) {
    for (const [path, content] of Object.entries(initialFiles)) {
      this.write(path, Buffer.isBuffer(content) ? content : Buffer.from(content))
    }
  }

  static normalise(path: string): string {
    const collapsed = path.replace(/\/+/g, '/')
    if (collapsed === '/') return '/'
    return collapsed.replace(/\/$/, '')
  }

  read(path: string): Buffer | undefined {
    return this.files.get(MemoryFs.normalise(path))
  }

  /** 只读遍历所有文件（假 shell 实现 `du`、`tar` 时需要）；不要拿它改内容 */
  entries(): Array<[string, Buffer]> {
    return [...this.files.entries()]
  }

  write(path: string, data: Buffer): void {
    const target = MemoryFs.normalise(path)
    this.ensureParent(target)
    this.files.set(target, data)
    this.mtimes.set(target, Date.now())
  }

  writeAt(path: string, offset: number, data: Buffer): boolean {
    const target = MemoryFs.normalise(path)
    if (!this.parentExists(target)) return false
    const current = this.files.get(target) ?? Buffer.alloc(0)
    const size = Math.max(current.length, offset + data.length)
    const full = Buffer.alloc(size)
    current.copy(full, 0)
    data.copy(full, offset)
    // 模拟"写请求都返回成功，但远端实际少写了"
    const next = this.limitSize === undefined ? full : full.subarray(0, Math.min(full.length, this.limitSize))
    this.files.set(target, next)
    this.mtimes.set(target, Date.now())
    return true
  }

  /** 父目录是否存在——真实 SFTP 里这是 write 的前提，不自动补齐 */
  parentExists(path: string): boolean {
    const parent = posix.dirname(MemoryFs.normalise(path))
    return parent === '/' || this.dirs.has(parent)
  }

  isDir(path: string): boolean {
    return this.dirs.has(MemoryFs.normalise(path))
  }

  isFile(path: string): boolean {
    return this.files.has(MemoryFs.normalise(path))
  }

  size(path: string): number | undefined {
    return this.files.get(MemoryFs.normalise(path))?.length
  }

  /** 文件修改时间（毫秒）；目录或不存在时返回 undefined */
  mtimeOf(path: string): number | undefined {
    return this.mtimes.get(MemoryFs.normalise(path))
  }

  /**
   * 把某个文件的 mtime 定到指定毫秒。
   *
   * ## 为什么测试需要这个
   *
   * 真实 SFTP 的 STAT 只给**秒级** mtime（见 `attrsFor` 里的注释），本假集群照抄这一点。
   * 而测试里"改一次远端文件"是毫秒级操作：`write() → Date.now()`，很可能和上一步
   * 落在**同一秒**。于是任何"按 mtime 判缓存"的用例都会变成掷骰子——
   * 我实测同一个用例先连过两次、第三次挂掉，查了半天以为代码有回归。
   *
   * 用它把时间戳定死，用例就不再依赖墙上时钟。
   */
  setMtime(path: string, mtimeMs: number): void {
    this.mtimes.set(MemoryFs.normalise(path), mtimeMs)
  }

  mkdir(path: string): 'ok' | 'exists' {
    const target = MemoryFs.normalise(path)
    if (this.dirs.has(target)) return 'exists'
    this.ensureParent(target)
    this.dirs.add(target)
    this.mkdirCalls.push(target)
    return 'ok'
  }

  rename(from: string, to: string): boolean {
    const source = MemoryFs.normalise(from)
    const target = MemoryFs.normalise(to)

    const file = this.files.get(source)
    if (file) {
      this.files.delete(source)
      this.ensureParent(target)
      this.files.set(target, file)
      return true
    }
    if (this.dirs.has(source)) {
      this.dirs.delete(source)
      this.dirs.add(target)
      return true
    }
    return false
  }

  unlink(path: string): boolean {
    return this.files.delete(MemoryFs.normalise(path))
  }

  /** 模拟 `rm -rf`：删掉路径本身及其所有子孙 */
  removeTree(path: string): boolean {
    const target = MemoryFs.normalise(path)
    const prefix = `${target}/`
    let touched = false

    for (const key of [...this.files.keys()]) {
      if (key === target || key.startsWith(prefix)) {
        this.files.delete(key)
        touched = true
      }
    }
    for (const dir of [...this.dirs]) {
      if (dir === target || dir.startsWith(prefix)) {
        this.dirs.delete(dir)
        touched = true
      }
    }
    return touched
  }

  /** 列目录（不含 . / ..），供假 SFTP 的 READDIR 用 */
  list(path: string): Array<{ name: string; isDir: boolean; size: number }> {
    const target = MemoryFs.normalise(path)
    if (!this.dirs.has(target)) return []

    const prefix = target === '/' ? '/' : `${target}/`
    const out: Array<{ name: string; isDir: boolean; size: number }> = []
    const seen = new Set<string>()

    for (const [filePath, buffer] of this.files) {
      if (!filePath.startsWith(prefix)) continue
      const rest = filePath.slice(prefix.length)
      if (rest.includes('/')) continue
      out.push({ name: rest, isDir: false, size: buffer.length })
      seen.add(rest)
    }

    for (const dir of this.dirs) {
      if (dir === target || !dir.startsWith(prefix)) continue
      const rest = dir.slice(prefix.length)
      if (rest.includes('/') || seen.has(rest)) continue
      out.push({ name: rest, isDir: true, size: 4096 })
    }

    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  private ensureParent(path: string): void {
    let parent = posix.dirname(path)
    while (parent !== '/' && parent !== '.') {
      this.dirs.add(parent)
      parent = posix.dirname(parent)
    }
  }
}

export interface FakeClusterOptions {
  /** 预置的 CLI 返回，key 是完整命令 */
  commands?: Record<string, CannedCommand>
  /** 需要读 stdin 或特殊处理的命令；返回 true 表示已接手 */
  handleCommand?: (command: string, stream: ServerChannel, cluster: FakeCluster) => boolean
  /** 预置的远端文件 */
  files?: Record<string, string | Buffer>
}

export interface FakeCluster {
  port: number
  fs: MemoryFs
  close(): Promise<void>
}

/** 起一个假集群。调用方负责 close()。 */
export async function createFakeCluster(options: FakeClusterOptions = {}): Promise<FakeCluster> {
  const fs = new MemoryFs(options.files)
  const hostKey = makeTestKey()

  const cluster: FakeCluster = {
    port: 0,
    fs,
    close: async () => {}
  }

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    // 客户端拒绝主机指纹时会主动断开，服务端会抛 KEY_EXCHANGE_FAILED。
    // 这是预期行为，在测试脚手架里吞掉，免得变成未捕获异常。
    client.on('error', () => {})

    client.on('authentication', (ctx) => {
      if (ctx.method === 'publickey') ctx.accept()
      else if (ctx.method === 'none') ctx.reject(['publickey'])
      else ctx.reject()
    })

    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession()

        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec()

          if (options.handleCommand?.(info.command, stream, cluster)) return

          const canned = options.commands?.[info.command] ?? {
            stderr: `bash: ${info.command}: command not found\n`,
            code: 127
          }
          if (canned.stdout) stream.write(canned.stdout)
          if (canned.stderr) stream.stderr.write(canned.stderr)
          stream.exit(canned.code)
          stream.end()
        })

        session.on('sftp', (acceptSftp) => {
          attachSftp(acceptSftp(), fs)
        })
      })
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cluster.port = (server.address() as AddressInfo).port
  cluster.close = () => new Promise<void>((resolve) => server.close(() => resolve()))

  return cluster
}

/** 极简 SFTP 服务端：够 fastPut / fastGet / stat / mkdir / rename / unlink 用 */
function attachSftp(sftp: SFTPWrapper, fs: MemoryFs): void {
  const handles = new Map<number, { path: string; kind: 'file' | 'dir'; sent: boolean }>()
  let nextHandle = 1

  const now = (): number => Math.floor(Date.now() / 1000)

  const attrsFor = (path: string): Attributes | null => {
    if (fs.isDir(path)) {
      return { mode: 0o040755, uid: 1000, gid: 1000, size: 4096, atime: now(), mtime: now() }
    }
    const size = fs.size(path)
    if (size === undefined) return null
    // mtime 必须是**文件的**修改时间，不能每次 stat 返回 now()：
    // 真实 SFTP 就是这么给的，用 now() 会让"按 mtime 判缓存"永远失效
    const mtimeMs = fs.mtimeOf(path) ?? Date.now()
    return { mode: 0o100644, uid: 1000, gid: 1000, size, atime: now(), mtime: Math.floor(mtimeMs / 1000) }
  }

  sftp.on('REALPATH', (reqId: number, path: string) => {
    // `.` 模拟远端 home，和真实 sshd 的行为一致
    const resolved = path === '.' || path === '' ? '/home/user01' : MemoryFs.normalise(path)
    const attrs = attrsFor(resolved) ?? { mode: 0o040755, uid: 1000, gid: 1000, size: 4096, atime: now(), mtime: now() }
    sftp.name(reqId, [{ filename: resolved, longname: resolved, attrs }])
  })

  sftp.on('STAT', (reqId: number, path: string) => {
    const attrs = attrsFor(path)
    if (!attrs) return sftp.status(reqId, STATUS.NO_SUCH_FILE)
    sftp.attrs(reqId, attrs)
  })

  sftp.on('LSTAT', (reqId: number, path: string) => {
    const attrs = attrsFor(path)
    if (!attrs) return sftp.status(reqId, STATUS.NO_SUCH_FILE)
    sftp.attrs(reqId, attrs)
  })

  sftp.on('OPEN', (reqId: number, filename: string, flags: number) => {
    const path = MemoryFs.normalise(filename)
    const wantsWrite = (flags & (OPEN.WRITE | OPEN.APPEND | OPEN.CREAT)) !== 0
    const exists = fs.isFile(path)

    if ((flags & OPEN.EXCL) !== 0 && exists) return sftp.status(reqId, STATUS.FAILURE)
    if (!wantsWrite && !exists) return sftp.status(reqId, STATUS.NO_SUCH_FILE)

    if (wantsWrite) {
      // 父目录不存在时真实 SFTP 会失败，这里保持一致：
      // 上传到没建过的目录必须先 MKDIR（正好验证 ensureRemoteDir 真的干活了）
      if (!fs.parentExists(path)) return sftp.status(reqId, STATUS.FAILURE)
      if ((flags & OPEN.TRUNC) !== 0 || !exists) fs.write(path, Buffer.alloc(0))
      // APPEND 用不到（fastPut 用绝对偏移写），先不模拟
    }

    const id = nextHandle++
    handles.set(id, { path, kind: 'file', sent: false })
    const handle = Buffer.alloc(4)
    handle.writeUInt32BE(id, 0)
    sftp.handle(reqId, handle)
  })

  sftp.on('WRITE', (reqId: number, handle: Buffer, offset: number, data: Buffer) => {
    const entry = handles.get(handle.readUInt32BE(0))
    if (!entry) return sftp.status(reqId, STATUS.FAILURE)
    sftp.status(reqId, fs.writeAt(entry.path, offset, data) ? STATUS.OK : STATUS.FAILURE)
  })

  sftp.on('READ', (reqId: number, handle: Buffer, offset: number, length: number) => {
    const entry = handles.get(handle.readUInt32BE(0))
    if (!entry) return sftp.status(reqId, STATUS.FAILURE)

    const content = fs.read(entry.path) ?? Buffer.alloc(0)
    if (offset >= content.length) return sftp.status(reqId, STATUS.EOF)
    sftp.data(reqId, content.subarray(offset, Math.min(offset + length, content.length)))
  })

  sftp.on('FSTAT', (reqId: number, handle: Buffer) => {
    const entry = handles.get(handle.readUInt32BE(0))
    if (!entry) return sftp.status(reqId, STATUS.FAILURE)
    const attrs = attrsFor(entry.path)
    if (!attrs) return sftp.status(reqId, STATUS.NO_SUCH_FILE)
    sftp.attrs(reqId, attrs)
  })

  sftp.on('FSETSTAT', (reqId: number) => sftp.status(reqId, STATUS.OK))
  sftp.on('SETSTAT', (reqId: number) => sftp.status(reqId, STATUS.OK))

  sftp.on('CLOSE', (reqId: number, handle: Buffer) => {
    handles.delete(handle.readUInt32BE(0))
    sftp.status(reqId, STATUS.OK)
  })

  sftp.on('MKDIR', (reqId: number, path: string) => {
    const result = fs.mkdir(path)
    sftp.status(reqId, result === 'ok' ? STATUS.OK : STATUS.FAILURE)
  })

  sftp.on('RENAME', (reqId: number, oldPath: string, newPath: string) => {
    sftp.status(reqId, fs.rename(oldPath, newPath) ? STATUS.OK : STATUS.NO_SUCH_FILE)
  })

  // 注意：删文件的事件名是 REMOVE（SSH_FXP_REMOVE），不是 UNLINK
  sftp.on('REMOVE', (reqId: number, path: string) => {
    sftp.status(reqId, fs.unlink(path) ? STATUS.OK : STATUS.NO_SUCH_FILE)
  })

  sftp.on('OPENDIR', (reqId: number, path: string) => {
    if (!fs.isDir(path)) return sftp.status(reqId, STATUS.NO_SUCH_FILE)
    // 记一笔：测缓存时靠这个判断"到底真读了几次"
    fs.opendirCalls.push(MemoryFs.normalise(path))
    const id = nextHandle++
    handles.set(id, { path: MemoryFs.normalise(path), kind: 'dir', sent: false })
    const handle = Buffer.alloc(4)
    handle.writeUInt32BE(id, 0)
    sftp.handle(reqId, handle)
  })

  sftp.on('READDIR', (reqId: number, handle: Buffer) => {
    const entry = handles.get(handle.readUInt32BE(0))
    if (!entry || entry.kind !== 'dir') return sftp.status(reqId, STATUS.FAILURE)

    // 一次给全，第二次调用就 EOF——真实 SFTP 可以分批，这里没必要
    if (entry.sent) return sftp.status(reqId, STATUS.EOF)
    entry.sent = true

    sftp.name(
      reqId,
      fs.list(entry.path).map((item) => ({
        filename: item.name,
        longname: item.name,
        attrs: {
          mode: item.isDir ? 0o040755 : 0o100644,
          uid: 1000,
          gid: 1000,
          size: item.size,
          atime: now(),
          mtime: now()
        }
      }))
    )
  })
}
