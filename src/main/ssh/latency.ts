/**
 * 测一台跳板机"连上去要多久"，并把耗时拆成四段。
 *
 * ## 三条硬约束
 *
 * 1. **一次性连接**。不能走 `ConnectionPool`——池按 `profile.id` 复用会话，
 *    复用测得的是 0.2ms，毫无意义。
 * 2. **凭据解析复用 `loadAuthMaterial()`**（`session.ts`）。否则"密码在钥匙串里"
 *    那套逻辑会在两处各写一遍，然后慢慢走偏。
 * 3. **未知主机不写入指纹**。测速顺手改变 trust 状态是意外副作用；
 *    遇到没见过的 host key 直接拒绝并让用户先去正常连一次。
 *
 * ## 为什么要自己包一层 socket
 *
 * ssh2 不暴露"收到 SSH 版本串"的时刻，而这个时刻正好把 **sshd 应答** 和
 * **认证** 分开——这两个慢的原因不同（一个节点在排队，一个密钥交换/认证慢）。
 * 直接在 socket 上挂 `'data'` 会把字节吃掉（ssh2 拿不到版本串，握手直接失败），
 * 所以做一个 Duplex 适配器：读方向由我们从真实 socket 推，写方向转发回去。
 */
import { Duplex } from 'node:stream'
import { connect as netConnect, type Socket } from 'node:net'
import { Client, type ConnectConfig } from 'ssh2'
import { LATENCY_TIMEOUTS, type LatencyProbe } from '../../shared/latency'
import type { ResolvedProfile } from '../profiles'
import { fingerprintOf, type KnownHostsStore } from './known-hosts'
import { loadAuthMaterial } from './session'

const MARKER = '__hpc_probe__'

export async function probeLatency(
  profile: ResolvedProfile,
  deps: { knownHosts?: KnownHostsStore } = {}
): Promise<LatencyProbe> {
  const started = Date.now()
  const probe: LatencyProbe = {
    tcpMs: null,
    sshdMs: null,
    authMs: null,
    execMs: null,
    totalMs: null,
    failure: null
  }

  // ── 1. TCP ────────────────────────────────────────────────────────────────
  let sock: Socket
  try {
    sock = await openTcp(profile.host, profile.port, LATENCY_TIMEOUTS.tcpMs)
    probe.tcpMs = Date.now() - started
  } catch (err) {
    probe.failure = 'unreachable'
    probe.timedOutAt = isTimeout(err) ? 'tcp' : undefined
    probe.error = describeError(err)
    return probe
  }

  // ── 2. 交给 ssh2（第一个字节到达时记一笔）────────────────────────────────
  let firstByteAt: number | null = null
  const duplex = meterSocket(sock, () => {
    if (firstByteAt === null) firstByteAt = Date.now()
  })

  let authMaterial: Partial<ConnectConfig>
  try {
    authMaterial = await loadAuthMaterial(profile)
  } catch (err) {
    sock.destroy()
    probe.failure = 'auth-failed'
    probe.error = describeError(err)
    return probe
  }

  const client = new Client()
  const config: ConnectConfig = {
    host: profile.host,
    port: profile.port,
    username: profile.username,
    sock: duplex,
    // 这一段的上限由我们自己的预算控制，不用 profiles.json 里的 15 秒
    readyTimeout: LATENCY_TIMEOUTS.authMs,
    hostVerifier: (key: Buffer, verify?: (ok: boolean) => void): boolean => {
      const { algorithm, fingerprint } = fingerprintOf(key)
      const verdict = deps.knownHosts
        ? deps.knownHosts.verify(profile.host, profile.port, algorithm, fingerprint)
        : 'new'

      if (verdict === 'mismatch') {
        probe.failure = 'hostkey-mismatch'
        probe.error = `${algorithm} ${fingerprint}`
        verify?.(false)
        return false
      }
      if (verdict === 'new') {
        // 不 remember：测速不该替用户做信任决定
        probe.failure = 'unknown-host'
        probe.error = `${algorithm} ${fingerprint}`
        verify?.(false)
        return false
      }
      verify?.(true)
      return true
    },
    ...authMaterial
  }

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (err?: Error): void => {
        if (settled) return
        settled = true
        if (err) reject(err)
        else resolve()
      }
      client.once('ready', () => settle())
      client.once('error', (err: Error) => settle(err))
      try {
        client.connect(config)
      } catch (err) {
        settle(err as Error)
      }
    })
  } catch (err) {
    cleanup()
    // 指纹问题优先：它在握手中途就会触发，后面还会跟一个通用错误
    if (probe.failure) return probe

    const message = describeError(err)
    const timedOut = /timed out|timeout/i.test(message)
    probe.timedOutAt = timedOut ? (firstByteAt === null ? 'sshd' : 'auth') : undefined
    probe.failure = timedOut ? null : 'auth-failed'
    probe.error = message
    return probe
  }

  const readyAt = Date.now()
  probe.totalMs = readyAt - started
  if (firstByteAt !== null) {
    probe.sshdMs = firstByteAt - (started + (probe.tcpMs ?? 0))
    probe.authMs = readyAt - firstByteAt
  }

  // ── 3. 一条 echo 看"用起来卡不卡" ────────────────────────────────────────
  const execStart = Date.now()
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        client.exec(`echo ${MARKER}`, (err, stream) => {
          if (err) {
            reject(err)
            return
          }
          let out = ''
          stream.on('data', (chunk: Buffer) => {
            out += chunk.toString('utf8')
          })
          stream.stderr.on('data', () => undefined)
          stream.once('close', () => {
            if (out.includes(MARKER)) resolve()
            else reject(new Error(`echo 没有返回预期内容（拿到 ${JSON.stringify(out.slice(0, 40))}）`))
          })
          stream.once('error', reject)
        })
      }),
      LATENCY_TIMEOUTS.execMs,
      '命令超时'
    )
    probe.execMs = Date.now() - execStart
  } catch (err) {
    probe.timedOutAt = isTimeout(err) ? 'exec' : undefined
    probe.failure = isTimeout(err) ? null : 'exec-failed'
    probe.error = describeError(err)
  } finally {
    cleanup()
  }

  return probe

  function cleanup(): void {
    try {
      client.end()
    } catch {
      // 已经断了就算了，测速不该因为清理失败而报错
    }
    sock.destroy()
  }
}

/**
 * 建 TCP 连接，带独立超时。
 *
 * 不用 `net.connect` 自带的 `timeout`（它只在 socket 空闲时触发，语义不对）。
 */
function openTcp(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = netConnect({ host, port })
    let settled = false
    const done = (err?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeListener('connect', onConnect)
      socket.removeListener('error', onError)
      if (err) {
        socket.destroy()
        reject(err)
      } else {
        resolve(socket)
      }
    }
    const onConnect = (): void => done()
    const onError = (err: Error): void => done(err)
    const timer = setTimeout(() => done(new Error(`TCP ${timeoutMs}ms 内没连上`)), timeoutMs)
    socket.once('connect', onConnect)
    socket.once('error', onError)
  })
}

/**
 * 把真实 socket 包成一条 ssh2 能用的双工流，同时在第一个字节到达时回调。
 *
 * 关键点：**我们自己读 socket、自己 push 给 ssh2**，所以能看见字节而不会吃掉它。
 */
function meterSocket(sock: Socket, onFirstByte: () => void): Duplex {
  let seenFirst = false

  const duplex = new Duplex({
    read() {
      // 下游腾出空间了，继续读真实 socket
      sock.resume()
    },
    write(chunk: Buffer, encoding: BufferEncoding, callback: (err?: Error | null) => void) {
      sock.write(chunk, encoding, callback)
    },
    final(callback: (err?: Error | null) => void) {
      sock.end()
      callback()
    }
  })

  sock.on('data', (chunk: Buffer) => {
    if (!seenFirst) {
      seenFirst = true
      onFirstByte()
    }
    if (!duplex.push(chunk)) sock.pause()
  })
  sock.once('end', () => duplex.push(null))
  sock.once('error', (err: Error) => duplex.destroy(err))
  sock.once('close', () => duplex.destroy())
  duplex.once('close', () => sock.destroy())

  return duplex
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}（${timeoutMs}ms）`)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

function isTimeout(err: unknown): boolean {
  return /超时|timed out|timeout/i.test(describeError(err))
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}
