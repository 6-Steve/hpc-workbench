/** 界面共用的格式化函数；只做展示，不参与任何判断 */

export function formatSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export function formatTime(ms: number | null | undefined): string {
  if (!ms) return '—'
  const date = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function formatRate(bytesPerSecond: number): string {
  return `${formatSize(bytesPerSecond)}/s`
}

/** 分钟数 → 「2 小时 15 分」。用于作业时长、时限这类展示 */
export function formatDuration(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return '—'
  if (minutes < 1) return '不到 1 分'

  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = Math.floor(minutes % 60)

  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`
  if (hours > 0) return mins > 0 ? `${hours} 小时 ${mins} 分` : `${hours} 小时`
  return `${mins} 分`
}

/** Unix 秒 → 「3 分钟前」这种相对说法，比绝对时间更容易扫一眼 */
export function formatAgo(unixSeconds: number | null | undefined, now = Date.now()): string {
  if (!unixSeconds) return '—'
  const diffSeconds = Math.max(0, Math.floor(now / 1000 - unixSeconds))
  if (diffSeconds < 60) return '刚刚'
  if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)} 分钟前`
  if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)} 小时前`
  return `${Math.floor(diffSeconds / 86400)} 天前`
}

/**
 * 作业的资源申请摘要：「2 节点 · 8 核 · 4 卡」。
 * 三者都可能为 null（老版本字段缺失），全空时给个占位符而不是空字符串。
 */
export function describeResources(
  nodes: number | null | undefined,
  cpus: number | null | undefined,
  gpus: number | null | undefined
): string {
  const parts = [
    nodes ? `${nodes} 节点` : null,
    cpus ? `${cpus} 核` : null,
    gpus ? `${gpus} 卡` : null
  ].filter((part): part is string => part !== null)

  return parts.length > 0 ? parts.join(' · ') : '—'
}

/**
 * 这个模块只关心配额的字节维度，所以自己声明结构子集——
 * 全局的 `Quota` 来自 `src/preload/index.d.ts`，node 侧 tsconfig 看不见它。
 */
interface QuotaLike {
  bytes: {
    used: number
    soft: number | null
    hard: number | null
  }
}

/**
 * 配额已用百分比。
 *
 * 按**软限**算（那是提醒线），没设软限才看硬限；两个都没设返回 null，
 * 界面显示「—」而不是画一根假的进度条。
 */
export function quotaUsagePercent(quota: QuotaLike | null | undefined): number | null {
  if (!quota) return null
  const limit = quota.bytes.soft ?? quota.bytes.hard
  if (limit === null || limit <= 0) return null
  return (quota.bytes.used / limit) * 100
}
