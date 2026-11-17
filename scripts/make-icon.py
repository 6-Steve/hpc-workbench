#!/usr/bin/env python3
"""
生成应用图标 `build/icon.ico`。

## 为什么用脚本而不是塞一个二进制文件进来

图标要跟着品牌走（敦煌五锚色一改，图标也得改），而 `.ico` 在仓库里是二进制、
diff 里看不见任何东西。脚本是**可复现**的：改配色就改下面几个常量，重跑一次。

## 画的是什么

深棕圆角方块（`#4E3227`，锚色「土」）+ 三根沙金竖条（渐深到浅），
像一张极简的算力柱状图——这是这个应用唯一的核心指标（三枚"电量"数字）。
小尺寸下仍然认得出：唯一的形状是"三根竖条"，16px 也成立。

## 为什么不用 PIL

本机没装。而且 PIL 的圆角抗锯齿要自己糊，不如直接用 SDF：
每个像素算一次到形状边界的**有符号距离**，`clamp(0.5 - d, 0, 1)` 就是覆盖率。
比超采样快得多，边缘也干净（对 16px 尤其重要）。

用法：
    python scripts/make-icon.py
"""
from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'build' / 'icon.ico'

# —— 品牌色（与 main.css 的敦煌锚色一致）——
BG = (78, 50, 39)        # #4E3227 深棕
BAR_TOP = (201, 174, 94)  # #C9AE5E 沙金 ×0.85
BAR_MID = (223, 200, 122)  # #DFC87A 沙金 ×0.95
BAR_LOW = (236, 217, 139)  # #ECD98B 沙金（锚色原色）

# 设计尺寸固定在 256，其它尺寸按比例缩放
DESIGN = 256.0

SIZES = (16, 32, 48, 64, 128, 256)


def _sdf_round_rect(px: float, py: float, x0: float, y0: float, x1: float, y1: float, r: float) -> float:
    """圆角矩形的有符号距离（内部为负）"""
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    hx, hy = (x1 - x0) / 2 - r, (y1 - y0) / 2 - r
    dx = abs(px - cx) - hx
    dy = abs(py - cy) - hy
    out = math.hypot(max(dx, 0.0), max(dy, 0.0))
    return out + min(max(dx, dy), 0.0) - r


def _sdf_bar(px: float, py: float, x0: float, y_top: float, x1: float, y_bot: float, r: float) -> float:
    """只有**顶部**两角是圆角的竖条（底部平，坐在地面上）"""
    # 下部矩形（无圆角）
    body = _sdf_round_rect(px, py, x0, y_top + r, x1, y_bot, 0.0)
    # 左上、右上两个圆角 + 中间补齐的那一段
    lt = math.hypot(px - (x0 + r), py - (y_top + r)) - r
    rt = math.hypot(px - (x1 - r), py - (y_top + r)) - r
    cap = _sdf_round_rect(px, py, x0 + r, y_top, x1 - r, y_top + r, 0.0)
    return min(body, lt, rt, cap)


def _cover(d: float) -> float:
    """SDF → 覆盖率。d=0 在边界上，过渡带 1 个设计像素"""
    return min(1.0, max(0.0, 0.5 - d))


# 几何（设计空间 256）
PANEL = (6.0, 6.0, 250.0, 250.0, 54.0)
BARS = [
    # (x0, y_top, x1, color)
    (49.0, 148.0, 87.0, BAR_TOP),
    (109.0, 112.0, 147.0, BAR_MID),
    (169.0, 76.0, 207.0, BAR_LOW),
]
BAR_BOTTOM = 204.0
BAR_RADIUS = 9.0


def render(size: int) -> bytes:
    """渲染一张 size×size 的 RGBA PNG"""
    scale = DESIGN / size
    rows: list[bytes] = []

    for py in range(size):
        row = bytearray()
        row.append(0)  # PNG 过滤类型：None
        for px in range(size):
            # 取像素中心的**设计空间**坐标
            x = (px + 0.5) * scale
            y = (py + 0.5) * scale

            a_panel = _cover(_sdf_round_rect(x, y, *PANEL))
            if a_panel <= 0.002:
                row += bytes((0, 0, 0, 0))
                continue

            r, g, b = BG
            for x0, y_top, x1, color in BARS:
                a = _cover(_sdf_bar(x, y, x0, y_top, x1, BAR_BOTTOM, BAR_RADIUS))
                if a > 0:
                    r = round(r * (1 - a) + color[0] * a)
                    g = round(g * (1 - a) + color[1] * a)
                    b = round(b * (1 - a) + color[2] * a)

            row += bytes((r, g, b, round(a_panel * 255)))
        rows.append(bytes(row))

    raw = b''.join(rows)
    return _png(size, size, raw)


def _chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF)


def _png(width: int, height: int, raw: bytes) -> bytes:
    ihdr = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)  # 8bit RGBA
    return (
        b'\x89PNG\r\n\x1a\n'
        + _chunk(b'IHDR', ihdr)
        + _chunk(b'IDAT', zlib.compress(raw, 9))
        + _chunk(b'IEND', b'')
    )


def build_ico(path: Path) -> None:
    images = [(size, render(size)) for size in SIZES]

    header = struct.pack('<HHH', 0, 1, len(images))  # reserved / type=icon / count
    entries = b''
    offset = 6 + 16 * len(images)
    for size, data in images:
        # 256 在 ICONDIR 里要写成 0
        dim = 0 if size >= 256 else size
        entries += struct.pack('<BBBBHHII', dim, dim, 0, 0, 1, 32, len(data), offset)
        offset += len(data)

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(header + entries + b''.join(data for _, data in images))
    total = path.stat().st_size
    print(f'wrote {path.relative_to(ROOT)}  {total / 1024:.1f} KB  sizes={",".join(str(s) for s in SIZES)}')


if __name__ == '__main__':
    build_ico(OUT)
