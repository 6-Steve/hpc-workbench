import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { validateProfiles } from '../src/main/profiles'
import { KnownHostsStore } from '../src/main/ssh/known-hosts'
import { Session } from '../src/main/ssh/session'
import { SshError } from '../src/main/ssh/errors'
import {
  downloadFile,
  ensureRemoteDir,
  removeRemoteFile,
  uploadFile
} from '../src/main/transfer/sftp'
import { createFakeCluster, type FakeCluster } from './helpers/fake-cluster'
import { makeTestKey } from './helpers/test-key'

let cluster: FakeCluster
let session: Session
let workDir: string

beforeAll(async () => {
  cluster = await createFakeCluster()
  workDir = mkdtempSync(join(tmpdir(), 'hpc-sftp-test-'))

  const keyPath = join(workDir, 'id_ed25519')
  writeFileSync(keyPath, makeTestKey())

  const loaded = validateProfiles(
    {
      defaultProfile: 'fake',
      profiles: [
        {
          id: 'fake',
          host: '127.0.0.1',
          port: cluster.port,
          username: 'user01',
          auth: { method: 'key', privateKeyPath: keyPath }
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

function localFile(name: string, content: Buffer): string {
  const path = join(workDir, name)
  writeFileSync(path, content)
  return path
}

describe('uploadFile', () => {
  it('上传内容与本地一致，并且没有留下 .part 临时文件', async () => {
    const payload = Buffer.from('hello 远端世界\n'.repeat(100))
    const local = localFile('small.txt', payload)

    const result = await uploadFile(session, local, '/home/user01/small.txt')

    expect(result.bytes).toBe(payload.length)
    expect(cluster.fs.read('/home/user01/small.txt')?.toString()).toBe(payload.toString())
    expect(cluster.fs.isFile('/home/user01/small.txt.part')).toBe(false)
  })

  it('目标目录不存在时自动逐级创建', async () => {
    const payload = Buffer.from('nested')
    const local = localFile('nested.txt', payload)

    await uploadFile(session, local, '/home/user01/a/b/c/nested.txt')

    expect(cluster.fs.isFile('/home/user01/a/b/c/nested.txt')).toBe(true)
    expect(cluster.fs.isDir('/home/user01/a')).toBe(true)
    expect(cluster.fs.mkdirCalls).toContain('/home/user01/a/b')
  })

  it('远端已存在同名文件时拒绝，不自动覆盖', async () => {
    const local = localFile('dup.txt', Buffer.from('second'))
    cluster.fs.write('/home/user01/dup.txt', Buffer.from('first'))

    await expect(uploadFile(session, local, '/home/user01/dup.txt')).rejects.toMatchObject({ kind: 'remote' })
    expect(cluster.fs.read('/home/user01/dup.txt')?.toString()).toBe('first')
  })

  it('会通过进度回调报告字节数', async () => {
    const payload = Buffer.alloc(256 * 1024, 0x41)
    const local = localFile('big.bin', payload)
    const samples: number[] = []

    await uploadFile(session, local, '/home/user01/big.bin', {
      onProgress: (sample) => samples.push(sample.bytes)
    })

    // 开始时一次、结束时一次至少两条；结束那条必须等于总字节
    expect(samples.length).toBeGreaterThan(0)
    expect(samples[samples.length - 1]).toBe(payload.length)
  })

  it('本地路径不是文件时报配置错误', async () => {
    const dir = join(workDir, 'a-dir')
    mkdirSync(dir, { recursive: true })
    await expect(uploadFile(session, dir, '/home/user01/x')).rejects.toMatchObject({ kind: 'config' })
  })

  it('远端少写了就报错，并清掉 .part（这是"静默丢数据"的唯一防线）', async () => {
    const payload = Buffer.alloc(64 * 1024, 0x5a)
    const local = localFile('truncated.bin', payload)

    // 让假服务端"写请求都成功，但只留下 1000 字节"
    cluster.fs.limitSize = 1000
    try {
      await expect(uploadFile(session, local, '/home/user01/truncated.bin')).rejects.toThrow(/大小不一致/)
    } finally {
      cluster.fs.limitSize = undefined
    }

    expect(cluster.fs.isFile('/home/user01/truncated.bin')).toBe(false)
    expect(cluster.fs.isFile('/home/user01/truncated.bin.part')).toBe(false)
  })
})

describe('downloadFile', () => {
  it('下载内容与远端一致', async () => {
    const payload = Buffer.from('from remote\n'.repeat(50))
    cluster.fs.write('/home/user01/dl.txt', payload)

    const target = join(workDir, 'out', 'dl.txt')
    const result = await downloadFile(session, '/home/user01/dl.txt', target)

    expect(result.bytes).toBe(payload.length)
    expect(readFileSync(target).toString()).toBe(payload.toString())
  })

  it('远端不存在时报错，而不是留下空文件', async () => {
    const target = join(workDir, 'missing.txt')

    await expect(downloadFile(session, '/home/user01/nope.txt', target)).rejects.toBeInstanceOf(SshError)
    expect(() => readFileSync(target)).toThrow()
  })

  it('本地目录不存在时会自动创建', async () => {
    cluster.fs.write('/home/user01/deep.txt', Buffer.from('deep'))

    const target = join(workDir, 'x', 'y', 'deep.txt')
    await downloadFile(session, '/home/user01/deep.txt', target)

    expect(readFileSync(target).toString()).toBe('deep')
  })

  it('下载后没有残留 .part 文件', async () => {
    cluster.fs.write('/home/user01/clean.bin', Buffer.alloc(1024, 7))
    const target = join(workDir, 'clean.bin')
    await downloadFile(session, '/home/user01/clean.bin', target)

    expect(() => readFileSync(`${target}.part`)).toThrow()
  })
})

describe('ensureRemoteDir / removeRemoteFile', () => {
  it('目录已存在时不会重复创建', async () => {
    cluster.fs.mkdir('/home/user01/stable')
    const before = cluster.fs.mkdirCalls.length

    await ensureRemoteDir(session, '/home/user01/stable')
    expect(cluster.fs.mkdirCalls.length).toBe(before)
  })

  it('路径被同名文件占用时报错', async () => {
    cluster.fs.write('/home/user01/occupied', Buffer.from('i am a file'))
    await expect(ensureRemoteDir(session, '/home/user01/occupied')).rejects.toBeInstanceOf(SshError)
  })

  it('能删掉远端文件', async () => {
    cluster.fs.write('/home/user01/tmp.bin', Buffer.from('x'))
    await removeRemoteFile(session, '/home/user01/tmp.bin')
    expect(cluster.fs.isFile('/home/user01/tmp.bin')).toBe(false)
  })
})

describe('SFTP 通道复用', () => {
  it('多次调用 sftp() 拿到同一条通道', async () => {
    const first = await session.sftp()
    const second = await session.sftp()
    expect(first).toBe(second)
  })
})
