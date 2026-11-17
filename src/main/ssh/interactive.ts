/**
 * 「跑一条会问密码的命令」——PTY 版。
 *
 * 现有能力里没有这一层：
 * - `exec` 是**批处理**语义，stdin 是空的、没有 tty。实测
 *   `scir-account transfer` 在这种通道下会打印 `Your Password:` 然后立刻
 *   报 `Error: LdapError(rc: 49)` / `Error: AuthFailed`——因为它读 stdin 拿到 EOF，
 *   当作空密码。
 * - `openShell` 是**给人用**的交互终端，要接 xterm、要处理 resize、
 *   要一路挂着；拿它跑一条一次性命令太重，而且没法知道"什么时候该收工"。
 *
 * 所以这里做一个窄版本：开 PTY、喂命令、**看到提示串再喂密码**、等退出。
 *
 * ## 必须做对的五件事
 *
 * 1. **等提示串出现再写密码**。抢在前面写，密码会先于 `read` 到达而丢掉。
 *    实测提示串是 `Your Password: `（末尾有空格，不带换行）。
 * 2. **密码后面必须带 `\n`**，否则远端的 `read` 一直等。
 * 3. **必须用 `StringDecoder`**——不过这里用不到，因为 `openShell` 内部已经做了
 *    （见 `Session.openShell`）。这里只拿解码后的字符串，不要再 `toString`。
 * 4. **必须有超时**。密码错了、网络断了、`scir-account` 改了行为，
 *    都可能让它一直挂着——一条挂住的 PTY 会占着服务端的 MaxSessions 名额。
 * 5. **不能靠 PTY 的 `onClose.code` 判成功**！见下面那一节，这是整个模块
 *    最容易做错、后果也最严重的地方。
 *
 * ## ⚠️ 为什么不用 `onClose` 的退出码（这是本条功能的致命坑）
 *
 * `openShell` 开的是一条**登录 shell（bash）**。我们 `write()` 进去的东西是
 * **键盘输入**，由 bash 读一行、执行、再回到提示符——**bash 自己不会退出**。
 *
 * 所以：
 * - `scir-account` 的退出码是**命令**的退出码，不是 PTY 的退出码。
 *   `onClose` 只会在 bash 退出（用户敲 `exit` / `Ctrl-D` / 连接断）时才触发。
 * - 于是「转账成功」也会一直挂到 25 秒超时，然后被判成失败。
 *   用户会看到「转账失败」，但**钱已经转出去了**——
 *   他会再转一次。这是花钱才能发现的 bug。
 *
 * 正确做法：在命令后面追加一个**哨兵**，把退出码写进输出，
 * 用「看到哨兵」作为唯一可靠的结束信号：
 *
 * ```
 * scir-account transfer ...; printf '\n__HPC_DONE__:%s\n' "$?"
 * ```
 *
 * 注意用 `;` 而不是 `&&`——即使命令失败也要打哨兵，否则失败时就只能等超时。
 * 哨兵里带随机串（`nonce`），避免命令自己的输出里恰好出现同样文本。
 *
 * ## 关于"密码会不会进日志"
 *
 * 正确做法是**根本不让密码进输出**：tty 在读到密码前会关 echo，
 * 所以只要等到提示串再写，密码就不会回显。
 *
 * 另外这一层**故意不接 `onTrace`**：`Session.exec` 会记命令台，但这条路
 * 走的是 `openShell`（不记 trace），而且命令串里本来就没有密码
 * （它是从 stdin 读的，不是命令行参数）。所以密码不可能落到
 * `trace/store.ts` 里——这是结构上就成立的，不是靠过滤。
 */
import type { Session } from './session'
import { SshError } from './errors'

export interface PasswordPromptOptions {
  /** 看到什么就该喂密码了。默认匹配结尾的 `Password:`（中英文冒号都认） */
  prompt?: RegExp
  /** 整体超时，默认 25 秒 */
  timeoutMs?: number
  /** 看到提示串之后等多久再写（给 tty 关 echo 留时间），默认 150 ms */
  settleMs?: number
}

export interface PasswordPromptResult {
  /** 完整输出。正常情况下不含密码（tty 已关 echo），也**不含哨兵行** */
  output: string
  /**
   * **被跑的那条命令**的退出码。
   *
   * 注意这**不是** PTY 的退出码（PTY 退出码永远是 bash 的，通常要等到
   * bash 退出才有）。这个值是从哨兵行里读出来的；没见到哨兵时为 null。
   */
  code: number | null
  /** 是否真的写入了密码（没看到提示串就不会写） */
  sentPassword: boolean
  /** 是否超时（此时 `code` 为 null，输出可能不完整） */
  timedOut: boolean
  /** 是否看到了哨兵（= 命令确实跑完并返回了）。false 时 `code` 不可信 */
  finished: boolean
  durationMs: number
}

const DEFAULT_TIMEOUT_MS = 25_000
const DEFAULT_SETTLE_MS = 150
/**
 * 密码提示串。
 *
 * 实测本集群是 `Your Password: `（英文 + 半角冒号 + 一个空格，不带换行）。
 * 这里额外认三种形态，因为**一旦认不出提示串，密码就永远不会被送出去**，
 * 结果是眼睁睁等到超时：
 * - 中文冒号 `：`——本地化版本
 * - 中文「密码」
 * - 大写 `PASSWORD`
 *
 * 放宽的风险是「输出里恰好有一行以 Password: 结尾」时误判、提前送密码。
 * 这种情况在 `scir-account` 的输出里不存在，而且就算发生，最坏结果是
 * 密码被当作下一行输入——它会出现在回显里，而不会造成任何转账。
 * 相比"永远超时"，这个风险可以接受。
 */
const DEFAULT_PROMPT = /(password|密码)\s*[:：]\s*$/i

/** 哨兵行的前缀。带 nonce 之后只可能由我们那条 `printf` 产生 */
function sentinelPrefix(nonce: string): string {
  return `__HPC_DONE_${nonce}__:`
}

/**
 * 在一条 PTY 上跑 `command`，看到密码提示就喂 `password`，等哨兵出现。
 *
 * `command` 由调用方拼好（见 `domain/points-transfer.ts`），这里**不做任何转义**——
 * 转义是拼命令那一层的责任，这里只负责原样发到 shell。
 *
 * 返回的 `code` 是**命令**的退出码（从哨兵里读的），不是 PTY 的。
 */
export async function runWithPassword(
  session: Session,
  command: string,
  password: string,
  options: PasswordPromptOptions = {}
): Promise<PasswordPromptResult> {
  const prompt = options.prompt ?? DEFAULT_PROMPT
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS
  const startedAt = Date.now()

  // 随机串只需在这一次调用里唯一。不用 crypto，避免在这里引入 node 依赖面
  const nonce = Math.random().toString(36).slice(2, 10)
  const marker = sentinelPrefix(nonce)

  // `;` 而不是 `&&`：命令失败时也要打哨兵，否则只能等超时
  const wrapped = `${command}; printf '\\n%s%s\\n' '${marker}' "$?"`

  return new Promise<PasswordPromptResult>((resolve, reject) => {
    let output = ''
    let sentPassword = false
    let timedOut = false
    let done = false
    let finished = false
    let code: number | null = null
    let timer: NodeJS.Timeout | undefined
    let handle: { write: (data: string) => void; close: () => void } | undefined

    const finish = (): void => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      try {
        handle?.close()
      } catch {
        /* 可能已关 */
      }
      // 把哨兵行本身从给用户看的输出里切掉——它不是"平台说的话"
      const cleaned = output.split(marker).join('').replace(/\n{3,}/g, '\n\n')
      resolve({ output: cleaned, code, sentPassword, timedOut, finished, durationMs: Date.now() - startedAt })
    }

    timer = setTimeout(() => {
      timedOut = true
      finish()
    }, timeoutMs)

    void session
      .openShell({ cols: 120, rows: 40 }, {
        onData: (text) => {
          output += text
          if (!sentPassword && prompt.test(output)) {
            sentPassword = true
            // 给 tty 一点时间关掉 echo，否则密码会明晃晃出现在 output 里
            setTimeout(() => {
              try {
                handle?.write(`${password}\n`)
              } catch {
                /* 通道可能已关 */
              }
            }, settleMs)
            return
          }

          if (finished) return
          // 哨兵后面跟的是退出码。可能被 chunk 切开，所以用累积后的 output 去判
          const found = new RegExp(`${marker}(\\d+)`).exec(output)
          if (found) {
            finished = true
            code = Number(found[1])
            finish()
          }
        },
        // ⚠️ 这里**不能** finish：这是 bash 退出的信号，不是命令结束的信号。
        // 只有在命令还没跑完连接就断了的情况下，才当作结束（此时 code 保持 null）。
        onClose: () => finish()
      })
      .then((created) => {
        handle = created
        // 先发命令；提示串要等命令跑起来才出现
        created.write(`${wrapped}\n`)
      })
      .catch((err: unknown) => {
        if (done) return
        done = true
        if (timer) clearTimeout(timer)
        reject(
          err instanceof SshError
            ? err
            : new SshError({
                kind: 'remote',
                message: '开交互通道失败，没法送密码',
                hint: '重连一次；若持续失败，说明这台机器不让开 PTY。',
                raw: err instanceof Error ? err.message : String(err)
              })
        )
      })
  })
}

/**
 * 从 PTY 输出里切出「命令自己说的话」。
 *
 * PTY 输出会带三样不想要的东西：
 * 1. 登录横幅（`Last login: Thu Nov 5 ...`）
 * 2. **shell 回显的命令本身**（含 `alice@login-01:~$ scir-account transfer ...`）
 * 3. 每次命令后重绘的提示符 `alice@login-01:~$`
 *
 * 界面要展示"平台怎么回的"，这三样都不是。做法：从**最后一次**出现的
 * `scir-account` 之后开始截，再切掉结尾那个提示符。
 *
 * 为什么不按行号截：横幅有 0 行也有 1 行（实测有的机器配了
 * `PrintLastLog no`），按行号取必然在某台机器上错位。
 *
 * 注意 `output` 里已经不含哨兵行（`runWithPassword` 切掉了），
 * 但哨兵的 `printf` 格式串以 `\n` 开头，所以会多一个空行，下面统一 trim。
 */
export function extractCommandOutput(raw: string): string {
  const start = raw.lastIndexOf('scir-account')
  // 找不到命令回显（比如提示符被重绘覆盖了）就保留全文——宁可多给，不要空
  const body = start >= 0 ? raw.slice(start) : raw
  const lines = body.split(/\r?\n/)

  // 去掉第一行（回显的命令，可能还带提示符前缀）
  if (lines.length > 0 && lines[0]!.includes('scir-account')) lines.shift()

  // 从尾部剥掉重绘的提示符行（形如 `alice@host:~$ ` 或者空行）
  while (lines.length > 0) {
    const last = lines[lines.length - 1]!.trim()
    if (last.length === 0 || /[$#]\s*$/.test(last)) {
      lines.pop()
      continue
    }
    break
  }

  return lines.join('\n').trim()
}

/**
 * 判断这次转账**是否成功**。
 *
 * 单独抽成函数是因为判据不止一条，且每一条都要能说出理由：
 *
 * 1. **必须见到哨兵**（`finished`）。没见到就说明命令没跑完——
 *    超时、连接断了、bash 挂了。此时**不能**当成成功，
 *    因为"没回音"和"成功了但没回音"在钱这件事上不能赌。
 * 2. **退出码必须是 0**。哨兵里带的就是 `$?`。
 * 3. **输出里不能有 `Error:`**。实测 `scir-account` 认证失败时会把
 *    `Error: LdapError(rc: 49)` 打到 stdout，而退出码在 PTY 场景下
 *    我们拿的是哨兵里的 `$?`——理论上已经是 1 了，双保险还是留着：
 *    万一将来它改成 exit 0 + 打 Error（CLI 里这种退化很常见），
 *    只看退出码就会把失败当成功。
 *
 * 反过来，**不能**把"输出里没有 Success 字样"当失败——
 * 平台的成功输出格式没保证，用正面关键词判会误杀。
 */
export function isPasswordRunSuccess(result: PasswordPromptResult): {
  ok: boolean
  reason: string | null
} {
  if (result.timedOut) {
    return {
      ok: false,
      reason: `等了 ${Math.round(DEFAULT_TIMEOUT_MS / 1000)} 秒没有回应，命令可能卡住了。`
    }
  }
  if (!result.finished) {
    return { ok: false, reason: '命令没有正常结束（连接可能断了）。' }
  }
  if (result.code !== 0) {
    return { ok: false, reason: `平台返回了非零退出码 ${String(result.code)}。` }
  }
  if (/error:/i.test(result.output)) {
    return { ok: false, reason: '平台在输出里报了 Error。' }
  }
  return { ok: true, reason: null }
}
