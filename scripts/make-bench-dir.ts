/**
 * 造一个"条目很多"的目录，用来验证虚拟滚动。
 *
 *   npm run make-bench-dir                默认 4800 个文件（列表上限是 5000，留点余量避免触发截断）
 *   npm run make-bench-dir -- --count 300 小一点先试
 *   npm run make-bench-dir -- --keep       保留已有的数据（默认会先清空重建）
 *
 * 目录建在系统临时目录里，不污染仓库，也不容易被误删到项目文件。
 * 打印出的路径直接粘到应用的地址栏里就能打开。
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 列表的硬上限（`fs/listing.ts` 的 MAX_ENTRIES），超过会触发截断提示 */
const LIST_CAP = 5000
const SUBDIRS = ['dataset', 'checkpoints', 'logs']

interface Args {
  count: number
  keep: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { count: LIST_CAP - 200, keep: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!
    if (token === '--count') args.count = Number(argv[++i] ?? args.count)
    else if (token === '--keep') args.keep = true
    else throw new Error(`认不出的参数：${token}`)
  }
  if (!Number.isFinite(args.count) || args.count <= 0) {
    throw new Error(`--count 必须是正数，收到 ${args.count}`)
  }
  return args
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const root = join(tmpdir(), 'hpc-bench-list')

  if (!args.keep) {
    await rm(root, { recursive: true, force: true })
  }
  await mkdir(root, { recursive: true })

  // 子目录：验证"目录排在最前"和双击进入
  for (const name of SUBDIRS) {
    await mkdir(join(root, name), { recursive: true })
  }

  // 文件名故意混入中文、长名、空格、点号开头，验证截断与排序不会错位
  const started = Date.now()
  const writes: Array<Promise<void>> = []
  for (let i = 0; i < args.count; i += 1) {
    const index = String(i).padStart(5, '0')
    let name: string
    if (i % 500 === 0) name = `实验记录-第${index}次运行-结果汇总表.csv`
    else if (i % 500 === 1) name = `a-very-long-filename-that-should-be-truncated-in-the-list-${index}.bin`
    else if (i % 500 === 2) name = `with space ${index}.txt`
    else name = `file-${index}.txt`

    // 内容给不同大小，验证"大小"列对齐
    writes.push(writeFile(join(root, name), 'x'.repeat(i % 7 === 0 ? 1024 : 16)))
    // 分批等待，避免一次性打开几千个文件句柄
    if (writes.length >= 500) {
      await Promise.all(writes)
      writes.length = 0
    }
  }
  await Promise.all(writes)

  const total = args.count + SUBDIRS.length
  const elapsed = Date.now() - started
  console.log('')
  console.log('已生成测试目录')
  console.log(`  路径    ${root}`)
  console.log(`  条目    ${total}（${args.count} 个文件 + ${SUBDIRS.length} 个子目录）`)
  console.log(`  耗时    ${elapsed} ms`)
  if (total > LIST_CAP) {
    console.log(`  注意    超过列表上限 ${LIST_CAP}，应用里会只显示前 ${LIST_CAP} 条并给出提示`)
  }
  console.log('')
  console.log('在应用的「本机」栏里逐级点进去：AppData → Local → Temp → hpc-bench-list')
  console.log('')
  return 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    console.error('生成失败：', err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
