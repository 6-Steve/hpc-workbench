/**
 * `Cipher` 的真实实现：Electron `safeStorage`。
 *
 * 这是整个凭据模块里**唯一** import electron 的文件。好处是
 * `vault.ts` 可以在纯 node 的测试里跑完整流程，而这一层薄到
 * 出问题的可能性很小。
 *
 * ## 各平台背后是什么
 *
 * | 平台 | 实际实现 | 密钥绑什么 |
 * |---|---|---|
 * | Windows | DPAPI | 当前**操作系统用户**账户 |
 * | macOS | Keychain | 登录钥匙串 |
 * | Linux | libsecret / kwallet | 桌面密钥环；**没装就是不可用** |
 *
 * 「绑当前用户」这件事对"应用发给他人"这个目标是加分项：
 * 别人拷走 `config/credentials.json` 也解不开，因为密钥在他自己的账户下不存在。
 *
 * ## 必须等 app ready
 *
 * `safeStorage` 在 `app.whenReady()` 之前调用会抛。这里的 `available`
 * 是 getter 而不是构造时求值，正是为了让它被真正用到的时刻（IPC handler 里、
 * app 已经 ready）才去问。
 */
import { safeStorage } from 'electron'
import type { Cipher } from './vault'

/**
 * Linux 上 `getSelectedStorageBackend()` 会返回 `basic_text`——意思是
 * 没有真正的密钥环，Electron 退化成"用固定密码加密"，等于没加密。
 *
 * 这种情况必须当成**不可用**：宁可让用户每次输入，也不能让他以为存的是安全的。
 */
function detectBackend(): { available: boolean; backend: string } {
  let available = false
  try {
    available = safeStorage.isEncryptionAvailable()
  } catch {
    // app 还没 ready 时会抛，当作不可用处理（不会有数据损失，只是不让保存）
    available = false
  }

  if (process.platform === 'win32') {
    return { available, backend: 'Windows 数据保护（DPAPI）' }
  }
  if (process.platform === 'darwin') {
    return { available, backend: 'macOS 钥匙串' }
  }

  // Linux / 其它：还要看后端是不是退化的 basic_text
  let name = '系统密钥环'
  try {
    const selected = safeStorage.getSelectedStorageBackend()
    if (selected === 'basic_text') {
      return {
        available: false,
        backend: '系统密钥环（当前是 basic_text，等于没加密，不予使用）'
      }
    }
    name = `系统密钥环（${selected}）`
  } catch {
    /* 取不到名字就用默认的 */
  }
  return { available, backend: name }
}

export function createSafeStorageCipher(): Cipher {
  return {
    get available(): boolean {
      return detectBackend().available
    },
    get backend(): string {
      return detectBackend().backend
    },
    encrypt(plain: string): string {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('系统钥匙串不可用')
      }
      // 存 base64 而不是 Buffer：JSON 里放二进制会变成 {"type":"Buffer","data":[...]}，
      // 又丑又容易在读写之间出岔子
      return safeStorage.encryptString(plain).toString('base64')
    },
    decrypt(cipher: string): string {
      // 解不开就让它抛：vault 会接住并转成 `undecryptable`，
      // 在那里才能给出"多半是换了账户"这种有用的解释
      return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
    }
  }
}
