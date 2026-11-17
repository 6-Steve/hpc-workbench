/**
 * 拖拽镜像：把远端文件落到本地临时目录，好让系统拖拽能够接管。
 *
 * 为什么需要这一层：`webContents.startDrag()` 只接受**已经在磁盘上**的文件。
 * 远端文件要拖到资源管理器，必须先下载。这是物理限制，绕不过去。
 *
 * 设计取舍（和 WinSCP 一致）：
 * - 第一次拖某个文件 → 现场下载到镜像目录，用户要等
 * - 同一个文件**再拖一次** → 命中缓存，立刻就开始拖，和本地文件一样顺
 *
 * 缓存按「远端大小」判定有效性：大小一致就认为没变。不更严格（不算哈希）
 * 是因为这里只是给拖拽用的临时副本，不是备份；追求的是"够用且快"。
 * 用户真要精确校验，走正式的下载流程。
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, posix } from 'node:path'
import { SshError } from '../ssh/errors'
import type { Session } from '../ssh/session'
import { downloadFile } from './sftp'
import { downloadDirectory } from './tar-download'

/** 所有镜像文件放在这个目录下，退出时不清（下次还能命中） */
export const MIRROR_ROOT = join(tmpdir(), 'hpc-workbench-drag')

export interface PrepareDragOptions {
  onProgress?: (bytes: number, total: number) => void
}

export interface PreparedDrag {
  /** 本地绝对路径，直接喂给 `startDrag` */
  localPath: string
  /** 是否命中了缓存（true 表示没有下载，瞬间返回） */
  cached: boolean
  bytes: number
}

/** 每个远端路径一个稳定目录，避免同名文件互相覆盖 */
function mirrorDirFor(session: Session, remotePath: string): string {
  const key = `${session.profile.id}:${remotePath}`
  const digest = createHash('sha1').update(key).digest('hex').slice(0, 16)
  return join(MIRROR_ROOT, digest)
}

/**
 * 缓存有效性靠「大小 + 远端 mtime」两个一起判。
 *
 * 只比大小是不够的：用户改了一个字符、长度没变，就会拿到旧副本——
 * 拖出去的是过期文件，这比慢更糟。多 stat 一次只花一次往返（几十毫秒），
 * 比重新下载便宜得多。
 *
 * ⚠️ **mtime 只有秒级精度**（SFTP v3 的 STAT 给的是整秒，见 `mtimeMs` 的取整）。
 * 所以"同一秒内、长度不变地改了两次"仍会命中旧缓存。这个窗口接受：
 * 镜像目录在应用启动时就被清空，一次运行里同一秒内原地改同一文件再拖出去，
 * 不是这个功能要照顾的场景。真要更严就得在缓存里存内容摘要，那是另一次往返。
 */
interface MirrorMeta {
  size: number
  mtime: number
}

const META_SUFFIX = '.mirror.json'

async function readMeta(path: string): Promise<MirrorMeta | null> {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as MirrorMeta
    if (typeof parsed.size !== 'number' || typeof parsed.mtime !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 准备一个可拖拽的本地副本。
 *
 * 文件按「大小 + mtime」判断缓存是否有效；目录每次都重新打包
 * （目录内容的缓存判定成本比重新传还高，而且拖目录本身不常见）。
 */
export async function prepareDragFile(
  session: Session,
  remotePath: string,
  options: PrepareDragOptions = {}
): Promise<PreparedDrag> {
  const dir = mirrorDirFor(session, remotePath)
  const name = basename(posix.normalize(remotePath)) || 'item'
  const localPath = join(dir, name)
  const metaPath = `${localPath}${META_SUFFIX}`

  await mkdir(dir, { recursive: true })

  const sftp = await session.sftp()
  const remote = await new Promise<{ isDirectory: boolean; size: number; mtimeMs: number }>((resolve, reject) => {
    sftp.stat(remotePath, (err, stats) => {
      if (err) {
        reject(
          new SshError({
            kind: 'remote',
            message: `读不到远端路径：${remotePath}`,
            hint: '确认文件还在，或者在右侧栏刷新一下。',
            raw: err.message
          })
        )
        return
      }
      resolve({
        isDirectory: stats.isDirectory(),
        size: stats.size,
        mtimeMs: Math.round(stats.mtime * 1000)
      })
    })
  })

  if (remote.isDirectory) {
    // 目录每次重来：先清掉旧镜像，否则 downloadDirectory 会因为目标存在而拒绝
    await rm(localPath, { recursive: true, force: true })
    const result = await downloadDirectory(session, {
      remoteDir: remotePath,
      localDir: localPath
    })
    return { localPath, cached: false, bytes: result.bytes }
  }

  const meta = await readMeta(metaPath)
  const localSize = await stat(localPath).then(
    (info) => info.size,
    () => -1
  )

  const cacheHit = meta !== null && meta.size === remote.size && meta.mtime === remote.mtimeMs && localSize === remote.size
  if (cacheHit) {
    return { localPath, cached: true, bytes: localSize }
  }

  await downloadFile(session, remotePath, localPath, {
    overwrite: true,
    onProgress: options.onProgress ? (sample) => options.onProgress!(sample.bytes, remote.size) : undefined
  })

  const finalSize = await stat(localPath).then(
    (info) => info.size,
    () => 0
  )

  // 记下这次是基于哪个版本拉的，下次才有得比
  await writeFile(metaPath, JSON.stringify({ size: finalSize, mtime: remote.mtimeMs }), 'utf8')

  return { localPath, cached: false, bytes: finalSize }
}

/**
 * 清空所有镜像，返回清掉了多少。
 *
 * 调用时机：**应用启动时**（见 `main/index.ts`）。
 *
 * 为什么是启动时而不是退出时：退出时清理会让"同一个文件再拖一次瞬间开始"这个
 * 缓存完全失去意义——用户下次开机又得重新下载。放在启动时清，等于"每次运行
 * 都从干净状态开始，本次运行内拖多少次都命中缓存"，既不占地方，又保住了手感。
 *
 * 退出时清理还有个隐患：用户可能在别的程序里正打开着镜像文件（比如刚拖到
 * 播放器里），那时删会失败，还得处理一堆占用错误。
 */
export async function clearMirror(): Promise<{ files: number; bytes: number }> {
  const total = await measureDirectory(MIRROR_ROOT).catch(() => ({ files: 0, bytes: 0 }))
  // force 保证目录不存在时不报错；个别文件被占用也跳过，不值得为缓存卡住启动
  await rm(MIRROR_ROOT, { recursive: true, force: true }).catch(() => undefined)
  return total
}

/** 当前镜像占用了多少（给设置页显示用） */
export async function mirrorStats(): Promise<{ files: number; bytes: number }> {
  return measureDirectory(MIRROR_ROOT).catch(() => ({ files: 0, bytes: 0 }))
}

/** 递归统计目录里的文件数和总字节数（只用于打日志） */
async function measureDirectory(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0

  const visit = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        await visit(full)
        continue
      }
      if (entry.isFile()) {
        files += 1
        bytes += (await stat(full).catch(() => ({ size: 0 }))).size
      }
    }
  }

  await visit(dir)
  return { files, bytes }
}
