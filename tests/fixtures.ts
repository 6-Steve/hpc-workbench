import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 读取 fixtures/ 下的脱敏样本（相对仓库根，vitest 从根运行） */
export function fixture(name: string): string {
  return readFileSync(join(process.cwd(), 'fixtures', name), 'utf8')
}
