import { describe, expect, it } from 'vitest'
import { GB, MB, decideStrategy, describeDecision, type TransferStats } from '../src/main/transfer/engine'

const stats = (fileCount: number, totalBytes: number, largestFileBytes = totalBytes): TransferStats => ({
  fileCount,
  totalBytes,
  largestFileBytes
})

describe('decideStrategy：按 docs/02 §2.5 的矩阵自上而下', () => {
  it('大量小文件 → tar', () => {
    const decision = decideStrategy(stats(1000, 500 * MB))
    expect(decision.strategy).toBe('tar')
    expect(decision.effective).toBe('tar')
    expect(decision.reason).toContain('tar')
  })

  it('平均小于 1 MB 但文件数不到 500 → 走最后一条兜底，仍是 tar', () => {
    const decision = decideStrategy(stats(300, 150 * MB))
    expect(decision.strategy).toBe('tar')
  })

  it('平均超过 50 MB → 命中多流分块，但当前退回单流并告警', () => {
    const decision = decideStrategy(stats(5, 500 * MB))
    expect(decision.strategy).toBe('multistream')
    expect(decision.effective).toBe('sftp')
    expect(decision.warnings.join('\n')).toContain('尚未实现')
  })

  it('单个文件超过 2 GB → 无论平均多少都命中多流', () => {
    const decision = decideStrategy(stats(3, 5 * GB, 3 * GB))
    expect(decision.strategy).toBe('multistream')
    expect(decision.warnings.join('\n')).toContain('2 GB')
  })

  it('少量中等文件 → 单流 SFTP', () => {
    const decision = decideStrategy(stats(20, 400 * MB))
    expect(decision.strategy).toBe('sftp')
    expect(decision.effective).toBe('sftp')
    expect(decision.warnings).toEqual([])
  })

  it('边界：正好 100 个文件不算"少于 100"', () => {
    expect(decideStrategy(stats(100, 400 * MB)).strategy).toBe('tar')
    expect(decideStrategy(stats(99, 400 * MB)).strategy).toBe('sftp')
  })

  it('边界：平均正好 1 MB 不满足"小于 1 MB"', () => {
    expect(decideStrategy(stats(600, 600 * MB)).strategy).toBe('tar')
  })

  it('没有文件时给出明确的告警，而不是瞎选一个', () => {
    const decision = decideStrategy(stats(0, 0))
    expect(decision.warnings.length).toBeGreaterThan(0)
  })
})

describe('describeDecision', () => {
  it('文案里带上文件数、体积和策略', () => {
    const s = stats(12847, 3.4 * GB)
    const text = describeDecision(decideStrategy(s), s)
    expect(text).toContain('12,847')
    expect(text).toContain('3.40 GB')
    expect(text).toContain('tar')
  })

  it('降级时文案写明是降级，不假装用了多流', () => {
    const s = stats(5, 500 * MB)
    const text = describeDecision(decideStrategy(s), s)
    expect(text).toContain('降级')
  })
})
