/**
 * 配置目录落在哪儿、以及切换时的搬运。
 *
 * 这条规则只有几十行，但它决定"装好的应用能不能存住东西"——
 * 落错地方的后果不是报错，而是**静默写不进去**（见 `config-dir.ts` 的注释）。
 *
 * 所以这里断言的不是"等于某个字符串"，而是几条**不退让的性质**：
 * 优先级顺序、脏指针不炸、便携目录不可写要退回且说明、换目录要搬文件。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseConfigLocation, resolveConfigDir, type ConfigDirInput } from '../src/main/config-dir'
import {
  canCreateAt,
  copyConfigFiles,
  isDirWritable,
  readConfigLocation,
  writeConfigLocation
} from '../src/main/config-location'

const ROOT = mkdtempSync(join(tmpdir(), 'hpc-configdir-'))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

const APP_ROOT = join(ROOT, 'app')
const USER_DATA = join(ROOT, 'userdata')

function input(patch: Partial<ConfigDirInput> = {}): ConfigDirInput {
  return {
    envDir: undefined,
    location: { mode: 'auto' },
    appRoot: APP_ROOT,
    userData: USER_DATA,
    portableExists: false,
    portableWritable: true,
    ...patch
  }
}

describe('config-dir · 优先级', () => {
  it('默认：落在 userData/config', () => {
    const r = resolveConfigDir(input())
    expect(r.dir).toBe(join(USER_DATA, 'config'))
    expect(r.source).toBe('default')
  })

  it('auto + 程序目录下已有 config → 自动变便携', () => {
    const r = resolveConfigDir(input({ portableExists: true }))
    expect(r.dir).toBe(join(APP_ROOT, 'config'))
    expect(r.source).toBe('portable')
  })

  it('auto + 程序目录下没有 config → 不会去建，仍用默认', () => {
    // 关键：`auto` 不能替用户做决定。探测一次就变便携的话，
    // 用户从没点过"用程序目录"，配置却跑到了安装目录
    expect(resolveConfigDir(input({ portableExists: false })).source).toBe('default')
  })

  it('显式 portable 即使目录还不存在也用程序目录', () => {
    const r = resolveConfigDir(input({ location: { mode: 'portable' }, portableExists: false }))
    expect(r.dir).toBe(join(APP_ROOT, 'config'))
    expect(r.source).toBe('portable')
  })

  it('custom 生效，并且**压过**程序目录下的 config', () => {
    // 用户明确选过就不能被悄悄覆盖——"我选的怎么没生效"比"多点一次"糟得多
    const r = resolveConfigDir(
      input({ location: { mode: 'custom', dir: join(ROOT, 'mine') }, portableExists: true })
    )
    expect(r.dir).toBe(join(ROOT, 'mine'))
    expect(r.source).toBe('custom')
  })

  it('环境变量压过一切（包括 custom）', () => {
    const r = resolveConfigDir(
      input({
        envDir: join(ROOT, 'from-env'),
        location: { mode: 'custom', dir: join(ROOT, 'mine') },
        portableExists: true
      })
    )
    expect(r.dir).toBe(join(ROOT, 'from-env'))
    expect(r.source).toBe('env')
  })

  it('空白环境变量等于没设置', () => {
    expect(resolveConfigDir(input({ envDir: '   ' })).source).toBe('default')
    expect(resolveConfigDir(input({ envDir: '' })).source).toBe('default')
  })
})

describe('config-dir · 便携目录不可写', () => {
  /*
   * 典型场景：应用装到了 Program Files，用户又在安装目录里建了 config。
   * 直接用它 → 凭据/known_hosts 写不进去，而且**不报错**。
   * 所以必须退回默认目录，并且把原因带回去给界面显示。
   */
  it('auto：退回默认，并标记 fallback', () => {
    const r = resolveConfigDir(input({ portableExists: true, portableWritable: false }))
    expect(r.dir).toBe(join(USER_DATA, 'config'))
    expect(r.source).toBe('default')
    expect(r.fallback).toBe('portable-not-writable')
  })

  it('显式 portable：同样退回，不硬闯', () => {
    const r = resolveConfigDir(
      input({ location: { mode: 'portable' }, portableExists: true, portableWritable: false })
    )
    expect(r.dir).toBe(join(USER_DATA, 'config'))
    expect(r.fallback).toBe('portable-not-writable')
  })

  it('可写时没有 fallback', () => {
    expect(resolveConfigDir(input({ portableExists: true })).fallback).toBeUndefined()
  })
})

describe('config-dir · 解析指针文件', () => {
  it('空 / 坏 / 未知一律退回 auto，不抛', () => {
    for (const raw of [null, undefined, '', '   ', '{', '[]', '{"mode":"nope"}', '{"mode":42}']) {
      expect(parseConfigLocation(raw).mode, String(raw)).toBe('auto')
    }
  })

  it('custom 但没给目录等于脏数据 → auto', () => {
    // 否则会退化成"custom 但没有 dir"，resolve 里还得再判一次
    expect(parseConfigLocation('{"mode":"custom"}').mode).toBe('auto')
    expect(parseConfigLocation('{"mode":"custom","dir":"   "}').mode).toBe('auto')
  })

  it('合法值原样返回，多余字段忽略', () => {
    expect(parseConfigLocation('{"mode":"portable","x":1}')).toEqual({ mode: 'portable' })
    expect(parseConfigLocation('{"mode":"custom","dir":"D:\\\\cfg"}')).toEqual({
      mode: 'custom',
      dir: 'D:\\cfg'
    })
  })

  it('路径前后空格会被去掉（粘贴来的路径很常见）', () => {
    expect(parseConfigLocation('{"mode":"custom","dir":"  D:\\\\cfg  "}').dir).toBe('D:\\cfg')
  })
})

describe('config-location · 读写与探测', () => {
  it('写进去能读回来', () => {
    const file = join(ROOT, 'loc', 'config-location.json')
    writeConfigLocation(file, { mode: 'portable' })
    expect(readConfigLocation(file)).toEqual({ mode: 'portable' })
  })

  it('文件不存在时读成 auto', () => {
    expect(readConfigLocation(join(ROOT, 'nope.json'))).toEqual({ mode: 'auto' })
  })

  it('目录可写 → true', () => {
    expect(isDirWritable(ROOT)).toBe(true)
  })

  it.runIf(process.platform === 'win32')('盘符不存在 → 建不出来', () => {
    expect(canCreateAt('Q:\\definitely-not-here\\config')).toBe(false)
  })

  it('父目录存在 → 可以建', () => {
    expect(canCreateAt(join(ROOT, 'newdir', 'config'))).toBe(true)
  })

  it('探测不留下痕迹', () => {
    /*
     * 探测时顺手 `mkdir -p` 的话，下次启动 `auto` 模式就会看到"config 存在"，
     * 应用**悄悄变成便携模式**，而用户从没做过这个选择。
     */
    const parent = join(ROOT, 'probe-target')
    const target = join(parent, 'config')
    expect(canCreateAt(target)).toBe(true)

    expect(existsSync(target)).toBe(false)
    // 探针文件也不能留下
    expect(readdirSync(parent).filter((name) => name.startsWith('.write-probe-'))).toEqual([])
  })
})

describe('config-location · 换目录时搬文件', () => {
  function prepare(name: string, files: Record<string, string>): string {
    const dir = join(ROOT, name)
    mkdirSync(dir, { recursive: true })
    for (const [file, content] of Object.entries(files)) {
      writeFileSync(join(dir, file), content, 'utf8')
    }
    return dir
  }

  it('搬三个文件，不搬缓存', () => {
    const from = prepare('from-a', {
      'profiles.json': '{"a":1}',
      'credentials.json': '{"c":1}',
      'known_hosts.json': '{"h":1}',
      'state.json': '{"s":1}'
    })
    const to = prepare('to-a', {})
    const copied = copyConfigFiles(from, to)

    expect(copied.sort()).toEqual(['credentials.json', 'known_hosts.json', 'profiles.json'])
    expect(readFileSync(join(to, 'profiles.json'), 'utf8')).toBe('{"a":1}')
    expect(() => readFileSync(join(to, 'state.json'))).toThrow()
  })

  it('目标已有同名文件时**不覆盖**', () => {
    // 新目录里那份可能是用户特意放的、更新的一份
    const from = prepare('from-b', { 'profiles.json': '{"old":1}' })
    const to = prepare('to-b', { 'profiles.json': '{"new":1}' })
    expect(copyConfigFiles(from, to)).toEqual([])
    expect(readFileSync(join(to, 'profiles.json'), 'utf8')).toBe('{"new":1}')
  })

  it('同一个目录 → 什么都不做', () => {
    const dir = prepare('same', { 'profiles.json': '{}' })
    expect(copyConfigFiles(dir, dir)).toEqual([])
  })
})
