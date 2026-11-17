/**
 * 「这个密码对不对」的判定逻辑。
 *
 * ## 原理：没有别的办法，只能真的去认证一次
 *
 * 密码是**加密存**的。程序能把密文解开，只能证明"密钥还在"，
 * 不能证明"里面那串等于用户的真实密码"——它没有正确答案可以比对。
 *
 * 所以唯一可靠的做法是**拿它去问认证方**，看对方接受还是拒绝：
 *
 * | 凭据 | 谁来裁决 | 代价 |
 * |---|---|---|
 * | 私钥口令 | 本地用口令解私钥，能解出合法结构就是对的 | 零网络 |
 * | SSH 密码 | 真的发一次 SSH 认证 | 一次连接 |
 * | 平台密码 | 只有 `scir-account transfer` 走 LDAP | 一次转账请求 |
 *
 * ## 为什么平台密码只能用 transfer 验
 *
 * `scir-account -d`（查余额）走的是 **SSH 权限**，压根不碰 LDAP——
 * 密码是错的它也会正常返回余额。所以拿它测 LDAP 密码会给出**假阳性**，
 * 比不测更糟。
 *
 * ## 探针用 0 点、转给自己
 *
 * `transfer --points=0 --target=<自己>`：
 * - 如果密码错，LDAP 先拦下（`rc: 49`），到不了业务层
 * - 如果密码对，要么平台接受这次 0 点转账（等于空操作），
 *   要么在业务校验里报"点数不合法"——**两种都说明密码是对的**
 *
 * 关键洞察就在这：**认证是第一道关口，只要失败原因不是认证，密码就是对的。**
 * 所以这里不去猜"成功长什么样"（平台的成功输出格式没有保证），
 * 而是只认一个明确的失败信号，其余一律算通过。
 */
import { utils } from 'ssh2'

export type ProbeStatus =
  /** 密码正确 */
  | 'ok'
  /** 密码错了 */
  | 'wrong'
  /** 网络／连接问题，无法判断密码对错 */
  | 'unreachable'
  /** 这条凭据没法用这种方式测（或环境不支持） */
  | 'unsupported'

export interface CredentialTestOutcome {
  status: ProbeStatus
  /** 直接能显示给用户的一句话 */
  message: string
  /** 平台/ssh2 的原始输出，折叠展示用。**不含密码** */
  detail?: string
}

/**
 * 私钥口令：本地解开一次，不需要网络。
 *
 * `ssh2` 的 `parseKey` 失败时会返回 `Error` 或 `Error[]`（而不是抛），
 * 所以既要把错误收集出来，又要兜住真的抛异常的情况。
 */
export function testPassphrase(material: Buffer, passphrase: string): CredentialTestOutcome {
  let parsed: unknown
  try {
    parsed = utils.parseKey(material, passphrase)
  } catch (err) {
    return {
      status: 'wrong',
      message: '用这个口令解不开私钥。',
      detail: err instanceof Error ? err.message : String(err)
    }
  }

  const errors = toErrorList(parsed)
  if (errors.length === 0) {
    return { status: 'ok', message: '口令正确，私钥能正常解开。' }
  }

  const text = errors.map((err) => err.message).join('；')

  /*
   * 失败可能是两种原因，而用户能做的处理刚好相反：
   * - 口令不对 → 重新输一次
   * - 私钥本身坏了/格式不支持 → 重新输一百次也没用
   *
   * ssh2 的报错文本不足以可靠区分，所以这里把两种可能都说出来，
   * 同时把原文附上——用户看到 "Malformed ... key" 就知道不是口令的问题。
   */
  const looksLikeKeyProblem = /malformed|unsupported|unknown (key )?format|no key found/i.test(text)
  return {
    status: 'wrong',
    message: looksLikeKeyProblem
      ? '解不开：这把私钥本身可能有问题（格式不对或已损坏），不只是口令的事。'
      : '口令不对，私钥解不开。',
    detail: text
  }
}

/**
 * 判断一次 SSH 认证失败的性质。
 *
 * 传进来的是 `Session.open()` 抛出的异常；`null` 表示连上了。
 */
export function judgeSshProbe(error: unknown): CredentialTestOutcome {
  if (error === null || error === undefined) {
    return { status: 'ok', message: '密码正确，SSH 认证通过了。' }
  }

  const record = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : null
  const kind = typeof record?.kind === 'string' ? record.kind : ''

  /*
   * 取原文时不能只认 `instanceof Error`：跨 IPC 之后错误已经被摊平成
   * 普通对象（`PlainError`），那时 `String(obj)` 会得到 `[object Object]`，
   * 用户展开"平台原话"看到的是一句废话。
   */
  const raw =
    error instanceof Error
      ? error.message
      : typeof record?.message === 'string'
        ? record.message
        : String(error)

  if (kind === 'auth') {
    return { status: 'wrong', message: '密码不对，服务端拒绝了认证。', detail: raw }
  }

  /*
   * 其余都是"没走到认证这一步"：DNS 解析不了、端口不通、握手失败、指纹不匹配。
   * 这些**不能**当成密码错——否则用户会反复去改一个本来正确的密码。
   */
  return {
    status: 'unreachable',
    message: '连不上集群，没法验证密码。先确认网络和主机地址，再试。',
    detail: `${kind || 'unknown'}: ${raw}`
  }
}

/**
 * 判断一次 LDAP 探针（PTY 里跑 `transfer`）的结果。
 *
 * 只认一个明确的失败信号：认证失败。其余全算通过，理由见文件顶部。
 */
export function judgeLdapProbe(result: {
  finished: boolean
  timedOut: boolean
  code: number | null
  output: string
}): CredentialTestOutcome {
  if (result.timedOut) {
    return {
      status: 'unreachable',
      message: '等了 25 秒没有回应，没法验证密码。',
      detail: result.output
    }
  }
  if (!result.finished) {
    return {
      status: 'unreachable',
      message: '命令没有正常结束（连接可能断了），没法验证密码。',
      detail: result.output
    }
  }

  const text = result.output ?? ''

  // LDAP 的 invalidCredentials 就是 rc=49。`AuthFailed` 是平台自己的简写
  if (/rc:\s*49/i.test(text) || /AuthFailed/i.test(text)) {
    return { status: 'wrong', message: '密码不对，LDAP 拒绝了认证（rc: 49）。', detail: text }
  }
  if (/LdapError/i.test(text) && !/rc:\s*49/i.test(text)) {
    // 其它 LDAP 错误（账号被锁、连接 LDAP 失败）——密码这关过了，但环境有问题
    return {
      status: 'unsupported',
      message: 'LDAP 返回了非密码类的错误（可能是账号被锁或 LDAP 不可用），无法判断密码对错。',
      detail: text
    }
  }

  /*
   * 走到这里说明认证过了。平台可能接着抱怨"点数不合法"（因为我们传的 0）
   * 或者干脆接受了这次 0 点转账——两种都算密码正确。
   */
  return {
    status: 'ok',
    message: '密码正确，LDAP 认证通过了。',
    detail: text.length > 0 ? text : undefined
  }
}

/** `parseKey` 的返回值可能是单个 Error、Error 数组，或解析成功的对象 */
function toErrorList(parsed: unknown): Error[] {
  if (parsed instanceof Error) return [parsed]
  if (Array.isArray(parsed)) {
    return parsed.filter((item): item is Error => item instanceof Error)
  }
  // 空数组/ null / undefined 都表示没解出东西来
  if (parsed === null || parsed === undefined) return [new Error('没有解析出任何密钥')]
  return []
}
