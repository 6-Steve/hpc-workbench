/**
 * 配置目录解析：**纯函数**，不碰文件系统。
 *
 * ## 为什么要有"模式"而不只是一个路径
 *
 * 用户要两件事：① 目录能改；② 能把配置放在**安装目录旁边**（拷走整个文件夹就能走）。
 * 但这两件事会打架——"我上次选的目录"和"程序目录下有 config"到底听谁的？
 * 所以不用隐式的优先级，而是给一个显式的三态：
 *
 * | mode | 行为 | 场景 |
 * |---|---|---|
 * | `auto`（默认） | 程序目录下有 `config/` 就用它，否则用 `%APPDATA%` | 装完不管；手工放个 config 就自动变便携 |
 * | `portable` | 强制用 `<程序目录>/config` | 明确要"绿色版" |
 * | `custom` | 强制用指定目录 | 放到 D:\hpc-config、U 盘、同步盘 |
 *
 * 显式模式下**不猜**：选了 custom 就用 custom，哪怕程序目录下有 config——
 * 静默被覆盖比"多点一次按钮"糟得多。
 *
 * ## 环境变量永远最高
 *
 * `HPC_WORKBENCH_CONFIG_DIR` 压过一切。它是给脚本、CI、"临时指一下"用的，
 * 界面上会显示成"环境变量（只读）"并禁用按钮，免得用户改了没反应。
 */
import { join } from 'node:path'

export type ConfigMode = 'auto' | 'custom' | 'portable'

/** 当前目录是怎么定下来的——界面必须显示，否则用户不知道"我改的到底生效了没" */
export type ConfigDirSource = 'env' | 'custom' | 'portable' | 'default'

/** 存进 `config-location.json` 的内容 */
export interface ConfigLocation {
  mode: ConfigMode
  /** 只有 `mode === 'custom'` 时有意义 */
  dir?: string
}

export interface ConfigDirInput {
  /** 环境变量原始值（未 trim） */
  envDir?: string | undefined
  location: ConfigLocation
  /** 打包后 = exe 所在目录；开发时 = 仓库根 */
  appRoot: string
  /** `app.getPath('userData')` */
  userData: string
  /** `<appRoot>/config` 已经存在 */
  portableExists: boolean
  /** `<appRoot>/config` 可写（不存在时：父目录能否建出它） */
  portableWritable: boolean
}

export interface ConfigDirResolution {
  dir: string
  source: ConfigDirSource
  /** 便携模式会看的目录——界面上要把它显示出来，否则用户不知道"放在哪儿才会被认" */
  portableDir: string
  /** 兜底目录（`%APPDATA%/<productName>/config`） */
  defaultDir: string
  /**
   * 非致命降级原因。目前只有一种：程序目录下有 config 但**写不进去**
   * （用户把应用装到了 Program Files 又手工建了 config）。
   * 这种情况必须退回默认目录**并说明**，否则又是"设了没反应"。
   */
  fallback?: 'portable-not-writable'
}

const MODES: readonly ConfigMode[] = ['auto', 'custom', 'portable']

/**
 * 解析配置文件内容。
 *
 * **任何脏数据都退回 `auto`，绝不抛异常**：这是启动路径，一个手改坏的
 * `config-location.json` 不该让应用打不开。`custom` 但没给目录也算脏数据。
 */
export function parseConfigLocation(raw: string | null | undefined): ConfigLocation {
  if (!raw || !raw.trim()) return { mode: 'auto' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { mode: 'auto' }
  }
  if (typeof parsed !== 'object' || parsed === null) return { mode: 'auto' }

  const record = parsed as Record<string, unknown>
  const mode = record['mode']
  if (typeof mode !== 'string' || !MODES.includes(mode as ConfigMode)) return { mode: 'auto' }

  if (mode === 'custom') {
    const dir = typeof record['dir'] === 'string' ? record['dir'].trim() : ''
    return dir ? { mode: 'custom', dir } : { mode: 'auto' }
  }
  return { mode: mode as ConfigMode }
}

export function resolveConfigDir(input: ConfigDirInput): ConfigDirResolution {
  const portableDir = join(input.appRoot, 'config')
  const defaultDir = join(input.userData, 'config')
  const base = { portableDir, defaultDir }

  // ① 环境变量：最高优先级，连 custom 也压
  const env = input.envDir?.trim()
  if (env) return { ...base, dir: env, source: 'env' }

  // ② 显式指定
  if (input.location.mode === 'custom' && input.location.dir) {
    return { ...base, dir: input.location.dir, source: 'custom' }
  }

  /*
   * ③ 便携：显式要求，或者 auto 且程序目录下已经有 config。
   *
   * `auto` 只认**已存在**的目录，不会替用户建——否则一次探测就把应用
   * 永久变成便携模式，而用户根本没做过这个决定。
   */
  const wantsPortable =
    input.location.mode === 'portable' || (input.location.mode === 'auto' && input.portableExists)

  if (wantsPortable) {
    if (input.portableWritable) return { ...base, dir: portableDir, source: 'portable' }
    return { ...base, dir: defaultDir, source: 'default', fallback: 'portable-not-writable' }
  }

  // ④ 默认
  return { ...base, dir: defaultDir, source: 'default' }
}
