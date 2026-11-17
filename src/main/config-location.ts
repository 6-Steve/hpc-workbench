/**
 * 配置目录的**磁盘侧**：指针文件读写、可写性探测。
 *
 * 和 `config-dir.ts` 分开是刻意的——那边是纯函数（好测、不依赖环境），
 * 这边才有 `fs`。混在一起就得给每个纯逻辑都 mock 一遍文件系统。
 */
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseConfigLocation, type ConfigLocation } from './config-dir'

/** 指针文件的固定位置（永远在 userData 下，不会跟着配置目录跑） */
export const LOCATION_FILENAME = 'config-location.json'

/**
 * 读指针。文件不存在、读不动、内容坏了，一律当 `auto`。
 *
 * 这是启动路径：一个手改坏的 JSON 不该让应用打不开。
 */
export function readConfigLocation(file: string): ConfigLocation {
  try {
    return parseConfigLocation(readFileSync(file, 'utf8'))
  } catch {
    return { mode: 'auto' }
  }
}

export function writeConfigLocation(file: string, location: ConfigLocation): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(location, null, 2)}\n`, 'utf8')
}

/**
 * 目录**已存在**时判断能不能写：在里面落一个探针文件再删掉。
 *
 * 不看 `fs.access(W_OK)`：Windows 上它对 ACL 的判断不可靠，
 * 尤其是"以管理员装到 Program Files、普通用户运行"这种组合——
 * `access` 说可写、真写的时候 EACCES。**只有真写一次才算数。**
 */
export function isDirWritable(dir: string): boolean {
  const probe = join(dir, `.write-probe-${randomUUID()}`)
  try {
    writeFileSync(probe, '')
    rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * 目标目录**还不存在**时判断能不能建：探测它的父目录。
 *
 * 关键是**不留下任何痕迹**（父目录里落一个探针就删）。
 * 如果这里顺手 `mkdir -p` 了，下次启动 `auto` 模式就会看到"config 存在" →
 * 应用悄悄变成便携模式，而用户从没做过这个选择。
 */
export function canCreateAt(target: string): boolean {
  const parent = dirname(target)
  try {
    mkdirSync(parent, { recursive: true })
    return isDirWritable(parent)
  } catch {
    return false
  }
}

/**
 * 换目录时把已有配置**搬过去**（只搬不覆盖）。
 *
 * 不做这一步的话，用户点完"用程序目录"→ 应用重启 → 看到"找不到配置文件"，
 * 第一反应一定是"又坏了"。而实际上只是新目录是空的。
 * 换目录这个动作在用户心里等于"挪个地方"，不是"清空重来"。
 *
 * 只搬三个文件，不搬 `.cache/`：
 * - `profiles.json` 主机与账号
 * - `credentials.json` 密文凭据（同机同账户下换目录仍能解开——DPAPI/Keychain 绑的是
 *   系统账户，不是路径）
 * - `known_hosts.json` 主机指纹，不搬的话换目录后第一次连接会重新弹指纹确认
 */
export function copyConfigFiles(from: string, to: string): string[] {
  const NAMES = ['profiles.json', 'credentials.json', 'known_hosts.json']
  const copied: string[] = []
  if (resolve(from) === resolve(to)) return copied

  for (const name of NAMES) {
    const source = join(from, name)
    const target = join(to, name)
    // 目标已有同名文件时**不覆盖**：那可能是用户特意放的更新的一份
    if (!existsSync(source) || existsSync(target)) continue
    try {
      copyFileSync(source, target)
      copied.push(name)
    } catch {
      // 单个文件搬不过去不该让整个切换失败——最多是新目录缺这一个文件
    }
  }
  return copied
}
