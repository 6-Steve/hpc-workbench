/**
 * `scontrol show node --json` → 逐节点信息。**这是库存真值来源**（docs/03 §5.1）。
 *
 * 一条命令同时给出：状态、总卡、已用卡、核数、内存、分区。
 * 但注意三件事：
 * 1. `gres` / `gres_used` 仍然是字符串，解析规则在 gres.ts
 * 2. `state` 是**数组**且可能多值（`["IDLE","DRAIN"]`）
 * 3. `free_mem` 是 `{set,infinite,number}`，`set:false` 不是 0
 */
import { isBlocked, normalizeNodeStates } from '../domain/node-state'
import { parseGres } from './gres'
import {
  asStringArray,
  dataArray,
  envelopeErrors,
  optNumber,
  optString,
  parseJsonObject
} from './json'
import { fail, ok, type Adapter, type NodeInfo, type ParseResult } from './types'

export const NODE_DETAIL_COMMAND = 'scontrol show node --json'

export function parseNodeDetail(raw: string): ParseResult<NodeInfo[]> {
  const parsed = parseJsonObject(raw)
  if (!parsed.ok) return parsed

  const envelope = parsed.data
  const error = envelopeErrors(envelope)
  if (error) return fail(`调度器返回错误：${error}`, raw)

  const nodes = dataArray(envelope, 'nodes')
  if (nodes.length === 0) return fail('nodes 数组为空，没拿到任何节点', raw)

  const result: NodeInfo[] = []
  for (const item of nodes) {
    const name = optString(item['name'])
    if (!name) return fail('有节点缺少 name 字段，输出结构可能变了', raw)

    const rawStates = asStringArray(item['state'])
    const states = normalizeNodeStates(rawStates)

    const cpus = optNumber(item['cpus']) ?? 0
    const allocCpus = optNumber(item['alloc_cpus']) ?? 0

    result.push({
      name,
      states,
      rawStates,
      blocked: isBlocked(states),
      gpus: parseGres(optString(item['gres'])),
      gpusUsed: parseGres(optString(item['gres_used'])),
      cpus,
      allocCpus,
      // alloc_idle_cpus 直接就是空闲核数；没有该字段时自己算，别默认 0
      idleCpus: optNumber(item['alloc_idle_cpus']) ?? Math.max(0, cpus - allocCpus),
      realMemoryMb: optNumber(item['real_memory']) ?? 0,
      allocMemoryMb: optNumber(item['alloc_memory']) ?? 0,
      // null 表示集群没给这个值，UI 显示"—"，不参与排序
      freeMemoryMb: optNumber(item['free_mem']),
      partitions: asStringArray(item['partitions'])
    })
  }

  return ok(result)
}

export const nodeDetailAdapter: Adapter<NodeInfo[]> = {
  name: 'node-detail',
  command: NODE_DETAIL_COMMAND,
  parse: parseNodeDetail
}
