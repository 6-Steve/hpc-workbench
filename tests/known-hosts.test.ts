import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KnownHostsStore, fingerprintOf } from '../src/main/ssh/known-hosts'

/** 造一个结构合法的 host key blob：4 字节长度 + 算法名 + 密钥体 */
function keyBlob(algorithm: string, seed: string): Buffer {
  const algo = Buffer.from(algorithm, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(algo.length, 0)
  return Buffer.concat([len, algo, Buffer.from(seed, 'utf8')])
}

const tempDirs: string[] = []

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hpc-kh-'))
  tempDirs.push(dir)
  return join(dir, 'known_hosts.json')
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('fingerprintOf', () => {
  it('从 blob 里读出算法名，指纹是 SHA256 base64 且无补位等号', () => {
    const { algorithm, fingerprint } = fingerprintOf(keyBlob('ssh-ed25519', 'abc'))
    expect(algorithm).toBe('ssh-ed25519')
    expect(fingerprint.startsWith('SHA256:')).toBe(true)
    expect(fingerprint.endsWith('=')).toBe(false)
  })

  it('同样的 key 总是同一个指纹，不同 key 不同指纹', () => {
    const a = fingerprintOf(keyBlob('ssh-ed25519', 'one'))
    const b = fingerprintOf(keyBlob('ssh-ed25519', 'one'))
    const c = fingerprintOf(keyBlob('ssh-ed25519', 'two'))
    expect(a.fingerprint).toBe(b.fingerprint)
    expect(a.fingerprint).not.toBe(c.fingerprint)
  })
})

describe('KnownHostsStore', () => {
  it('首次是新主机，记录后变已知', () => {
    const store = new KnownHostsStore(tempFile())
    const { algorithm, fingerprint } = fingerprintOf(keyBlob('ssh-ed25519', 'abc'))

    expect(store.verify('h', 22, algorithm, fingerprint)).toBe('new')
    store.remember('h', 22, algorithm, fingerprint)
    expect(store.verify('h', 22, algorithm, fingerprint)).toBe('known')
  })

  it('同算法但指纹变了 → mismatch', () => {
    const store = new KnownHostsStore(tempFile())
    const first = fingerprintOf(keyBlob('ssh-ed25519', 'abc'))
    const second = fingerprintOf(keyBlob('ssh-ed25519', 'tampered'))

    store.remember('h', 22, first.algorithm, first.fingerprint)
    expect(store.verify('h', 22, second.algorithm, second.fingerprint)).toBe('mismatch')
  })

  it('服务端换了 host key 算法时按新主机处理，不误报', () => {
    const store = new KnownHostsStore(tempFile())
    const ed = fingerprintOf(keyBlob('ssh-ed25519', 'abc'))
    const rsa = fingerprintOf(keyBlob('ssh-rsa', 'abc'))

    store.remember('h', 22, ed.algorithm, ed.fingerprint)
    expect(store.verify('h', 22, rsa.algorithm, rsa.fingerprint)).toBe('new')
  })

  it('同算法重复记录时后者替换前者，旧指纹立刻失效', () => {
    const store = new KnownHostsStore(tempFile())
    const oldKey = fingerprintOf(keyBlob('ssh-ed25519', 'old'))
    const newKey = fingerprintOf(keyBlob('ssh-ed25519', 'new'))

    store.remember('h', 22, oldKey.algorithm, oldKey.fingerprint)
    store.remember('h', 22, newKey.algorithm, newKey.fingerprint)

    expect(store.list()['h:22']).toHaveLength(1)
    expect(store.verify('h', 22, oldKey.algorithm, oldKey.fingerprint)).toBe('mismatch')
    expect(store.verify('h', 22, newKey.algorithm, newKey.fingerprint)).toBe('known')
  })

  it('不同算法可以各留一条', () => {
    const store = new KnownHostsStore(tempFile())
    const ed = fingerprintOf(keyBlob('ssh-ed25519', 'x'))
    const rsa = fingerprintOf(keyBlob('ssh-rsa', 'x'))

    store.remember('h', 22, ed.algorithm, ed.fingerprint)
    store.remember('h', 22, rsa.algorithm, rsa.fingerprint)

    expect(store.list()['h:22']).toHaveLength(2)
    expect(store.verify('h', 22, ed.algorithm, ed.fingerprint)).toBe('known')
    expect(store.verify('h', 22, rsa.algorithm, rsa.fingerprint)).toBe('known')
  })

  it('端口不同算不同主机', () => {
    const store = new KnownHostsStore(tempFile())
    const fp = fingerprintOf(keyBlob('ssh-ed25519', 'abc'))
    store.remember('h', 22, fp.algorithm, fp.fingerprint)
    expect(store.verify('h', 2222, fp.algorithm, fp.fingerprint)).toBe('new')
  })

  it('落盘后重新加载仍然记得', () => {
    const file = tempFile()
    const fp = fingerprintOf(keyBlob('ssh-ed25519', 'abc'))

    const first = new KnownHostsStore(file)
    first.remember('h', 22, fp.algorithm, fp.fingerprint)

    const second = new KnownHostsStore(file)
    expect(second.verify('h', 22, fp.algorithm, fp.fingerprint)).toBe('known')
    expect(second.expectedFingerprint('h', 22, fp.algorithm)).toBe(fp.fingerprint)
  })

  it('forget 之后又变回新主机', () => {
    const store = new KnownHostsStore(tempFile())
    const fp = fingerprintOf(keyBlob('ssh-ed25519', 'abc'))
    store.remember('h', 22, fp.algorithm, fp.fingerprint)

    expect(store.forget('h', 22)).toBe(true)
    expect(store.forget('h', 22)).toBe(false)
    expect(store.verify('h', 22, fp.algorithm, fp.fingerprint)).toBe('new')
  })

  it('文件损坏时不阻塞连接，旧文件改名留存', () => {
    const file = tempFile()
    writeFileSync(file, '{ this is not json')

    const store = new KnownHostsStore(file)
    const fp = fingerprintOf(keyBlob('ssh-ed25519', 'abc'))
    expect(store.verify('h', 22, fp.algorithm, fp.fingerprint)).toBe('new')

    const siblings = readdirSync(join(file, '..')).filter((name) => name.includes('.corrupt-'))
    expect(siblings.length).toBe(1)
  })

  it('file 传 null 时只在本进程内记忆', () => {
    const store = new KnownHostsStore(null)
    const fp = fingerprintOf(keyBlob('ssh-ed25519', 'abc'))
    store.remember('h', 22, fp.algorithm, fp.fingerprint)
    expect(store.verify('h', 22, fp.algorithm, fp.fingerprint)).toBe('known')
  })
})
