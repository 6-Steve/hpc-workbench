/**
 * 拼 `scir-account transfer` 命令，以及做参数校验。
 *
 * 抽成纯函数而不是写在 IPC 里，理由很实在：这条命令**会真的扣点数**，
 * 一旦拼错（少个参数、单位搞错、把别人的账号弄错）就是真金白银的损失，
 * 必须能拿单测盯住。
 *
 * 实测（2026-11-05，`login-01`）：
 *
 * ```
 * Usage: scir-account transfer --points <POINTS> --target <TARGET> --month <MONTH>
 *
 * Options:
 *   -p, --points <POINTS>  how much points you want to give
 *   -t, --target <TARGET>  username of the user you want to give
 *   -m, --month <MONTH>    how many month it will expired (the day 1 after n months)
 * ```
 *
 * ## 三个必须在这里解决的问题
 *
 * 1. **`--points -5` 会被 clap 当成未知参数**，报的是
 *    `error: unexpected argument '-5' found`——不是"点数不合法"，
 *    用户完全看不懂。所以非正数必须在**发出去之前**就拦住。
 * 2. **`--target` 直接拼进命令**。虽然预期是账号名，但拼之前必须校验，
 *    否则一个带空格或 `;` 的值就能在里面塞第二条命令。
 * 3. **三个参数都是必填**，少一个远端报
 *    `error: the following required arguments were not provided`（exit=2）。
 *    与其让远端报错，不如本地先给出人话。
 *
 * ## 密码不在这里
 *
 * `scir-account transfer` **从 stdin 读密码**（会打印 `Your Password:`），
 * 不是命令行参数。所以密码不可能出现在命令串里，也就不可能被
 * 命令台（`trace/store.ts`）记录下来——这是设计上就安全的，不是靠自觉。
 */
import { shq } from '../ssh/shell'

export interface TransferRequest {
  target: string
  points: number
  month: number
}

export type TransferCheck = { ok: true; command: string } | { ok: false; reason: string }

/**
 * 账号名允许的字符集。
 *
 * 实测本集群账号是 `alice` 这种纯小写字母，但其它集群可能有数字、下划线、
 * 点、连字符。给到这一组足够用，同时挡掉所有对 shell 有特殊含义的字符
 * （空格、引号、`;`、`$`、`|`、`&`、重定向符、括号、反斜杠）。
 *
 * 用白名单而不是黑名单：黑名单永远漏，白名单漏了大不了用户报"账号输不进去"，
 * 而黑名单漏了就是命令注入。
 */
const TARGET_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

/** 点数上限。实测 Total 是 5200，给两个数量级的余量足够，同时挡住手滑多打一个 0 */
const MAX_POINTS = 1_000_000

/** 过期月数上限。给 120 个月（10 年）已经很宽了 */
const MAX_MONTH = 120

export function checkTransfer(input: TransferRequest): TransferCheck {
  const target = input.target.trim()

  if (target.length === 0) {
    return { ok: false, reason: '要填对方的账号名' }
  }
  if (!TARGET_PATTERN.test(target)) {
    return {
      ok: false,
      reason: '账号名只能用字母、数字、点、下划线、连字符（不能有空格或其它符号）'
    }
  }

  if (!Number.isFinite(input.points)) {
    return { ok: false, reason: '点数必须是数字' }
  }
  if (!Number.isInteger(input.points)) {
    // 平台要的是整数点数。传 0.5 会怎样没实测过，与其赌，不如本地拦下
    return { ok: false, reason: '点数必须是整数' }
  }
  if (input.points <= 0) {
    // 0 点没有意义；负数会让 clap 报「未知参数」，用户看不懂
    return { ok: false, reason: '点数要大于 0' }
  }
  if (input.points > MAX_POINTS) {
    return { ok: false, reason: `一次最多送 ${MAX_POINTS} 点，确认一下是不是多打了一位` }
  }

  if (!Number.isInteger(input.month)) {
    return { ok: false, reason: '有效期必须是整数个月' }
  }
  if (input.month < 1) {
    return { ok: false, reason: '有效期至少 1 个月' }
  }
  if (input.month > MAX_MONTH) {
    return { ok: false, reason: `有效期最多 ${MAX_MONTH} 个月` }
  }

  return { ok: true, command: transferCommand({ target, points: input.points, month: input.month }) }
}

/**
 * 拼命令。
 *
 * 用 `=` 风格（`--points=10`）而不是空格分隔，理由和 sbatch 那边一致：
 * 一眼能看出一个参数到哪结束，出错时好读。实测两种风格 clap 都接受
 * （`-p 0 -t alice -m 1` 与 `--points=10` 都跑得通）。
 *
 * 账号名仍然过一遍 `shq()`：白名单已经挡掉了危险字符，但
 * "两层防护"在这里不值什么钱，漏掉的成本却很高。
 */
export function transferCommand(input: TransferRequest): string {
  return [
    'scir-account',
    'transfer',
    `--points=${input.points}`,
    `--target=${shq(input.target)}`,
    `--month=${input.month}`
  ].join(' ')
}

/**
 * 给用户"让他人赠送点数"用的**说明文本**，不是命令。
 *
 * 实测 `transfer` 没有反向的"请给我点数"指令——平台侧只有"我把点数转给你"这一个动作。
 * 所以这里给的是给**对方**看的一段话：让他执行哪条命令、参数怎么填。
 *
 * 单位是**自己账号名**，从 profile 里来，不是猜的。
 */
export function giftInstruction(input: { username: string; points?: number; month?: number }): string {
  const amount = input.points && input.points > 0 ? input.points : '点数'
  const month = input.month && input.month > 0 ? input.month : 'N'
  return [
    `请帮我转 ${amount} 点 HPC 点数，我的账号是 ${input.username}。`,
    '',
    '在登录节点上执行（会提示输入你的集群密码）：',
    '',
    `scir-account transfer --points=${typeof amount === 'number' ? amount : '<点数>'} --target=${input.username} --month=${month}`,
    '',
    `--month=${month} 表示有效期，${month === 'N' ? 'N' : month} 个月后的 1 号到期。`
  ].join('\n')
}
