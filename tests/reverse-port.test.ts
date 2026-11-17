/**
 * 反向隧道的"退端口"逻辑，以及两条 shell 探测命令。
 *
 * 这几件事都是真机上才暴露出来的：
 * - 默认端口被别人占（127.0.0.1 全用户共享）→ 换一个端口就能通
 * - 换了端口，集群上的 http_proxy 还指着老端口 → 隧道白开
 * - 拼 shell 脚本时 `do;` 是语法错误 → 断言"包含某个字符串"根本拦不住
 *
 * 关于"为什么不 spawn 一个 bash 去 -n 检查"：本机沙箱里 `spawnSync('bash')` 直接 EBUSY，
 * 测试只能静默跳过——那比没有测试更糟（看着是绿的，其实一条都没跑）。
 * 所以改成检查真正会出错的那几个结构特征。
 */
import { describe, expect, it } from 'vitest'
import {
  freePortProbeCommand,
  parseFreePort,
  portOwnerCommand,
  suggestPorts
} from '../src/main/domain/port-owner'
import { parseProxyLine, proxyLineCommand, PROXY_FILES } from '../src/main/domain/proxy-config'
import { isBindFailure, openWithFallback } from '../src/main/domain/reverse-port'
import { proxyExportSnippet } from '../src/shared/proxy'

function bindError(port: number): Error {
  return new Error(`Unable to bind to 127.0.0.1:${port}`)
}

/** 生成的一行 shell 脚本有没有明显的结构问题 */
function shellProblems(script: string): string[] {
  const problems: string[] = []
  if (/\bdo\s*;/.test(script)) problems.push('`do` 后面直接跟了 `;`')
  const doCount = (script.match(/\bdo\b/g) ?? []).length
  const doneCount = (script.match(/\bdone\b/g) ?? []).length
  if (doCount !== doneCount) problems.push(`do/done 不配对：${doCount} vs ${doneCount}`)
  if ((script.match(/'/g) ?? []).length % 2 !== 0) problems.push('单引号不成对')
  if ((script.match(/"/g) ?? []).length % 2 !== 0) problems.push('双引号不成对')
  return problems
}

/** 假 runner：按命令内容区分"查所有者"和"找空闲端口" */
function makeRunner(options: { owner?: string; free?: string } = {}): {
  calls: string[]
  exec: (command: string) => Promise<{ stdout: string; code: number; stderr: string }>
} {
  const calls: string[] = []
  return {
    calls,
    async exec(command: string) {
      calls.push(command)
      // 两条命令的特征：查所有者带 getent，找空闲端口是 for p in ...
      const stdout = command.includes('getent') ? (options.owner ?? '') : (options.free ?? '')
      return { stdout, code: 0, stderr: '' }
    }
  }
}

describe('isBindFailure：只认"服务端拒绝绑定"', () => {
  it('ssh2 的原话算', () => {
    expect(isBindFailure(bindError(55555))).toBe(true)
  })

  it('大小写不敏感', () => {
    expect(isBindFailure(new Error('unable to bind to 127.0.0.1:1'))).toBe(true)
  })

  it('其它错误一律不算，不能被当成"换个端口试试"', () => {
    // 连接断了、认证失败都不该被这里悄悄改端口——那只会让用户更难查出真因
    expect(isBindFailure(new Error('与 hpc 的连接已断开'))).toBe(false)
    expect(isBindFailure(new Error('Permission denied'))).toBe(false)
    expect(isBindFailure('boom')).toBe(false)
  })
})

describe('openWithFallback', () => {
  it('一次就成：不查任何东西，直接返回', async () => {
    const run = makeRunner()
    const tried: number[] = []
    const result = await openWithFallback({
      run,
      requested: 55556,
      tryOpen: async (port) => {
        tried.push(port)
        return { listenPort: port }
      }
    })
    expect(tried).toEqual([55556])
    expect(result.fallback).toBeNull()
    expect(run.calls).toHaveLength(0)
  })

  it('绑定被拒时换到第一个空闲端口，并报出占用者', async () => {
    // 55558 = 0xD906
    const run = makeRunner({ owner: '10310:sdchen\n', free: 'D906\n' })
    const tried: number[] = []
    const result = await openWithFallback({
      run,
      requested: 55556,
      tryOpen: async (port) => {
        tried.push(port)
        if (port === 55556) throw bindError(port)
        return { listenPort: port }
      }
    })

    expect(tried).toEqual([55556, 55558])
    expect(result.fallback).toEqual({
      requested: 55556,
      actual: 55558,
      owner: { uid: 10310, username: 'sdchen' },
      // 没传 selfUsername，所以判不出"是不是自己"
      ownerIsSelf: false
    })
  })

  it('查占用者查不到也不影响换端口', async () => {
    const run = makeRunner({ free: 'D906\n' })
    const result = await openWithFallback({
      run,
      requested: 55556,
      tryOpen: async (port) => {
        if (port === 55556) throw bindError(port)
        return { listenPort: port }
      }
    })
    expect(result.fallback?.owner).toBeNull()
    expect(result.fallback?.actual).toBe(55558)
  })

  it('换到的端口也失败时，抛出第二次的错误（而不是第一次的）', async () => {
    const run = makeRunner({ free: 'D906\n' })
    await expect(
      openWithFallback({
        run,
        requested: 55556,
        tryOpen: async (port) => {
          if (port === 55558) throw new Error('第二条也炸了')
          throw bindError(port)
        }
      })
    ).rejects.toThrow('第二条也炸了')
  })

  it('附近没有空闲端口时，抛回**原始**错误，不编新原因', async () => {
    const run = makeRunner({ free: '' })
    await expect(
      openWithFallback({
        run,
        requested: 55556,
        tryOpen: async (port) => {
          throw bindError(port)
        }
      })
    ).rejects.toThrow('Unable to bind to 127.0.0.1:55556')
  })

  it('不是绑定失败就原样抛，连查都不查', async () => {
    const run = makeRunner()
    await expect(
      openWithFallback({
        run,
        requested: 55556,
        tryOpen: async () => {
          throw new Error('连接已断开')
        }
      })
    ).rejects.toThrow('连接已断开')
    expect(run.calls).toHaveLength(0)
  })

  it('探测到的端口在 bind 时被抢了，就换下一个候选再试', async () => {
    // 实测遇过：端口探测时是空的，bind 那一刻被别人的新连接抓走（临时端口段里很常见）。
    // 只试一个候选的老实现在这里会直接失败，用户看到的是"换个端口也不行"。
    const answers = ['D905', 'D906']
    let call = 0
    const run = {
      calls: [] as string[],
      async exec(command: string) {
        this.calls.push(command)
        if (!command.includes('getent')) call += 1
        return { stdout: answers[Math.min(call - 1, answers.length - 1)] ?? '', code: 0, stderr: '' }
      }
    }

    const tried: number[] = []
    const result = await openWithFallback({
      run,
      requested: 55556,
      tryOpen: async (port) => {
        tried.push(port)
        // 55556 是用户要的、55557 是被别人抢走的那个、55558 才成功
        if (port !== 55558) throw bindError(port)
        return { listenPort: port }
      }
    })

    expect(tried).toEqual([55556, 55557, 55558])
    expect(result.fallback?.actual).toBe(55558)
  })

  it('候选试满次数还不行，抛回原始错误（指向用户要的那个端口）', async () => {
    const run = makeRunner({ free: 'D905\n' })
    await expect(
      openWithFallback({
        run,
        requested: 55556,
        attempts: 2,
        tryOpen: async (port) => {
          throw bindError(port)
        }
      })
    ).rejects.toThrow('Unable to bind to 127.0.0.1:55556')
  })

  it('候选里不包含用户原本要的那个端口', async () => {
    const run = makeRunner({ free: 'D905\n' })
    await openWithFallback({
      run,
      requested: 55556,
      candidates: [55556, 55557],
      tryOpen: async (port) => {
        if (port === 55556) throw bindError(port)
        return { listenPort: port }
      }
    })
    const probeCommand = run.calls.find((command) => command.startsWith('for p in'))
    expect(probeCommand).toBeDefined()
    // 55556 = 0xD904，不能被当作候选再去试一次
    expect(probeCommand).not.toContain('D904')
    expect(probeCommand).toContain('D905')
  })
})

describe('找空闲端口的命令', () => {
  it('端口转成十六进制，并只取第一个', () => {
    const command = freePortProbeCommand([55557, 55558])
    expect(command).toContain('D905')
    expect(command).toContain('D906')
    expect(command).toContain('break')
  })

  it('结构上是一段能跑的循环', () => {
    // 上一版用 `; ` 把片段 join 起来，拼出 `do;`，bash 直接 syntax error。
    // 断言"包含 D905"是拦不住的——必须检查结构。
    expect(shellProblems(freePortProbeCommand([55557, 55558]))).toEqual([])
  })

  it('解析十六进制输出；没有输出就是"全占着"', () => {
    expect(parseFreePort('D906\n')).toBe(55558)
    expect(parseFreePort('')).toBeNull()
    expect(parseFreePort('\n')).toBeNull()
  })
})

describe('查所有者的命令（回归）', () => {
  it('结构上没有 `do;` 这类错误', () => {
    expect(shellProblems(portOwnerCommand(55555))).toEqual([])
  })
})

describe('suggestPorts', () => {
  it('从原端口往后取', () => {
    expect(suggestPorts(55556, 3)).toEqual([55557, 55558, 55559])
  })
})

describe('读集群 http_proxy 端口', () => {
  it('按登录 shell 的顺序找文件', () => {
    expect(PROXY_FILES[0]).toBe('.profile')
    const command = proxyLineCommand()
    for (const name of PROXY_FILES) expect(command).toContain(name)
  })

  it('远端只捞原文，结构上没有 `do;`', () => {
    const command = proxyLineCommand()
    expect(shellProblems(command)).toEqual([])
    // 解析在 JS 里做，远端不该出现 sed 的替换语法
    expect(command).not.toContain('sed')
  })

  it('认得集群上那一行的原文写法', () => {
    // ~/.profile 第 31 行的实际形状
    expect(parseProxyLine('export http_proxy="http://127.0.0.1:55555"')).toBe(55555)
  })

  it('无引号、带路径、带尾斜杠都能认', () => {
    expect(parseProxyLine('http_proxy=http://10.0.0.5:3128')).toBe(3128)
    expect(parseProxyLine('export http_proxy=http://127.0.0.1:55556/')).toBe(55556)
    expect(parseProxyLine("export http_proxy='http://127.0.0.1:7897'")).toBe(7897)
  })

  it('前后还有别的行时，只挑 http_proxy 那一行', () => {
    const raw = ['export PATH="$HOME/.local/bin:$PATH"', 'export http_proxy="http://127.0.0.1:55556"', 'done'].join('\n')
    expect(parseProxyLine(raw)).toBe(55556)
  })

  it('只配了 https_proxy 时不算——我们要的是 http_proxy 那一行', () => {
    expect(parseProxyLine('export https_proxy="http://127.0.0.1:55555"')).toBeNull()
  })

  it('没写端口时按协议默认值，认不出协议就不猜', () => {
    expect(parseProxyLine('export http_proxy=http://proxy.corp')).toBe(80)
    expect(parseProxyLine('export http_proxy=https://proxy.corp')).toBe(443)
  })

  it('空输出、乱写的值都返回 null', () => {
    expect(parseProxyLine('')).toBeNull()
    expect(parseProxyLine('\n\n')).toBeNull()
    expect(parseProxyLine('export http_proxy=')).toBeNull()
    expect(parseProxyLine('export http_proxy="http://127.0.0.1:99999"')).toBeNull()
  })
})

describe('给用户复制的 export 片段', () => {
  it('六个变量都给到，且只对当前 shell 生效', () => {
    const snippet = proxyExportSnippet(55562)
    expect(snippet).toContain('export http_proxy=http://127.0.0.1:55562')
    for (const name of ['https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
      expect(snippet).toContain(name)
    }
    // 三行：第一行给值，后两行引用它（和用户自己写的那段一致）
    expect(snippet.split('\n')).toHaveLength(3)
  })
})

describe('openWithFallback · 占用者是不是自己', () => {
  /*
   * 真实场景：用户已经开着一条 21056，再开一条同端口的必然绑不上。
   * 集群上那个监听的 owner 就是他自己的账号（sshd 会话），
   * 文案必须说"就是你自己"，否则用户会以为有别人的进程、甚至怀疑是别的工具建的隧道。
   */
  it('占用者账号等于当前账号 → ownerIsSelf', async () => {
    const run = makeRunner({ owner: '10515:alice\n', free: '5241\n' })
    const result = await openWithFallback({
      run,
      requested: 21056,
      selfUsername: 'alice',
      tryOpen: async (port) => {
        if (port === 21056) throw bindError(port)
        return { listenPort: port }
      }
    })
    expect(result.fallback?.ownerIsSelf).toBe(true)
  })

  it('占用者是别人 → 不误报成自己', async () => {
    const run = makeRunner({ owner: '10310:sdchen\n', free: '5241\n' })
    const result = await openWithFallback({
      run,
      requested: 21056,
      selfUsername: 'alice',
      tryOpen: async (port) => {
        if (port === 21056) throw bindError(port)
        return { listenPort: port }
      }
    })
    expect(result.fallback?.ownerIsSelf).toBe(false)
  })
})
