/**
 * 测试用的 ed25519 私钥。
 *
 * ## 为什么要包一层
 *
 * `ssh2` 的 `utils.generateKeyPairSync('ed25519')` 有**约 1/300 的概率**
 * 产出它自己 `parseKey()` 都不认的私钥（实测 300 次里 1 次报
 * `Malformed OpenSSH private key`）。
 *
 * 这个抖动在单文件跑的时候几乎碰不到，但全量跑的时候有 20 多个 SSH 测试
 * 文件各自生成密钥，累计起来每次都有百分之十几的概率踩中。症状还很误导人：
 * `beforeAll` 里抛异常 → 整个文件的用例**全部 skip**，
 * 而报错写着"私钥格式错误"，看起来像夹具坏了，不像随机事件。
 *
 * 第一次遇到时我以为是端口竞争，改成串行也复现不了——因为它本来就是随机的。
 *
 * 所以统一走这里：**生成后当场校验，不行就重来**。
 *
 * ## 用法
 *
 * ```ts
 * writeFileSync(keyPath, makeTestKey())
 * const server = new Server({ hostKeys: [makeTestKey()] }, handler)
 * ```
 */
import { utils } from 'ssh2'

const MAX_ATTEMPTS = 8

export function makeTestKey(): string {
  let lastError = 'unknown'

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const key = utils.generateKeyPairSync('ed25519').private
    const parsed = utils.parseKey(key)
    if (!(parsed instanceof Error)) return key
    lastError = parsed.message
  }

  // 连续 8 次都坏，概率是 (1/300)^8，说明不是抖动了，是 ssh2 版本变了
  throw new Error(
    `连续 ${MAX_ATTEMPTS} 次都生成了不可用的测试私钥（最后一次：${lastError}）。` +
      '检查 ssh2 的版本是否换了大版本。'
  )
}
