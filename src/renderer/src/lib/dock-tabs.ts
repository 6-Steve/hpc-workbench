/**
 * Dock 页签的**纯数据清单**（不含图标、不含 JSX）。
 *
 * 为什么不放在 `components/Dock.tsx` 里：
 * 1. 它是命令面板导航项的**唯一数据源**，两份清单漂移过一次
 *    （Dock 7 个、命令台 5 个，「隧道」「终端」搜不到），必须能被测试直接 import；
 * 2. `.tsx` 文件进不了 `tsconfig.node.json` 的类型检查（那边没开 `jsx`），
 *    放在这里 `tests/*.ts` 才能正常引用而不报 TS6142。
 *
 * 图标留在 `Dock.tsx`——那是渲染细节，和"有哪些页签"没关系。
 */

export type Tab =
  | 'files'
  | 'jobs'
  | 'nodes'
  | 'points'
  | 'tunnels'
  | 'terminal'
  | 'settings'
  | 'diagnostics'

export interface DockTabMeta {
  id: Tab
  label: string
  hint: string
  /** 命令面板的额外可搜词：英文别名、常见叫法 */
  keywords: string
}

export const DOCK_TABS: DockTabMeta[] = [
  { id: 'files', label: '文件', hint: '本机与集群之间传文件', keywords: 'files sftp' },
  { id: 'jobs', label: '作业', hint: '队列、历史与输出日志', keywords: 'jobs squeue sacct' },
  { id: 'nodes', label: '资源', hint: '显卡库存、配额与价格', keywords: 'gpu nodes 显卡' },
  {
    id: 'points',
    label: '点数',
    // 「余额」「消耗」「赠送」是用户实际会搜的词，命令面板只做子序列匹配，
    // 所以这几个词要出现在某处，否则 ctrl+K 里搜不到这一页
    hint: '余额、消耗记录与赠送',
    keywords: 'points 余额 点数 消耗 记录 赠送 transfer'
  },
  {
    id: 'tunnels',
    label: '隧道',
    hint: '端口转发：本机 ↔ 集群',
    keywords: 'tunnels tunnel forward ssh -L -R 转发 端口'
  },
  { id: 'terminal', label: '终端', hint: '登录节点上的交互式 shell', keywords: 'terminal shell bash 命令行' },
  { id: 'settings', label: '设置', hint: '默认目录与缓存', keywords: 'settings' },
  { id: 'diagnostics', label: '诊断', hint: '连接探针与命令能力', keywords: 'diagnostics probe' }
]
