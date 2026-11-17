/**
 * 文件操作：删除、重命名、新建文件夹。本地与远端各一套。
 *
 * 三条安全约定，比功能本身更重要：
 *
 * 1. **本地删除一律走系统回收站**，不直接 `rm`。删错了还能从回收站捞回来，
 *    这是文件管理器该有的底线。代价是删大目录会慢一点，值得。
 * 2. **远端没有回收站**，删了就没了。所以只能靠护栏 + 界面二次确认兜底：
 *    拒绝对根目录、一级目录、家目录根动手，哪怕参数传错了也不会造成灾难。
 * 3. **目标已存在就拒绝**，绝不静默覆盖。重命名时覆盖掉一个同名文件，
 *    等于用户没做任何操作却丢了数据。
 *
 * `trash` 通过参数注入而不是直接 `import { shell } from 'electron'`：
 * 这样这个模块是纯 Node 的，测试不用起 Electron。
 */
import { cp, mkdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, posix } from 'node:path'
import { SshError } from '../ssh/errors'
import type { Session } from '../ssh/session'
import { shq } from '../ssh/shell'

/** 把系统回收站的能力注进来；返回的 Promise 在文件进回收站后 resolve */
export type TrashFn = (path: string) => Promise<void>

/**
 * 新名字的合法性校验。
 *
 * 用户在输入框里手打名字，很容易打出 `/`、`.`、`..` 这种会改变路径语义的东西。
 * 尤其是 `..`——`rename('a', '..')` 会试图把 a 改成父目录，行为完全不可预期。
 */
export function validateName(name: string): string {
  const trimmed = name.trim()

  if (trimmed.length === 0) {
    throw new SshError({ kind: 'config', message: '名字不能为空', raw: JSON.stringify(name) })
  }
  if (trimmed === '.' || trimmed === '..') {
    throw new SshError({
      kind: 'config',
      message: `"${trimmed}" 不能用作名字`,
      hint: '这是路径里的特殊记号，换个名字。',
      raw: trimmed
    })
  }
  if (/[/\\]/.test(trimmed)) {
    throw new SshError({
      kind: 'config',
      message: '名字里不能有斜杠',
      hint: '要放到别的目录，请先建好目录再传进去。',
      raw: trimmed
    })
  }
  // Windows 的保留字符；远端 Linux 其实允许，但同一个界面两边规则一致更省心
  if (/[<>:"|?*\u0000-\u001f]/.test(trimmed)) {
    throw new SshError({
      kind: 'config',
      message: '名字里有不允许的字符',
      hint: '避开 <>:"|?* 和控制字符。',
      raw: JSON.stringify(trimmed)
    })
  }
  // 以点结尾 Windows 建不出来。注意不能检查"以空格结尾"——
  // 上面的 trim() 已经处理掉了，那种情况是用户误输入，静默修正是对的。
  if (trimmed.endsWith('.')) {
    throw new SshError({
      kind: 'config',
      message: '名字不能以点结尾',
      hint: 'Windows 不允许这样的文件名。',
      raw: JSON.stringify(trimmed)
    })
  }
  if (trimmed.length > 255) {
    throw new SshError({ kind: 'config', message: '名字太长（上限 255 字符）', raw: `${trimmed.length} 字符` })
  }

  return trimmed
}

/**
 * 远端删除路径的护栏。
 *
 * 这是最后一道防线：即使界面传错了参数，也不能让 `rm -rf /home/user` 跑出去。
 * 判断依据是**路径层级**和**家目录**，不依赖调用方自觉。
 */
export function assertSafeRemotePath(path: string, homeDir: string): void {
  const trimmed = path.trim().replace(/\/+$/, '')

  // 原因写进 message：用户第一眼看到的是这一句，不能让他再展开才知道为什么被拒
  const refuse = (reason: string): never => {
    throw new SshError({
      kind: 'config',
      message: `拒绝删除「${path}」：${reason}`,
      hint: '这是防误删的保护。要清理内容，请进入目录后选中具体条目。',
      raw: JSON.stringify({ path, homeDir })
    })
  }

  // 先判空再判绝对路径：'/' 和 '///' 去掉尾部斜杠后都是空串，属于根目录
  if (trimmed === '') refuse('不能删除根目录')
  if (!trimmed.startsWith('/')) refuse('只接受绝对路径')
  if (trimmed.includes('..')) return refuse('路径里不能有 ".."')
  if (/[\n\r\u0000]/.test(trimmed)) return refuse('路径里有控制字符')

  // 一级目录（/home、/tmp、/data…）绝不删
  const depth = trimmed.split('/').filter(Boolean).length
  if (depth < 2) refuse('不能删除一级目录')

  // 家目录根绝不删——这里面有 .ssh、配置文件和所有作业数据
  if (homeDir && trimmed === homeDir.replace(/\/+$/, '')) {
    refuse('不能删除家目录本身')
  }
}

/** 取远端家目录，用于删除前的护栏判断 */
export async function remoteHome(session: Session): Promise<string> {
  const sftp = await session.sftp()
  return new Promise<string>((resolve, reject) => {
    sftp.realpath('.', (err, resolved) => {
      if (err) {
        reject(
          new SshError({
            kind: 'remote',
            message: '取不到远端家目录，为了安全先不执行删除',
            hint: '重连一次再试。',
            raw: err.message
          })
        )
        return
      }
      resolve(resolved)
    })
  })
}

// —— 本地 ——

/**
 * 本地删除。
 *
 * 默认走系统回收站，删错了还能捞回来。
 *
 * `permanent` 是**降级路径**，只在前一次回收站操作失败后由用户二次确认才走：
 * U 盘、网络盘、或系统策略禁用回收站时，`shell.trashItem` 会直接失败。
 * 这时候如果不给一条出路，用户就只能去资源管理器删——那要他这套界面干什么。
 * 但它绝不作为默认，也不静默代替回收站。
 */
export async function deleteLocal(path: string, trash: TrashFn, permanent = false): Promise<void> {
  if (!path.trim()) {
    throw new SshError({ kind: 'config', message: '没有选中要删的东西', raw: JSON.stringify(path) })
  }

  if (permanent) {
    try {
      await rm(path, { recursive: true, force: true })
      return
    } catch (err) {
      throw new SshError({
        kind: 'config',
        message: `永久删除失败：${path}`,
        hint: '文件可能被其他程序占用，或者没有权限。',
        raw: (err as Error).message
      })
    }
  }

  try {
    await trash(path)
  } catch (err) {
    throw new SshError({
      kind: 'config',
      message: `删除失败：${path}`,
      hint: '回收站可能不可用（文件在 U 盘/网络盘，或系统禁用了回收站）。确认不要了的话，可以改用「永久删除」。',
      raw: (err as Error).message
    })
  }
}

/** 本地重命名，返回新路径 */
export async function renameLocal(from: string, newName: string): Promise<string> {
  const name = validateName(newName)
  const target = join(dirname(from), name)

  if (target === from) return from // 名字没变，当作成功

  // 目标已存在就拒绝，不覆盖
  const exists = await stat(target).then(
    () => true,
    () => false
  )
  if (exists) {
    throw new SshError({
      kind: 'config',
      message: `已经有一个叫「${name}」的了`,
      hint: '换个名字。',
      raw: target
    })
  }

  try {
    await rename(from, target)
  } catch (err) {
    throw new SshError({
      kind: 'config',
      message: `重命名失败：${name}`,
      hint: '文件可能被占用，或者没有写权限。',
      raw: (err as Error).message
    })
  }
  return target
}

/**
 * 本地移动（同一块磁盘上的 mv）。跨盘会自动退化成"复制 + 删除"，
 * 那是 `node:fs` 的 rename 自己处理的，这里不用管。
 *
 * 三条必须自己判的规则，和重命名/复制保持同一套语义：
 * 1. **目标已存在就拒绝**——`fs.rename` 在 Windows 上会直接覆盖同名文件
 * 2. **不能移到自己的子目录里**——那样会把整棵树弄成孤儿
 * 3. **源就是目标目录本身**——那是"移到原地"，等于没动，当成功返回
 */
export async function moveLocal(source: string, targetDir: string): Promise<string> {
  const name = basename(source)
  const target = join(targetDir, name)

  // 大小写不敏感的平台：只有大小写不同的路径算同一个，不能再往下走
  if (target === source) return target

  // 源是目录、目标是它的子孙：拼出来的路径里会包含源自身
  const normalizedSource = source.replace(/[\\/]+$/, '').toLowerCase()
  const normalizedTarget = target.replace(/[\\/]+$/, '').toLowerCase()
  if (normalizedTarget.startsWith(`${normalizedSource}\\`) || normalizedTarget.startsWith(`${normalizedSource}/`)) {
    throw new SshError({
      kind: 'config',
      message: '不能把文件夹移到它自己里面',
      hint: '选别的目标目录。',
      raw: `${source} → ${target}`
    })
  }

  const exists = await stat(target).then(
    () => true,
    () => false
  )
  if (exists) {
    throw new SshError({
      kind: 'config',
      message: `目标目录里已经有一个「${name}」了`,
      hint: '先改个名字，或者把它删掉。',
      raw: target
    })
  }

  try {
    await rename(source, target)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    throw new SshError({
      kind: 'config',
      message: `移动失败：${name}`,
      hint:
        code === 'EXDEV'
          ? '跨磁盘移动需要复制再删除，这里没有做，请手动复制。'
          : code === 'EACCES'
            ? '没有写权限。'
            : '文件被占用，或者目标目录不存在。',
      raw: (err as Error).message,
      code
    })
  }

  return target
}

/** 本地新建文件夹，返回新目录路径 */
export async function mkdirLocal(parent: string, rawName: string): Promise<string> {
  const name = validateName(rawName)
  const target = join(parent, name)

  try {
    await mkdir(target)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    throw new SshError({
      kind: 'config',
      message: code === 'EEXIST' ? `已经有一个叫「${name}」的了` : `新建文件夹失败：${name}`,
      hint: code === 'EEXIST' ? '换个名字。' : '检查一下这个目录有没有写权限。',
      raw: (err as Error).message,
      code
    })
  }
  return target
}

/**
 * 把本地路径复制到某个目录。
 *
 * 用途：从集群拖文件到本机栏时，文件已经镜像在本地了，复制过来就等于下载完成。
 * 也顺便支持"本机文件拖到本机另一处"，这是文件管理器该有的能力。
 *
 * 目标同名就拒绝——和重命名保持同一套语义，绝不静默覆盖。
 */
export async function copyLocal(source: string, targetDir: string): Promise<string> {
  const name = basename(source)
  const target = join(targetDir, name)

  if (target === source) {
    throw new SshError({
      kind: 'config',
      message: '源和目标在同一位置',
      hint: '拖到别的目录才有意义。',
      raw: source
    })
  }

  const exists = await stat(target).then(
    () => true,
    () => false
  )
  if (exists) {
    throw new SshError({
      kind: 'config',
      message: `目标目录里已经有一个「${name}」了`,
      hint: '先删掉旧的，或者改成下载到别的目录。',
      raw: target
    })
  }

  try {
    await cp(source, target, { recursive: true, errorOnExist: true, force: false })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    throw new SshError({
      kind: 'config',
      message: `复制失败：${name}`,
      hint: code === 'EACCES' ? '没有写权限。' : '文件可能被占用，或者磁盘空间不够。',
      raw: (err as Error).message,
      code
    })
  }

  return target
}

// —— 远端 ——

/** SFTP 的错误对象运行时带 SFTP 状态码（2 = No such file），但 ssh2 的类型定义里没写 */
function sftpCode(err: Error): number | undefined {
  return (err as Error & { code?: number }).code
}

/**
 * 远端删除。
 *
 * 文件用 `unlink`（精确、可读）；目录用 `rm -rf`，因为 SFTP 的 rmdir
 * 只能删空目录，逐个递归又要成百上千次往返，不值得。
 * 走 `rm -rf` 就必须靠 `assertSafeRemotePath` 把路径钉死。
 */
export async function deleteRemote(session: Session, path: string, homeDir: string): Promise<void> {
  assertSafeRemotePath(path, homeDir)

  const sftp = await session.sftp()
  const info = await new Promise<{ isDirectory: boolean } | null>((resolve, reject) => {
    sftp.stat(path, (err, stats) => {
      if (err) {
        // 不存在就当已删掉，幂等
        if (sftpCode(err) === 2 || /No such file/i.test(err.message)) resolve(null)
        else reject(new SshError({ kind: 'remote', message: `读不到：${path}`, raw: err.message }))
        return
      }
      resolve({ isDirectory: stats.isDirectory() })
    })
  })

  if (info === null) return

  if (info.isDirectory) {
    const result = await session.exec(`rm -rf ${shq(path)}`, { timeoutMs: 120_000 })
    if (result.code !== 0) {
      throw new SshError({
        kind: 'remote',
        message: `删除目录失败（退出码 ${result.code ?? 'null'}）`,
        hint: '可能某个子目录没有写权限。',
        raw: [`$ rm -rf ${path}`, result.stderr.trim() || '（无输出）'].join('\n'),
        code: String(result.code)
      })
    }
    return
  }

  await new Promise<void>((resolve, reject) => {
    sftp.unlink(path, (err) => {
      if (err) {
        reject(new SshError({ kind: 'remote', message: `删除失败：${path}`, raw: err.message }))
        return
      }
      resolve()
    })
  })
}

/** 远端重命名，返回新路径 */
export async function renameRemote(session: Session, from: string, newName: string): Promise<string> {
  const name = validateName(newName)
  const target = posix.join(posix.dirname(from), name)

  if (target === from) return from

  const sftp = await session.sftp()

  // 目标已存在就拒绝。SFTP 的 RENAME 在 OpenSSH 上会直接覆盖，
  // 不先查一遍等于悄悄吃掉用户的数据。
  const exists = await new Promise<boolean>((resolve, reject) => {
    sftp.stat(target, (err) => {
      if (err) {
        if (sftpCode(err) === 2 || /No such file/i.test(err.message)) resolve(false)
        else reject(new SshError({ kind: 'remote', message: `读不到：${target}`, raw: err.message }))
        return
      }
      resolve(true)
    })
  })
  if (exists) {
    throw new SshError({
      kind: 'config',
      message: `远端已经有一个叫「${name}」的了`,
      hint: '换个名字。',
      raw: target
    })
  }

  await new Promise<void>((resolve, reject) => {
    sftp.rename(from, target, (err) => {
      if (err) {
        reject(new SshError({ kind: 'remote', message: `重命名失败：${name}`, raw: err.message }))
        return
      }
      resolve()
    })
  })
  return target
}

/** 远端新建文件夹，返回新目录路径 */
export async function mkdirRemote(session: Session, parent: string, rawName: string): Promise<string> {
  const name = validateName(rawName)
  const target = posix.join(parent, name)
  const sftp = await session.sftp()

  await new Promise<void>((resolve, reject) => {
    sftp.mkdir(target, (err) => {
      if (err) {
        reject(
          new SshError({
            kind: 'remote',
            message: `新建文件夹失败：${name}`,
            hint: /exist/i.test(err.message) ? '这个目录已经存在了。' : '检查一下父目录的写权限。',
            raw: err.message
          })
        )
        return
      }
      resolve()
    })
  })
  return target
}

/**
 * 远端移动。
 *
 * 用 SFTP 的 `rename`，它在集群上就是 `mv`，同一个文件系统内是原子的。
 *
 * ⚠️ 不判断"目标是不是已经存在"是不行的：SFTP 的 RENAME 在 OpenSSH 上
 * **会直接覆盖**同名文件，等于悄悄吃掉用户的数据。必须先 stat。
 * （远端没有回收站，这里覆盖了就真没了。）
 *
 * 同理，也不允许把一个目录移进它自己的子孙里——SFTP 会照做不误，
 * 结果子树从原位置消失、新位置又挂在自己下面，整个目录结构废掉。
 */
export async function moveRemote(session: Session, source: string, targetDir: string): Promise<string> {
  const name = posix.basename(source)
  const target = posix.join(targetDir, name)

  if (target === source) return target

  const normalizedSource = source.replace(/\/+$/, '')
  if (target === normalizedSource || target.startsWith(`${normalizedSource}/`)) {
    throw new SshError({
      kind: 'config',
      message: '不能把文件夹移到它自己里面',
      hint: '选别的目标目录。',
      raw: `${source} → ${target}`
    })
  }

  const sftp = await session.sftp()

  const exists = await new Promise<boolean>((resolve, reject) => {
    sftp.stat(target, (err) => {
      if (err) {
        if (sftpCode(err) === 2 || /No such file/i.test(err.message)) resolve(false)
        else reject(new SshError({ kind: 'remote', message: `读不到：${target}`, raw: err.message }))
        return
      }
      resolve(true)
    })
  })
  if (exists) {
    throw new SshError({
      kind: 'config',
      message: `目标目录里已经有一个「${name}」了`,
      hint: '先改个名字，或者把它删掉。',
      raw: target
    })
  }

  await new Promise<void>((resolve, reject) => {
    sftp.rename(source, target, (err) => {
      if (err) {
        reject(
          new SshError({
            kind: 'remote',
            message: `移动失败：${name}`,
            hint: '可能是没有写权限，或者目标目录不在同一个文件系统上。',
            raw: err.message
          })
        )
        return
      }
      resolve()
    })
  })

  return target
}
