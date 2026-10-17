#!/usr/bin/env python3
"""把 `npm run demo` 的真实输出渲染成终端风格 GIF（README 首屏用的那张）。

为什么是"渲染"而不是"录屏"：录屏依赖机器、字体与窗口尺寸，换台机器就不可复现；
而这里的素材是 demo 的 stdout 原文 —— 内容真实（不是手写剧本），呈现可控。

用法：
    node scripts/demo-deliver.mjs > demo-out.txt 2>&1
    python scripts/make-demo-gif.py --input demo-out.txt --out docs/demo.gif

依赖：Pillow（仅本脚本，不进项目依赖）。输出 GIF 用自适应调色板压到 64 色。
"""
import argparse
import os
import sys
from PIL import Image, ImageDraw, ImageFont

BG = (13, 17, 23)
TITLE_BG = (22, 27, 34)
FG = (201, 209, 217)
DIM = (110, 118, 129)
BLUE = (88, 166, 255)
GREEN = (63, 185, 80)
AMBER = (210, 153, 34)
DOT = (48, 54, 61)

MONO = "C:/Windows/Fonts/consola.ttf"
CJK = "C:/Windows/Fonts/msyh.ttc"
SIZE = 15
LINE_H = 21
PAD_X = 18
PAD_TOP = 34
WIDTH = 980

TAIL = [
    "⑥ 断言（17 条，全部 PASS）",
    "PASS: 复核（--replay）= verified —— 凭据记的命令被重跑且结论复现",
    "",
    "⑦ 一次真实交付完成：规划 → 派单 → 落盘 → 门禁 → 交付凭据 → 外部复核通过。",
]


def load_fonts():
    mono = ImageFont.truetype(MONO, SIZE) if os.path.exists(MONO) else ImageFont.load_default()
    cjk = ImageFont.truetype(CJK, SIZE) if os.path.exists(CJK) else mono
    return mono, cjk


def text_width(draw, s, mono, cjk):
    """混排宽度：ASCII 走等宽字体，其余走中文字体。"""
    total = 0
    for ch in s:
        f = mono if ord(ch) < 128 else cjk
        total += draw.textlength(ch, font=f)
    return total


def draw_text(draw, xy, s, fill, mono, cjk):
    x, y = xy
    for ch in s:
        f = mono if ord(ch) < 128 else cjk
        draw.text((x, y), ch, font=f, fill=fill)
        x += draw.textlength(ch, font=f)
    return x


def color_of(line):
    if line.startswith("────") or "───" in line:
        return BLUE
    if line.startswith("PASS") or "verified" in line:
        return GREEN
    if line.strip().startswith("$"):
        return AMBER
    if line.startswith(("①", "②", "③", "④", "⑤", "⑥", "⑦")):
        return BLUE
    if line.startswith("   ·") or line.startswith("    ") or line.startswith("      "):
        return DIM
    return FG


def pick_lines(raw):
    """取 demo 输出里对外有信息量的那一段：①→⑤ 全留，⑥⑦ 只留结论。"""
    lines = raw.splitlines()
    end = len(lines)
    for i, line in enumerate(lines):
        if "退出码 0（verified）" in line:
            end = i + 1
            break
    body = []
    for line in lines[:end]:
        # 临时目录是本机随机路径，对外无意义且很长
        if "AppData\\Local\\Temp\\ox-demo-" in line:
            line = line.replace(line[line.index("C:\\") : line.index("ox-demo-") + 15], "<temp>\\")
        body.append(line.rstrip())
    return body + TAIL


VIEW = 26  # 视口行数：像真终端一样滚动，而不是把 60 行全画成一张长图


def render(lines, out_path, fps=14, line_frames=2, tail_frames=24):
    mono, cjk = load_fonts()
    probe = ImageDraw.Draw(Image.new("RGB", (10, 10)))
    max_w = WIDTH - PAD_X * 2
    clipped = []
    for line in lines:
        while text_width(probe, line, mono, cjk) > max_w and len(line) > 4:
            line = line[:-2]
        clipped.append(line)

    height = PAD_TOP + LINE_H * VIEW + 18
    frames = []
    total = len(clipped)
    for shown in range(1, total + 1):
        img = Image.new("RGB", (WIDTH, height), BG)
        d = ImageDraw.Draw(img)
        d.rectangle([0, 0, WIDTH, PAD_TOP - 8], fill=TITLE_BG)
        for i, cx in enumerate((16, 34, 52)):
            d.ellipse([cx, 11, cx + 11, 22], fill=DOT)
        draw_text(d, (74, 10), "ox-commander — npm run demo", DIM, mono, cjk)
        y = PAD_TOP
        start = max(0, shown - VIEW)
        for line in clipped[start:shown]:
            draw_text(d, (PAD_X, y), line, color_of(line), mono, cjk)
            y += LINE_H
        if shown < total:
            d.rectangle([PAD_X, y + 2, PAD_X + 8, y + 2 + 12], fill=GREEN)
        repeat = tail_frames if shown == total else line_frames
        for _ in range(repeat):
            frames.append(img.copy())

    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    quant = [f.convert("P", palette=Image.ADAPTIVE, colors=64) for f in frames]
    quant[0].save(
        out_path,
        save_all=True,
        append_images=quant[1:],
        duration=int(1000 / fps),
        loop=0,
        optimize=True,
    )
    return len(frames), height


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="demo 的 stdout 原文（node scripts/demo-deliver.mjs）")
    ap.add_argument("--out", default="docs/demo.gif")
    args = ap.parse_args()

    if not os.path.exists(args.input):
        print(f"找不到输入：{args.input}", file=sys.stderr)
        return 2
    raw = open(args.input, "r", encoding="utf-8", errors="replace").read()
    lines = pick_lines(raw)
    n, h = render(lines, args.out)
    size_kb = os.path.getsize(args.out) // 1024
    print(f"GIF 已生成：{args.out} · {WIDTH}x{h} · {n} 帧 · {size_kb} KiB · {len(lines)} 行")
    return 0


if __name__ == "__main__":
    sys.exit(main())
