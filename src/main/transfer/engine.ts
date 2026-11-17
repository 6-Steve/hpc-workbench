/**
 * 传输策略路由器（docs/02 §2.5）。
 *
 * 唯一职责：按「文件数 / 总字节 / 最大文件」选一条路径，并**说清楚为什么**。
 * 决策过程对用户可见，是这个工具建立信任的关键——出问题时用户能自己换。
 *
 * 实现在这里的只有 A（单流 SFTP）和 C（tar）。B（多流分块）还没做，
 * 所以命中 B 时会退回 A 并明确告警，绝不假装自己支持。
 */
export const MB = 1024 ** 2
export const GB = 1024 ** 3

export type StrategyId = 'sftp' | 'tar' | 'multistream'
/** 当前真正能执行的策略 */
export type EffectiveStrategy = 'sftp' | 'tar'

export interface TransferStats {
  fileCount: number
  totalBytes: number
  largestFileBytes: number
}

export interface StrategyDecision {
  /** 矩阵命中的策略（可能是还没实现的 B） */
  strategy: StrategyId
  /** 实际会执行的策略 */
  effective: EffectiveStrategy
  /** 平均每个文件多少字节 */
  avgBytes: number
  /** 给人看的一句话 */
  reason: string
  /** 需要提醒用户的事（例如 B 尚未实现、单文件过大传完可能超时） */
  warnings: string[]
}

function mb(bytes: number): string {
  const value = bytes / MB
  return value >= 1024 ? `${(value / 1024).toFixed(1)} GB` : `${value.toFixed(1)} MB`
}

/**
 * 决策顺序严格按矩阵自上而下（行之间有重叠，先命中先返回）：
 *
 *   avg < 1 MB 且 N > 500        → tar
 *   avg > 50 MB 或 单文件 > 2 GB → 多流分块
 *   N < 100                      → 单流 SFTP
 *   其余                         → tar
 */
export function decideStrategy(stats: TransferStats): StrategyDecision {
  const { fileCount, totalBytes, largestFileBytes } = stats

  if (fileCount <= 0) {
    return {
      strategy: 'sftp',
      effective: 'sftp',
      avgBytes: 0,
      reason: '没有文件需要传输',
      warnings: ['选中的内容里没有文件']
    }
  }

  const avgBytes = totalBytes / fileCount

  if (avgBytes < 1 * MB && fileCount > 500) {
    return {
      strategy: 'tar',
      effective: 'tar',
      avgBytes,
      reason: `${fileCount} 个文件、平均 ${mb(avgBytes)}，逐个握手不划算，走 tar`,
      warnings: []
    }
  }

  if (avgBytes > 50 * MB || largestFileBytes > 2 * GB) {
    const warnings: string[] = ['多流分块（B 策略）尚未实现，本次退回单流 SFTP，大文件会明显变慢']
    if (largestFileBytes > 2 * GB) {
      warnings.push(`单个文件 ${mb(largestFileBytes)}，超过 2 GB，建议先切分或改用 rsync`)
    }
    return {
      strategy: 'multistream',
      effective: 'sftp',
      avgBytes,
      reason:
        largestFileBytes > 2 * GB
          ? `单个文件 ${mb(largestFileBytes)}，超过 2 GB，应当多流分块`
          : `平均 ${mb(avgBytes)}，大文件为主，应当多流分块`,
      warnings
    }
  }

  if (fileCount < 100) {
    return {
      strategy: 'sftp',
      effective: 'sftp',
      avgBytes,
      reason: `${fileCount} 个文件、平均 ${mb(avgBytes)}，逐个传就好`,
      warnings: []
    }
  }

  return {
    strategy: 'tar',
    effective: 'tar',
    avgBytes,
    reason: `${fileCount} 个文件、平均 ${mb(avgBytes)}，文件边界开销占大头，走 tar`,
    warnings: []
  }
}

/** 界面上那条"检测到 …将使用 …"的文案 */
export function describeDecision(decision: StrategyDecision, stats: TransferStats): string {
  const label =
    decision.effective === 'tar' ? '分段 tar' : decision.strategy === 'multistream' ? '单流 SFTP（降级）' : '单流 SFTP'
  const size = stats.totalBytes >= GB ? `${(stats.totalBytes / GB).toFixed(2)} GB` : `${(stats.totalBytes / MB).toFixed(1)} MB`
  return `检测到 ${stats.fileCount.toLocaleString('zh-CN')} 个文件 / ${size}，将使用${label}`
}
