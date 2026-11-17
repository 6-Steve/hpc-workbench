import { describe, expect, it } from 'vitest'
import {
  buildSbatchArguments,
  describeStartTime,
  explainSbatchError,
  isValidNodeName,
  parseTestOnlyOutput,
  buildSbatchScript,
  formatSbatchMemory,
  formatSbatchTime,
  parseSubmittedJobId,
  type JobSpec
} from '../src/main/domain/sbatch'

const base: JobSpec = {
  jobName: 'train-exp-01',
  partition: 'compute',
  nodes: 1,
  tasksPerNode: 1,
  cpusPerTask: 8,
  gpusPerNode: 1,
  timeLimitMinutes: 120,
  outputPattern: '%x-%j.out',
  command: 'python train.py --epochs 10'
}

describe('formatSbatchTime', () => {
  it('不到一天用 HH:MM:SS', () => {
    expect(formatSbatchTime(120)).toBe('02:00:00')
    expect(formatSbatchTime(90)).toBe('01:30:00')
  })

  it('超过一天带天数前缀', () => {
    expect(formatSbatchTime(1440)).toBe('1-00:00:00')
    expect(formatSbatchTime(2880)).toBe('2-00:00:00')
  })

  it('不足一分钟按一分钟算，不出现 00:00:00', () => {
    // 00:00:00 在 SLURM 里会被理解成立刻超时
    expect(formatSbatchTime(0)).toBe('00:01:00')
    expect(formatSbatchTime(0.4)).toBe('00:01:00')
  })
})

describe('formatSbatchMemory', () => {
  it('整数 GB 用 G 后缀', () => {
    expect(formatSbatchMemory(98304)).toBe('96G')
    expect(formatSbatchMemory(1024)).toBe('1G')
  })

  it('非整数 GB 用 M 后缀，不瞎四舍五入', () => {
    expect(formatSbatchMemory(1500)).toBe('1500M')
  })
})

describe('buildSbatchScript', () => {
  it('生成可执行的 bash 脚本头', () => {
    const script = buildSbatchScript(base)
    expect(script.startsWith('#!/bin/bash')).toBe(true)
    // 某条命令失败就停，否则中间挂了后面照样跑，最后得到"成功"的假象
    expect(script).toContain('set -e')
  })

  it('#SBATCH 指令齐全且顺序稳定', () => {
    const script = buildSbatchScript(base)
    expect(script).toContain('#SBATCH --job-name=train-exp-01')
    expect(script).toContain('#SBATCH --partition=compute')
    expect(script).toContain('#SBATCH --nodes=1')
    expect(script).toContain('#SBATCH --cpus-per-task=8')
    expect(script).toContain('#SBATCH --gres=gpu:1')
    expect(script).toContain('#SBATCH --time=02:00:00')
    expect(script).toContain('#SBATCH --output=%x-%j.out')
  })

  it('gres 是每节点语义，不是总数', () => {
    // 2 节点 × 每节点 4 卡 = 总共 8 张，但脚本里必须写 gpu:4
    const script = buildSbatchScript({ ...base, nodes: 2, gpusPerNode: 4 })
    expect(script).toContain('--gres=gpu:4')
    expect(script).toContain('--nodes=2')
    expect(script).not.toContain('--gres=gpu:8')
  })

  it('0 卡作业完全不写 --gres（集群不认 gpu:0）', () => {
    // 实测集群会报 `tres format not match: gres:gpu:0 (scir extension)!`
    const script = buildSbatchScript({ ...base, gpusPerNode: 0 })
    expect(script).not.toContain('--gres')
    expect(buildSbatchArguments({ ...base, gpusPerNode: 0 })).not.toContain('--gres=gpu:0')
  })

  it('指定了型号就锁死，不能跑在别的卡上', () => {
    // 用户从"资源"页点「租这个 A100」进来，结果跑在 V100 上就是功能性错误
    const script = buildSbatchScript({ ...base, gpuType: 'nvidia_a100_80gb_pcie', gpusPerNode: 2 })
    expect(script).toContain('--gres=gpu:nvidia_a100_80gb_pcie:2')
    // 不能退化成不限型号
    expect(script).not.toContain('--gres=gpu:2\n')
  })

  it('没指定型号就不限，调度器给什么用什么', () => {
    expect(buildSbatchScript({ ...base, gpusPerNode: 2 })).toContain('--gres=gpu:2')
  })

  it('型号前后的空格会被清掉', () => {
    expect(buildSbatchScript({ ...base, gpuType: '  a100-pcie-40gb  ' })).toContain('--gres=gpu:a100-pcie-40gb:1')
  })

  it('没给内存就不写 --mem，交给集群默认', () => {
    const script = buildSbatchScript(base)
    expect(script).not.toContain('--mem=')
  })

  it('给了内存才写', () => {
    const script = buildSbatchScript({ ...base, memoryMb: 98304 })
    expect(script).toContain('--mem=96G')
  })

  it('没给工作目录就不写 --chdir', () => {
    expect(buildSbatchScript(base)).not.toContain('--chdir')
    expect(buildSbatchScript({ ...base, workDir: '/home/user01/proj' })).toContain('--chdir=/home/user01/proj')
  })

  it('环境准备默认是注释掉的，不擅自启用', () => {
    // 猜错 module 名字会让作业一起手就失败，比让用户自己填更糟
    const script = buildSbatchScript(base)
    expect(script).toContain('# module load cuda/12.1')
    expect(script).toContain('# conda activate myenv')
    expect(script).not.toContain('\nmodule load cuda')
  })

  it('用户填了环境准备就原样放进去', () => {
    const script = buildSbatchScript({ ...base, envSetup: 'module load cuda/12.1\nconda activate myenv' })
    expect(script).toContain('module load cuda/12.1')
    expect(script).toContain('conda activate myenv')
  })

  it('额外指令会自动去掉重复的 #SBATCH 前缀', () => {
    const script = buildSbatchScript({ ...base, extraDirectives: '#SBATCH --mail-type=END\n\n--constraint=a100' })
    expect(script).toContain('#SBATCH --mail-type=END')
    expect(script).toContain('#SBATCH --constraint=a100')
    // 不能出现 "#SBATCH #SBATCH"
    expect(script).not.toContain('#SBATCH #SBATCH')
  })

  it('命令原样保留，不转义', () => {
    const script = buildSbatchScript({ ...base, command: 'python train.py --lr 1e-4 --name "exp a"' })
    expect(script).toContain('python train.py --lr 1e-4 --name "exp a"')
  })

  it('脚本末尾有换行（避免某些编辑器/shell 的边界问题）', () => {
    expect(buildSbatchScript(base).endsWith('\n')).toBe(true)
  })

  it('打印节点名，出问题时能立刻知道跑在哪台机器上', () => {
    const script = buildSbatchScript(base)
    expect(script).toContain('hostname')
    expect(script).toContain('SLURM_JOB_ID')
  })
})

describe('buildSbatchArguments（用已有脚本模式）', () => {
  it('和脚本模式用同一套参数', () => {
    const args = buildSbatchArguments(base)
    expect(args).toContain('--job-name=train-exp-01')
    expect(args).toContain('--gres=gpu:1')
    expect(args).toContain('--time=02:00:00')
  })

  it('参数模式也支持锁定型号', () => {
    expect(buildSbatchArguments({ ...base, gpuType: 'tesla_v100-sxm2-16gb' })).toContain(
      '--gres=gpu:tesla_v100-sxm2-16gb:1'
    )
  })

  it('不含命令本身（命令由 sbatch 去执行那个文件）', () => {
    const args = buildSbatchArguments(base)
    expect(args.join(' ')).not.toContain('python train.py')
  })
})

describe('parseSubmittedJobId', () => {
  it('从标准输出里取作业号', () => {
    expect(parseSubmittedJobId('Submitted batch job 12345\n')).toBe('12345')
  })

  it('取不到返回 null，不瞎编一个 0', () => {
    // 编个 0 会让用户以为交上去了，实际可能被策略拒绝了
    expect(parseSubmittedJobId('')).toBeNull()
    expect(parseSubmittedJobId('sbatch: error: invalid partition')).toBeNull()
  })
})

describe('explainSbatchError：把 sbatch 报错翻成人话', () => {
  it('--gres 不写型号：scir 扩展会拒（真实报错）', () => {
    // 实测：sbatch --gres=gpu:1 被拒；--gres=gpu:a100-pcie-40gb:1 才通过
    const stderr =
      'sbatch: error: Other Error: tres format not match: gres:gpu:1 (scir extension)!\n' +
      'sbatch: error: Batch job submission failed: Unspecified error'

    const hint = explainSbatchError(stderr)
    expect(hint).toBeTruthy()
    // 用户必须知道"去选型号"，而不是"卡数写错了"
    expect(hint).toContain('型号')
    expect(hint).toContain('scir')
  })

  it('--gres=gpu:0 也命中同一个翻译，不会掉到未知分支', () => {
    const hint = explainSbatchError('Other Error: tres format not match: gres:gpu:0 (scir extension)!')
    expect(hint).toContain('型号')
  })

  it('配比超限：说清楚该改哪个数（真实报错）', () => {
    // 用户真机上撞到的原文，照抄
    const stderr =
      'sbatch: error: Other Error: total cpus num(8) > tres total num(1) * cpu_limit(4) (scir extension)!\n' +
      'sbatch: error: Batch job submission failed: Unspecified error'

    const hint = explainSbatchError(stderr)
    expect(hint).toBeTruthy()
    // 必须点名具体数字，否则用户还是不知道该填多少
    expect(hint).toContain('8')
    expect(hint).toContain('4')
    expect(hint).toContain('1 张卡')
    // 给出两条可选修法
    expect(hint).toContain('核数改成 4')
    expect(hint).toContain('卡数加到 2 张')
  })

  it('多卡时的建议算得对', () => {
    const hint = explainSbatchError('total cpus num(16) > tres total num(2) * cpu_limit(4)')
    expect(hint).toContain('最多只能配 8 个核')
    expect(hint).toContain('卡数加到 4 张')
  })

  it('分区名不存在', () => {
    expect(explainSbatchError('sbatch: error: invalid partition name: gpu')).toContain('不存在')
  })

  it('资源凑不出来', () => {
    const hint = explainSbatchError('sbatch: error: Batch job submission failed: Requested node configuration is not available')
    expect(hint).toContain('凑不出')
  })

  it('超过账户配额', () => {
    expect(explainSbatchError('Job violates accounting/QOS policy (job 1)')).toContain('配额')
  })

  it('认不出来的错误返回 null，不硬编一个解释', () => {
    // 瞎猜原因比不解释更误导
    expect(explainSbatchError('some totally unknown error')).toBeNull()
    expect(explainSbatchError('')).toBeNull()
  })
})

describe('parseTestOnlyOutput：预估启动时间', () => {
  it('解析集群给的排程预测', () => {
    const out =
      'sbatch: Job 208893 to start at 2026-11-03T08:45:28 using 2 processors on nodes gpu05 in partition compute'
    const result = parseTestOnlyOutput(out)
    expect(result.startAt).toBe('2026-11-03T08:45:28')
    expect(result.nodes).toBe('gpu05')
    expect(result.processors).toBe(2)
  })

  it('保留原始时间串，不转 Date（集群时间是本地的，转了就错时区）', () => {
    const result = parseTestOnlyOutput('to start at 2026-11-03T08:45:28 using 1 processor on node gpu01')
    expect(result.startAt).toBe('2026-11-03T08:45:28')
    expect(typeof result.startAt).toBe('string')
  })

  it('单数 processor 也认', () => {
    expect(parseTestOnlyOutput('to start at 2026-11-03T08:45:28 using 1 processor on node gpu01').processors).toBe(1)
  })

  it('没有排程信息时三项都返回 null', () => {
    expect(parseTestOnlyOutput('sbatch: error: something')).toEqual({
      startAt: null,
      nodes: null,
      processors: null
    })
  })
})

describe('describeStartTime：排程时间要带日期和相对量', () => {
  const base = new Date('2026-11-03T10:00:00').getTime()

  it('跨天时必须显示日期，否则 02:26 是哪个 02:26 说不清', () => {
    const text = describeStartTime('2026-11-04T02:26:00', base)
    expect(text).toContain('11-04 02:26')
    // 只有时分会让用户自己猜是今天还是明天
    expect(text).not.toBe('02:26')
  })

  it('几十分钟', () => {
    expect(describeStartTime('2026-11-03T10:34:00', base)).toBe('11-03 10:34（约 34 分钟后）')
  })

  it('几小时，带零头', () => {
    expect(describeStartTime('2026-11-03T12:30:00', base)).toContain('约 2 小时 30 分后')
  })

  it('超过一天用"天后"', () => {
    expect(describeStartTime('2026-11-05T10:00:00', base)).toContain('约 2 天后')
  })

  it('已经到点或已过就说马上', () => {
    expect(describeStartTime('2026-11-03T10:00:00', base)).toContain('马上')
    expect(describeStartTime('2026-11-03T09:00:00', base)).toContain('马上')
  })

  it('认不出来的时间原样返回，不崩', () => {
    expect(describeStartTime('not-a-date', base)).toBe('not-a-date')
  })
})

describe('指定机器（--nodelist）', () => {
  const withNode: JobSpec = { ...base, gpusPerNode: 1, gpuType: 'a100-pcie-40gb', node: 'gpu09' }

  it('脚本里出现 --nodelist，且排在 --gres 之后', () => {
    const script = buildSbatchScript(withNode)
    expect(script).toContain('#SBATCH --nodelist=gpu09')

    const gresAt = script.indexOf('--gres=')
    const nodeAt = script.indexOf('--nodelist=')
    expect(gresAt).toBeGreaterThan(-1)
    // 读起来应当先是"哪个型号的卡"，再是"哪台机器"
    expect(nodeAt).toBeGreaterThan(gresAt)
  })

  it('命令行模式下同样带上，且是两个独立参数之外的单参数写法', () => {
    const args = buildSbatchArguments(withNode)
    expect(args).toContain('--nodelist=gpu09')
    // 参数会被逐个 shq() 转义，所以不能拆成 ['-w', 'gpu09'] 之外的奇怪形状
    expect(args.filter((arg) => arg.includes('gpu09'))).toHaveLength(1)
  })

  it('不指定机器时两种产出里都没有 nodelist', () => {
    const plain: JobSpec = { ...base, gpusPerNode: 1, gpuType: 'a100-pcie-40gb' }
    expect(buildSbatchScript(plain)).not.toContain('nodelist')
    expect(buildSbatchArguments(plain)).not.toContain('--nodelist=gpu09')
  })

  it('纯 CPU 作业也能钉死一台机器', () => {
    const cpuOnly: JobSpec = { ...base, gpusPerNode: 0, gpuType: null, node: 'cpu05' }
    const script = buildSbatchScript(cpuOnly)
    expect(script).toContain('#SBATCH --nodelist=cpu05')
    expect(script).not.toContain('--gres=')
  })

  it('节点名带可疑字符时不生成这一行（不能靠下游转义兜底）', () => {
    for (const bad of ['gpu09; rm -rf /', 'gpu 09', 'gpu09\nid', '-w', '']) {
      expect(isValidNodeName(bad)).toBe(false)
    }
    const script = buildSbatchScript({ ...base, gpusPerNode: 1, gpuType: 'x', node: 'gpu09; ls' })
    expect(script).not.toContain('nodelist')
  })

  it('常规节点名（含短横线和下划线）都认', () => {
    for (const good of ['gpu09', 'gpu-09', 'gpu_09', 'GPU09']) {
      expect(isValidNodeName(good)).toBe(true)
    }
  })
})
