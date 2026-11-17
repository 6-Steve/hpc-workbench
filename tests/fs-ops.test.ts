import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  assertSafeRemotePath,
  copyLocal,
  deleteLocal,
  deleteRemote,
  mkdirLocal,
  mkdirRemote,
  moveLocal,
  moveRemote,
  remoteHome,
  renameLocal,
  renameRemote,
  validateName,
  type TrashFn
} from '../src/main/fs/ops'
import { validateProfiles } from '../src/main/profiles'
import { KnownHostsStore } from '../src/main/ssh/known-hosts'
import { Session } from '../src/main/ssh/session'
import { createFakeCluster, type FakeCluster } from './helpers/fake-cluster'
import { createShellHandler } from './helpers/remote-shell'
import { makeTestKey } from './helpers/test-key'

describe('validateName：新名字校验', () => {
  it('普通名字放行，前后空格自动去掉', () => {
    expect(validateName('data.txt')).toBe('data.txt')
    expect(validateName('  结果 2026.csv  ')).toBe('结果 2026.csv')
  })

  it('拒绝空名字', () => {
    expect(() => validateName('')).toThrow(/不能为空/)
    expect(() => validateName('   ')).toThrow(/不能为空/)
  })

  it('拒绝 . 和 ..：它们会改变路径语义', () => {
    // rename('a', '..') 等于试图把 a 改成父目录，行为完全不可预期
    expect(() => validateName('.')).toThrow(/不能用作名字/)
    expect(() => validateName('..')).toThrow(/不能用作名字/)
  })

  it('拒绝含斜杠的名字', () => {
    expect(() => validateName('a/b')).toThrow(/斜杠/)
    expect(() => validateName('a\\b')).toThrow(/斜杠/)
  })

  it('拒绝 Windows 保留字符与控制字符', () => {
    expect(() => validateName('a<b')).toThrow(/不允许的字符/)
    expect(() => validateName('a|b')).toThrow(/不允许的字符/)
    expect(() => validateName('a\u0001b')).toThrow(/不允许的字符/)
  })

  it('拒绝以点结尾（Windows 建不出来）', () => {
    expect(() => validateName('abc.')).toThrow(/以点结尾/)
  })

  it('前后空格静默修掉，不算错误', () => {
    // 用户手打名字时带空格很常见，修正比报错更有用
    expect(validateName('abc ')).toBe('abc')
    expect(validateName(' abc')).toBe('abc')
  })

  it('拒绝超长名字', () => {
    expect(() => validateName('a'.repeat(256))).toThrow(/太长/)
    expect(validateName('a'.repeat(255))).toHaveLength(255)
  })
})

describe('assertSafeRemotePath：远端删除护栏', () => {
  const HOME = '/home/user01'

  it('正常路径放行', () => {
    expect(() => assertSafeRemotePath('/home/user01/data/run.log', HOME)).not.toThrow()
    expect(() => assertSafeRemotePath('/tmp/foo', HOME)).not.toThrow()
  })

  it('拒绝根目录', () => {
    expect(() => assertSafeRemotePath('/', HOME)).toThrow(/根目录/)
    expect(() => assertSafeRemotePath('///', HOME)).toThrow(/根目录/)
  })

  it('拒绝一级目录', () => {
    // /home /tmp /data 这种删掉会波及所有人
    expect(() => assertSafeRemotePath('/home', HOME)).toThrow(/一级目录/)
    expect(() => assertSafeRemotePath('/tmp', HOME)).toThrow(/一级目录/)
  })

  it('拒绝家目录本身，但放行家目录里的东西', () => {
    expect(() => assertSafeRemotePath('/home/user01', HOME)).toThrow(/家目录本身/)
    expect(() => assertSafeRemotePath('/home/user01/', HOME)).toThrow(/家目录本身/)
    expect(() => assertSafeRemotePath('/home/user01/out.txt', HOME)).not.toThrow()
  })

  it('拒绝相对路径和带 .. 的路径', () => {
    expect(() => assertSafeRemotePath('home/user01/x', HOME)).toThrow(/绝对路径/)
    expect(() => assertSafeRemotePath('/home/user01/../user02/x', HOME)).toThrow(/\.\./)
  })

  it('拒绝带换行的路径：防止命令注入', () => {
    expect(() => assertSafeRemotePath('/home/user01/a\nrm -rf /', HOME)).toThrow(/控制字符|一级目录|家目录/)
  })

  it('没传 homeDir 时也要拦住根和一级目录', () => {
    expect(() => assertSafeRemotePath('/', '')).toThrow()
    expect(() => assertSafeRemotePath('/home', '')).toThrow()
  })
})

describe('本地文件操作', () => {
  let workDir: string

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'hpc-ops-local-'))
  })

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  it('删除走回收站，不是直接 rm', async () => {
    const file = join(workDir, 'to-trash.txt')
    writeFileSync(file, 'bye')

    const trash = vi.fn<TrashFn>(async () => {})
    await deleteLocal(file, trash)

    // 关键断言：调的是回收站，文件还在（真实 shell.trashItem 会移动它）
    expect(trash).toHaveBeenCalledWith(file)
    expect(existsSync(file)).toBe(true)
  })

  it('回收站失败时归一化成可读错误', async () => {
    const trash: TrashFn = async () => {
      throw new Error('EBUSY: resource busy')
    }
    await expect(deleteLocal(join(workDir, 'x.txt'), trash)).rejects.toThrow(/删除失败/)
  })

  it('默认绝不动用永久删除', async () => {
    // 这是安全底线：不管 trash 成不成功，不传 permanent 就不能走 rm
    const file = join(workDir, 'never-hard-deleted.txt')
    writeFileSync(file, 'x')
    const trash: TrashFn = async () => {}

    await deleteLocal(file, trash)
    expect(existsSync(file)).toBe(true)
  })

  it('明确传 permanent 才真的删掉，且不碰回收站', async () => {
    const file = join(workDir, 'hard.txt')
    writeFileSync(file, 'x')

    const trash = vi.fn<TrashFn>(async () => {})
    await deleteLocal(file, trash, true)

    expect(existsSync(file)).toBe(false)
    expect(trash).not.toHaveBeenCalled()
  })

  it('重命名成功，返回新路径', async () => {
    const file = join(workDir, 'old.txt')
    writeFileSync(file, 'content')

    const next = await renameLocal(file, 'new.txt')
    expect(next).toBe(join(workDir, 'new.txt'))
    expect(readFileSync(next, 'utf8')).toBe('content')
  })

  it('重命名时目标已存在就拒绝，不覆盖', async () => {
    const a = join(workDir, 'a.txt')
    const b = join(workDir, 'b.txt')
    writeFileSync(a, 'AAA')
    writeFileSync(b, 'BBB')

    await expect(renameLocal(a, 'b.txt')).rejects.toThrow(/已经有一个/)
    // 两个文件的内容都不能变
    expect(readFileSync(a, 'utf8')).toBe('AAA')
    expect(readFileSync(b, 'utf8')).toBe('BBB')
  })

  it('新建文件夹成功', async () => {
    const created = await mkdirLocal(workDir, '新目录')
    expect(existsSync(created)).toBe(true)
  })

  it('新建同名文件夹时报错说清楚', async () => {
    mkdirSync(join(workDir, 'dup'), { recursive: true })
    await expect(mkdirLocal(workDir, 'dup')).rejects.toThrow(/已经有一个/)
  })

  it('复制文件到另一个目录', async () => {
    const src = join(workDir, 'copy-src.txt')
    writeFileSync(src, 'hello')
    const destDir = join(workDir, 'copy-dest')
    mkdirSync(destDir, { recursive: true })

    const target = await copyLocal(src, destDir)
    expect(target).toBe(join(destDir, 'copy-src.txt'))
    expect(readFileSync(target, 'utf8')).toBe('hello')
    // 源文件必须还在（复制不是移动）
    expect(existsSync(src)).toBe(true)
  })

  it('复制目录会带上里面的内容', async () => {
    const srcDir = join(workDir, 'dir-src')
    mkdirSync(join(srcDir, 'inner'), { recursive: true })
    writeFileSync(join(srcDir, 'a.txt'), 'A')
    writeFileSync(join(srcDir, 'inner', 'b.txt'), 'B')

    const destDir = join(workDir, 'dir-dest')
    mkdirSync(destDir, { recursive: true })

    const target = await copyLocal(srcDir, destDir)
    expect(readFileSync(join(target, 'a.txt'), 'utf8')).toBe('A')
    expect(readFileSync(join(target, 'inner', 'b.txt'), 'utf8')).toBe('B')
  })

  it('目标同名时拒绝，不覆盖已有文件', async () => {
    const src = join(workDir, 'clash-src.txt')
    writeFileSync(src, 'NEW')
    const destDir = join(workDir, 'clash-dest')
    mkdirSync(destDir, { recursive: true })
    writeFileSync(join(destDir, 'clash-src.txt'), 'OLD')

    await expect(copyLocal(src, destDir)).rejects.toThrow(/已经有一个/)
    // 旧内容不能被改掉
    expect(readFileSync(join(destDir, 'clash-src.txt'), 'utf8')).toBe('OLD')
  })

  it('源和目标相同直接拒绝，不做无意义的自我复制', async () => {
    const src = join(workDir, 'self.txt')
    writeFileSync(src, 'x')
    await expect(copyLocal(src, workDir)).rejects.toThrow(/同一位置/)
  })

  it('移动文件：内容不变，源位置没了', async () => {
    const srcDir = join(workDir, 'mv-a')
    const destDir = join(workDir, 'mv-b')
    mkdirSync(srcDir, { recursive: true })
    mkdirSync(destDir, { recursive: true })
    const src = join(srcDir, 'data.txt')
    writeFileSync(src, 'payload')

    const target = await moveLocal(src, destDir)
    expect(target).toBe(join(destDir, 'data.txt'))
    expect(readFileSync(target, 'utf8')).toBe('payload')
    // 关键：这是移动不是复制，源必须消失
    expect(existsSync(src)).toBe(false)
  })

  it('移动目录会连内容一起搬走', async () => {
    const srcDir = join(workDir, 'mv-tree')
    mkdirSync(join(srcDir, 'inner'), { recursive: true })
    writeFileSync(join(srcDir, 'inner', 'x.txt'), 'X')
    const destDir = join(workDir, 'mv-tree-dest')
    mkdirSync(destDir, { recursive: true })

    const target = await moveLocal(srcDir, destDir)
    expect(readFileSync(join(target, 'inner', 'x.txt'), 'utf8')).toBe('X')
    expect(existsSync(srcDir)).toBe(false)
  })

  it('移动时目标同名就拒绝，两边内容都不变', async () => {
    /**
     * Windows 的 fs.rename 会**直接覆盖**同名文件。不先 stat 就是静默吃掉数据，
     * 和 copyLocal / renameLocal 的语义也对不上。
     */
    const srcDir = join(workDir, 'mv-clash-src')
    const destDir = join(workDir, 'mv-clash-dest')
    mkdirSync(srcDir, { recursive: true })
    mkdirSync(destDir, { recursive: true })
    const src = join(srcDir, 'dup.txt')
    writeFileSync(src, 'NEW')
    writeFileSync(join(destDir, 'dup.txt'), 'OLD')

    await expect(moveLocal(src, destDir)).rejects.toThrow(/已经有一个/)
    expect(readFileSync(src, 'utf8')).toBe('NEW')
    expect(readFileSync(join(destDir, 'dup.txt'), 'utf8')).toBe('OLD')
  })

  it('不能把目录移进它自己里面', async () => {
    /**
     * 不拦这一下的后果：目录从原位置消失，却又挂在自己下面，
     * 整棵树变成打不开的孤儿。这类操作在界面上一次误拖就能触发。
     */
    const parent = join(workDir, 'mv-self')
    const child = join(parent, 'inside')
    mkdirSync(child, { recursive: true })

    await expect(moveLocal(parent, child)).rejects.toThrow(/自己里面/)
    expect(existsSync(parent)).toBe(true)
  })

  it('移到原地当作成功（不报错）', async () => {
    const dir = join(workDir, 'mv-same')
    mkdirSync(dir, { recursive: true })
    const src = join(dir, 'stay.txt')
    writeFileSync(src, 'x')

    await expect(moveLocal(src, dir)).resolves.toBe(src)
    expect(existsSync(src)).toBe(true)
  })
})

describe('远端文件操作', () => {
  let cluster: FakeCluster
  let session: Session
  let workDir: string

  beforeAll(async () => {
    cluster = await createFakeCluster({
      handleCommand: createShellHandler(),
      files: {
        '/home/user01/keep.txt': Buffer.from('keep'),
        '/home/user01/del.txt': Buffer.from('bye'),
        '/home/user01/out/run.log': Buffer.from('log'),
        '/home/user01/out/ckpt/model.pt': Buffer.alloc(64, 1)
      }
    })
    cluster.fs.mkdir('/home/user01/out/ckpt')

    workDir = mkdtempSync(join(tmpdir(), 'hpc-ops-remote-'))
    writeFileSync(join(workDir, 'id_ed25519'), makeTestKey())

    const loaded = validateProfiles(
      {
        defaultProfile: 'fake',
        profiles: [
          {
            id: 'fake',
            host: '127.0.0.1',
            port: cluster.port,
            username: 'user01',
            auth: { method: 'key', privateKeyPath: join(workDir, 'id_ed25519') }
          }
        ]
      },
      join(workDir, 'profiles.json')
    )
    session = await Session.open(loaded.profiles[0]!, { knownHosts: new KnownHostsStore(null) })
  })

  afterAll(async () => {
    await session?.close()
    await cluster?.close()
    rmSync(workDir, { recursive: true, force: true })
  })

  it('取到家目录', async () => {
    expect(await remoteHome(session)).toBe('/home/user01')
  })

  it('删单个文件', async () => {
    await deleteRemote(session, '/home/user01/del.txt', '/home/user01')
    expect(cluster.fs.isFile('/home/user01/del.txt')).toBe(false)
    expect(cluster.fs.isFile('/home/user01/keep.txt')).toBe(true)
  })

  it('删目录会连内容一起删掉', async () => {
    await deleteRemote(session, '/home/user01/out', '/home/user01')
    expect(cluster.fs.isDir('/home/user01/out')).toBe(false)
    expect(cluster.fs.isFile('/home/user01/out/ckpt/model.pt')).toBe(false)
  })

  it('删不存在的路径当作成功（幂等）', async () => {
    await expect(deleteRemote(session, '/home/user01/nope.txt', '/home/user01')).resolves.toBeUndefined()
  })

  it('拒绝删家目录：护栏在主进程里，不靠界面自觉', async () => {
    await expect(deleteRemote(session, '/home/user01', '/home/user01')).rejects.toThrow(/家目录本身/)
    // 家目录还在
    expect(cluster.fs.isFile('/home/user01/keep.txt')).toBe(true)
  })

  it('远端重命名成功', async () => {
    const next = await renameRemote(session, '/home/user01/keep.txt', 'kept.txt')
    expect(next).toBe('/home/user01/kept.txt')
    expect(cluster.fs.isFile('/home/user01/kept.txt')).toBe(true)
  })

  it('远端重命名遇到同名就拒绝', async () => {
    // 造一对同名冲突：a.txt 和 b.txt 都在，把 a 改成 b 必须被拒
    cluster.fs.write('/home/user01/a.txt', Buffer.from('AAA'))
    cluster.fs.write('/home/user01/b.txt', Buffer.from('BBB'))

    await expect(renameRemote(session, '/home/user01/a.txt', 'b.txt')).rejects.toThrow(/已经有一个/)

    // 两个文件的内容都不能变
    expect(cluster.fs.read('/home/user01/a.txt')?.toString()).toBe('AAA')
    expect(cluster.fs.read('/home/user01/b.txt')?.toString()).toBe('BBB')
  })

  it('远端新建文件夹', async () => {
    const created = await mkdirRemote(session, '/home/user01', 'newdir')
    expect(created).toBe('/home/user01/newdir')
    expect(cluster.fs.isDir('/home/user01/newdir')).toBe(true)
  })

  it('远端移动：源没了、目标有了、内容对', async () => {
    cluster.fs.mkdir('/home/user01/mv-in')
    cluster.fs.mkdir('/home/user01/mv-out')
    cluster.fs.write('/home/user01/mv-in/move-me.txt', Buffer.from('payload'))

    const target = await moveRemote(session, '/home/user01/mv-in/move-me.txt', '/home/user01/mv-out')
    expect(target).toBe('/home/user01/mv-out/move-me.txt')
    expect(cluster.fs.read(target)?.toString()).toBe('payload')
    // 移动不是复制
    expect(cluster.fs.isFile('/home/user01/mv-in/move-me.txt')).toBe(false)
  })

  it('远端移动遇到同名就拒绝，不覆盖（SFTP 的 RENAME 默认会覆盖）', async () => {
    cluster.fs.mkdir('/home/user01/mv-clash-a')
    cluster.fs.mkdir('/home/user01/mv-clash-b')
    cluster.fs.write('/home/user01/mv-clash-a/dup.txt', Buffer.from('NEW'))
    cluster.fs.write('/home/user01/mv-clash-b/dup.txt', Buffer.from('OLD'))

    await expect(
      moveRemote(session, '/home/user01/mv-clash-a/dup.txt', '/home/user01/mv-clash-b')
    ).rejects.toThrow(/已经有一个/)

    expect(cluster.fs.read('/home/user01/mv-clash-a/dup.txt')?.toString()).toBe('NEW')
    expect(cluster.fs.read('/home/user01/mv-clash-b/dup.txt')?.toString()).toBe('OLD')
  })

  it('远端不能把目录移进自己的子孙里', async () => {
    cluster.fs.mkdir('/home/user01/mv-orphan')
    cluster.fs.mkdir('/home/user01/mv-orphan/deep')

    await expect(
      moveRemote(session, '/home/user01/mv-orphan', '/home/user01/mv-orphan/deep')
    ).rejects.toThrow(/自己里面/)
    expect(cluster.fs.isDir('/home/user01/mv-orphan')).toBe(true)
  })

  it('远端移到原地当作成功', async () => {
    cluster.fs.mkdir('/home/user01/mv-here')
    cluster.fs.write('/home/user01/mv-here/stay.txt', Buffer.from('x'))

    await expect(moveRemote(session, '/home/user01/mv-here/stay.txt', '/home/user01/mv-here')).resolves.toBe(
      '/home/user01/mv-here/stay.txt'
    )
  })
})
