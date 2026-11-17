/**
 * 拖拽时鼠标上跟着的那个小图标。
 *
 * `webContents.startDrag()` 要求传 `NativeImage`，但它只是个视觉装饰，
 * 没必要为它往仓库里塞一个 png 二进制。这里直接按 PNG 规范现场拼一个圆角方块，
 * 顺带说明一下 PNG 的 chunk 结构——以后要换成真正的图标也是改这一个函数。
 *
 * PNG 结构：8 字节签名 + 若干 chunk（IHDR / IDAT / IEND），
 * 每个 chunk = 长度(4) + 类型(4) + 数据 + CRC32(4)。
 */
import { deflateSync, crc32 } from 'node:zlib'

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)

  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])

  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0, 0)

  return Buffer.concat([length, body, crc])
}

/** 圆角矩形的内部判断，四个角按半径裁掉 */
function insideRounded(x: number, y: number, size: number, radius: number): boolean {
  const nearLeft = x < radius
  const nearRight = x >= size - radius
  const nearTop = y < radius
  const nearBottom = y >= size - radius

  if ((nearLeft || nearRight) && (nearTop || nearBottom)) {
    const cx = nearLeft ? radius : size - radius - 1
    const cy = nearTop ? radius : size - radius - 1
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius
  }
  return true
}

/**
 * 生成一张 RGBA 的 PNG。默认 32px、主题蓝、圆角 6px。
 * 颜色和 `tailwind.config.js` 里的 accent-500 对齐。
 */
export function makeDragIcon(size = 32): Buffer {
  const radius = Math.max(2, Math.round(size * 0.19))

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0) // width
  ihdr.writeUInt32BE(size, 4) // height
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  // 每行开头一个 filter 字节（0 = None），后面是 size 个 RGBA 像素
  const stride = size * 4 + 1
  const raw = Buffer.alloc(stride * size)

  for (let y = 0; y < size; y += 1) {
    const rowStart = y * stride
    raw[rowStart] = 0

    for (let x = 0; x < size; x += 1) {
      const offset = rowStart + 1 + x * 4
      const visible = insideRounded(x, y, size, radius)

      raw[offset] = 0x2f // R
      raw[offset + 1] = 0x7b // G
      raw[offset + 2] = 0xf5 // B
      raw[offset + 3] = visible ? 0xff : 0x00 // A
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}
