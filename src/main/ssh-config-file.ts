/**
 * 从磁盘上读 `~/.ssh` 那套东西（`ssh_config` 的解析在 `shared/ssh-config.ts`）。
 *
 * 这里只做三件渲染层做不了的事：读文件、展开 `~`、判断私钥在不在/带不带口令。
 *
 * ## 为什么要把"私钥存不存在"和"要不要口令"一起判了
 *
 * 导入的意义是"少填几个框"，但如果导进来的路径根本不存在，
 * 用户会在点「生成配置」时才被拦下（或者更糟：连的时候才发现）。
 * 口令同理——私钥带口令时向导得提示他去填「私钥口令」，否则连接会报
 * `Encrypted private key detected`，而那句话离"填表"太远了。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { parseSshConfig, type SshConfigHost } from '../shared/ssh-config'

export interface SshImportHost extends SshConfigHost {
  /** 展开后的私钥绝对路径（没配 identityFile 时为空） */
  identityAbsolute?: string
  /** 该私钥文件是否存在 */
  keyExists?: boolean
  /** 私钥是否带口令（带的话向导要提示填口令） */
  keyEncrypted?: boolean
}

export interface SshKeyFile {
  path: string
  name: string
  encrypted: boolean
}

export interface SshImportResult {
  /** 最终用的配置目录 */
  dir: string
  /** 最终读的配置文件 */
  configPath: string
  found: boolean
  hosts: SshImportHost[]
  /** 同目录下的私钥候选（配置里没写 IdentityFile 时也能选） */
  keys: SshKeyFile[]
  warnings: string[]
}

/** `~/.ssh` 的绝对路径 */
export function defaultSshDir(): string {
  return join(homedir(), '.ssh')
}

/**
 * 读并解析。
 *
 * `target` 可以是目录（读其中的 `config`）或直接是某个文件——
 * 用户在文件选择框里可能选中 `C:\Users\me\.ssh\config`，也可能只选到目录。
 */
export function readSshConfig(target?: string): SshImportResult {
  const dir = resolveTarget(target)
  const configPath = looksLikeFile(dir) ? dir : join(dir, 'config')
  const baseDir = dirname(configPath)

  if (!existsSync(configPath)) {
    return {
      dir: baseDir,
      configPath,
      found: false,
      hosts: [],
      keys: listKeys(baseDir),
      warnings: []
    }
  }

  let text = ''
  try {
    text = readFileSync(configPath, 'utf8')
  } catch (err) {
    return {
      dir: baseDir,
      configPath,
      found: false,
      hosts: [],
      keys: listKeys(baseDir),
      warnings: [`读不了 ${configPath}：${err instanceof Error ? err.message : String(err)}`]
    }
  }

  const parsed = parseSshConfig(text)
  const hosts: SshImportHost[] = parsed.hosts.map((host) => {
    if (!host.identityFile) return host

    // ssh 的规则：`~` 展开成家目录；相对路径相对 `~/.ssh`，不是相对 cwd
    const expanded = expandKeyPath(host.identityFile, baseDir)
    const exists = existsSync(expanded)
    return {
      ...host,
      identityAbsolute: expanded,
      keyExists: exists,
      keyEncrypted: exists ? isEncryptedKey(expanded) : undefined
    }
  })

  return { dir: baseDir, configPath, found: true, hosts, keys: listKeys(baseDir), warnings: parsed.warnings }
}

function resolveTarget(target?: string): string {
  const raw = target?.trim()
  if (!raw) return defaultSshDir()
  if (raw === '~') return homedir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return resolve(homedir(), raw.slice(2))
  return resolve(raw)
}

/**
 * 选中的是文件还是目录。
 *
 * 存在就按实际类型判；不存在时按名字猜——用户在文件框里手敲一个路径、
 * 或者本来就还没建过 config，都不该让整个导入流程崩掉。
 */
function looksLikeFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    const name = basename(path).toLowerCase()
    return name === 'config' || name.endsWith('.conf') || name.startsWith('id_') || name.endsWith('.pem')
  }
}

function expandKeyPath(input: string, baseDir: string): string {
  const value = input.trim()
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return resolve(homedir(), value.slice(2))
  return isAbsolute(value) ? value : resolve(baseDir, value)
}

/**
 * 同目录下的私钥候选。
 *
 * 只收 `id_*` 和 `*.pem`：这两个覆盖了绝大多数情况，而把 `.ssh`
 * 里所有文件都列出来（known_hosts、authorized_keys、config）
 * 只会让用户点错。
 */
function listKeys(dir: string): SshKeyFile[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }

  return names
    .filter((name) => name.startsWith('id_') || name.toLowerCase().endsWith('.pem'))
    // `.pub` 是公钥，拿去当私钥用只会得到一条看不懂的解析错误
    .filter((name) => !name.toLowerCase().endsWith('.pub'))
    .filter((name) => {
      try {
        return statSync(join(dir, name)).isFile()
      } catch {
        return false
      }
    })
    .map((name) => {
      const path = join(dir, name)
      return { path, name, encrypted: isEncryptedKey(path) }
    })
}

/**
 * 判断 OpenSSH 私钥是否带口令。
 *
 * 只看文件开头的密文名：`openssh-key-v1\0` 之后是 ciphername，
 * `none` 表示没加密。**不做完整解析**——那要处理各种格式和历史遗留，
 * 这里只需要回答"要不要提示用户填口令"。
 */
export function isEncryptedKey(path: string): boolean {
  try {
    const head = readFileSync(path).subarray(0, 512)
    const magic = Buffer.from('openssh-key-v1\0', 'binary')
    if (!head.subarray(0, magic.length).equals(magic)) {
      // PEM 老格式：`Proc-Type: 4,ENCRYPTED` 表示带口令
      return head.toString('utf8').includes('ENCRYPTED')
    }
    let offset = magic.length
    const length = head.readUInt32BE(offset)
    offset += 4
    if (length > 64) return false
    return head.subarray(offset, offset + length).toString() !== 'none'
  } catch {
    return false
  }
}
