#!/usr/bin/env python3
"""Render a 28-second short for Bilibili: pitch, setup, one usage scene, one-line install."""

from __future__ import annotations

import math
import subprocess
import sys
import wave
from array import array
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
import imageio_ffmpeg

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "dsh-connect-tabbit-short.mp4"
W, H, FPS = 1280, 720, 30
SR = 48_000
BG = "#13191b"
PANEL = "#1d2729"
PANEL2 = "#263234"
PAPER = "#eee7d8"
INK = "#172021"
WHITE = "#f5f2e9"
MUTED = "#a8b3ad"
LINE = "#334143"
LIME = "#a3d160"
TEAL = "#57b99d"
GOLD = "#e5c06b"
CORAL = "#e0836d"

SCENES = [
    (0, 5, "hook"),
    (5, 13, "steps"),
    (13, 21, "code"),
    (21, 28, "end"),
]
DURATION = SCENES[-1][1]

FONT_ZH = Path(r"C:\Windows\Fonts\NotoSansSC-VF.ttf")
FONT_ZH_BOLD = Path(r"C:\Windows\Fonts\Dengb.ttf")
FONT_LATIN = Path(r"C:\Windows\Fonts\consola.ttf")
FONT_LATIN_BOLD = Path(r"C:\Windows\Fonts\consolab.ttf")
FONT_CACHE: dict[tuple[str, int], ImageFont.FreeTypeFont] = {}


def font(size: int, latin: bool = False, bold: bool = False):
    key = (f"{'latin' if latin else 'zh'}_{'bold' if bold else 'regular'}", size)
    if key not in FONT_CACHE:
        path = (FONT_LATIN_BOLD if latin else FONT_ZH_BOLD) if bold else (FONT_LATIN if latin else FONT_ZH)
        if not path.exists():
            path = Path(r"C:\Windows\Fonts\arial.ttf")
        FONT_CACHE[key] = ImageFont.truetype(str(path), size=size)
    return FONT_CACHE[key]


def ease(x: float) -> float:
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def text(draw, xy, value, size=24, fill=WHITE, *, anchor=None, latin=False, bold=False):
    draw.text(xy, value, font=font(size, latin=latin, bold=bold), fill=fill, anchor=anchor)


def centered(draw, xy, value, size=24, fill=WHITE, **kw):
    text(draw, xy, value, size, fill, anchor="mm", **kw)


def pill(draw, xy, label, color=LIME, bg=PANEL2, size=15, width=None, h=30):
    x, y = xy
    f = font(size, bold=True)
    tw = draw.textbbox((0, 0), label, font=f)[2]
    w = width or tw + 26
    draw.rounded_rectangle((x, y, x + w, y + h), radius=h // 2, fill=bg, outline=LINE, width=1)
    text(draw, (x + 13, y + h // 2), label, size, color, anchor="lm", bold=True)
    return w


def panel(draw, box, fill=PANEL, outline=LINE, width=2, radius=18):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def arrow(draw, start, end, color=TEAL, width=4, progress=1.0):
    x1, y1 = start
    x2, y2 = end
    p = ease(progress)
    ex, ey = x1 + (x2 - x1) * p, y1 + (y2 - y1) * p
    draw.line((x1, y1, ex, ey), fill=color, width=width)
    if p > 0.82:
        angle = math.atan2(ey - y1, ex - x1)
        r = 12
        a1, a2 = angle + 2.6, angle - 2.6
        draw.polygon([(ex, ey), (ex + r * math.cos(a1), ey + r * math.sin(a1)),
                      (ex + r * math.cos(a2), ey + r * math.sin(a2))], fill=color)


def background(t: float, section: int):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    for x in range(42, W, 48):
        d.line((x, 74, x, 658), fill="#192123", width=1)
    for y in range(90, 660, 48):
        d.line((42, y, W - 42, y), fill="#192123", width=1)
    text(d, (54, 36), "DSH CONNECT  /  TABBIT", 15, MUTED, latin=True, bold=True)
    text(d, (W - 54, 36), "THIRD-PARTY PLUGIN     0.4.6", 14, MUTED, anchor="ra", latin=True)
    d.line((54, 62, W - 54, 62), fill=LINE, width=1)
    d.rounded_rectangle((54, 675, W - 54, 680), radius=2, fill="#263133")
    d.rounded_rectangle((54, 675, 54 + (W - 108) * clamp01(t / DURATION), 680), radius=2, fill=LIME)
    text(d, (54, 698), f"{section:02d}  /  {len(SCENES):02d}", 12, MUTED, latin=True, bold=True)
    text(d, (W - 54, 698), "界面示意 · 功能以当前版本为准", 12, MUTED, anchor="ra")
    return img


def scene_hook(t: float):
    img = background(t, 1)
    d = ImageDraw.Draw(img)
    p = ease(t / 0.8)
    text(d, (74, 170 + (1 - p) * 18), "34 个免费大模型", 74, PAPER, bold=True)
    text(d, (74, 262 + (1 - p) * 18), "装进你的 DSH", 62, LIME, bold=True)
    x = 78
    for i, (label, color) in enumerate([("国内版 + 国际版", LIME), ("零配置", TEAL), ("每日签到", GOLD), ("工具真实执行", CORAL)]):
        if ease((t - 0.6 - i * 0.16) / 0.4) > 0:
            x += pill(d, (x, 380), label, color=color) + 12
    text(d, (78, 470), "Tabbit 浏览器的模型额度 → DSH 内置网关", 24, WHITE)
    text(d, (78, 516), "2026-10-24 双版本真实链路验证 · 76 项测试", 17, MUTED)
    cx, cy = 1020, 330
    orbit = 118 + 5 * math.sin(t * 1.3)
    for r, color, width in [(orbit, LINE, 2), (orbit * 0.68, "#425252", 1)]:
        d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=color, width=width)
    for i, (ang, col, rr) in enumerate([(0.4, LIME, 11), (2.55, CORAL, 9), (4.45, TEAL, 8)]):
        a = ang + t * (0.16 if i % 2 == 0 else -0.12)
        x, y = cx + orbit * math.cos(a), cy + orbit * math.sin(a)
        d.ellipse((x - rr, y - rr, x + rr, y + rr), fill=col)
    d.rounded_rectangle((cx - 80, cy - 54, cx + 80, cy + 54), radius=22, fill=PANEL, outline="#506264", width=2)
    centered(d, (cx, cy - 14), "CN", 28, LIME, latin=True, bold=True)
    centered(d, (cx, cy + 20), "GLOBAL", 20, TEAL, latin=True, bold=True)
    return img


def scene_steps(t: float):
    img = background(t, 2)
    d = ImageDraw.Draw(img)
    text(d, (70, 106), "三步上手", 44, PAPER, bold=True)
    cards = [
        ("01", "安装插件", "一行命令 · 见简介", LIME),
        ("02", "登录 / 导入", "隔离窗口或浏览器 Cookie", TEAL),
        ("03", "选模型开聊", "23 + 34 个模型", GOLD),
    ]
    for i, (num, title, sub, color) in enumerate(cards):
        x = 74 + i * 396
        slide = 26 * (1 - ease((t - 0.15 - i * 0.28) / 0.7))
        y = 200 + slide
        panel(d, (x, y, x + 340, y + 190), fill=PANEL if i != 1 else "#2c3a34")
        text(d, (x + 26, y + 28), num, 17, color, latin=True, bold=True)
        text(d, (x + 26, y + 64), title, 29, WHITE, bold=True)
        text(d, (x + 26, y + 120), sub, 16, MUTED)
        if i < 2:
            arrow(d, (x + 348, y + 95), (x + 388, y + 95), TEAL, 4, (t - 0.6 - i * 0.4) / 0.8)
    d.rounded_rectangle((76, 452, 1204, 516), radius=16, fill="#28352f", outline="#52614d", width=2)
    centered(d, (640, 484), "无需 Python / Docker · 网关只听本机回环 · 账号留在本机", 20, PAPER)
    return img


def scene_code(t: float):
    img = background(t, 3)
    d = ImageDraw.Draw(img)
    text(d, (70, 100), "工具真实执行，不是嘴上说", 40, PAPER, bold=True)
    panel(d, (74, 160, 1206, 224), fill=PAPER, outline="#faf2dd", radius=14)
    pill(d, (94, 172), "用户", color=INK, bg=LIME, size=13, h=26)
    text(d, (170, 192), "\u201c写个批量重命名脚本，DSC_ 改成 2026_\u201d", 21, INK, anchor="lm", bold=True)
    cards = [
        ("模型提议", 'write_file("rename.py")', LIME),
        ("DSH 执行", "真正写入磁盘", TEAL),
        ("结果返回", "success ✓", GOLD),
    ]
    for i, (title, sub, color) in enumerate(cards):
        x = 74 + i * 396
        slide = 24 * (1 - ease((t - 0.3 - i * 0.28) / 0.7))
        y = 262 + slide
        panel(d, (x, y, x + 340, y + 118), fill=PANEL2 if i == 1 else PANEL, radius=14)
        text(d, (x + 22, y + 24), title, 22, WHITE, bold=True)
        text(d, (x + 22, y + 72), sub, 15, MUTED, latin=i != 1)
        if i < 2:
            arrow(d, (x + 348, y + 59), (x + 388, y + 59), TEAL, 4, (t - 0.7 - i * 0.3) / 0.8)
    panel(d, (74, 428, 700, 506), fill="#161d1f", radius=12)
    text(d, (96, 448), 'content = "print(\"hello\")"', 16, LIME, latin=True, bold=True)
    text(d, (96, 480), "含引号 / 多行代码原样保真", 15, MUTED)
    d.rounded_rectangle((716, 428, 1204, 506), radius=12, fill="#28352f", outline="#52614d", width=2)
    d.ellipse((736, 452, 756, 472), fill=LIME)
    centered(d, (746, 462), "✓", 14, INK, bold=True)
    text(d, (772, 467), "模型\u201c说做了\u201d ≠ 做了", 18, WHITE, anchor="lm", bold=True)
    text(d, (76, 540), "长资料（>18K 字符）自动走文档附件 · 1M 上下文模型可选 · 每日签到领额度", 16, MUTED)
    return img


def scene_end(t: float):
    img = background(t, 4)
    d = ImageDraw.Draw(img)
    text(d, (74, 130), "一键安装", 46, PAPER, bold=True)
    panel(d, (74, 200, 1204, 292), fill="#161d1f", radius=14)
    prompt = "dsh plugin --profile desktop add \\"
    cmd = "github:xianshengl487-star/dsh-connect-tabbit dsh-connect-workbuddy dsh-connect-trae"
    if ease((t - 0.3) / 0.5) > 0:
        text(d, (100, 224), prompt, 17, MUTED, latin=True)
    if ease((t - 0.8) / 0.5) > 0:
        text(d, (100, 254), cmd, 17, LIME, latin=True, bold=True)
    text(d, (74, 330), "装完重启 DSH → 设置里登录 Tabbit → 选模型", 22, WHITE)
    text(d, (74, 388), "github.com/xianshengl487-star/dsh-connect-tabbit", 20, TEAL, latin=True, bold=True)
    text(d, (74, 440), "国内版 web.tabbit.com · 国际版 web.tabbit.ai · MIT · 第三方插件", 15, MUTED)
    return img


def frame_at(t: float):
    index = len(SCENES) - 1
    start, end = SCENES[-1][0], SCENES[-1][1]
    for i, (a, b, _) in enumerate(SCENES):
        if a <= t < b:
            index, start, end = i, a, b
            break
    local = max(0.0, min(end - start, t - start))
    return [scene_hook, scene_steps, scene_code, scene_end][index](local)


def midi_hz(n: int) -> float:
    return 440.0 * 2 ** ((n - 69) / 12)


def make_audio(path: Path):
    count = int(DURATION * SR)
    roots = [36, 44, 39, 46]
    scale = [60, 63, 65, 67, 70, 72, 75, 77]
    beat = 60 / 104
    boundaries = [row[0] for row in SCENES[1:]]
    pcm = array("h")
    for i in range(count):
        sec = i / SR
        b = sec / beat
        chord = roots[int(sec // (beat * 8)) % len(roots)]
        pad = 0.030 * (math.sin(2 * math.pi * midi_hz(chord + 24) * sec) +
                       0.6 * math.sin(2 * math.pi * midi_hz(chord + 31) * sec) +
                       0.42 * math.sin(2 * math.pi * midi_hz(chord + 36) * sec))
        phase = b % 1
        kick = 0.0
        if phase < .20:
            kick = .12 * math.exp(-phase * 23) * math.sin(2 * math.pi * (64 - 26 * phase) * phase * 1.2)
        half = b % 2
        snare = 0.0
        if .98 < half < 1.09:
            noise = math.sin(i * 12.9898) * math.sin(i * .0173)
            snare = .024 * math.exp(-(half - .98) * 32) * noise
        slot = int(b * 2)
        local = (b * 2) - slot
        note = scale[(slot + slot // 8) % len(scale)]
        melody = .032 * math.exp(-local * 13) * math.sin(2 * math.pi * midi_hz(note) * sec)
        tick = 0.0
        for boundary in boundaries:
            delta = sec - boundary
            if 0 <= delta < .055:
                tick += .026 * math.exp(-delta * 85) * math.sin(2 * math.pi * (850 - 500 * delta) * delta)
        fade = min(1.0, sec / 0.9, (DURATION - sec) / 1.4)
        sample = max(-.8, min(.8, (pad + kick + snare + melody + tick) * fade))
        pcm.append(int(sample * 32767))
        pcm.append(int(max(-.8, min(.8, (pad * .92 + kick + snare + melody * 1.04 + tick) * fade)) * 32767))
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(SR)
        wav.writeframes(pcm.tobytes())


def main():
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    wav_path = ROOT / "soundtrack.wav"
    raw = subprocess.Popen([
        ffmpeg, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-", "-an", "-c:v", "libx264",
        "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        str(OUT),
    ], stdin=subprocess.PIPE)
    try:
        for frame_no in range(int(DURATION * FPS)):
            t = frame_no / FPS
            raw.stdin.write(frame_at(t).tobytes())
            if frame_no % (FPS * 10) == 0:
                print(f"video {t:05.1f}s / {DURATION:.0f}s", flush=True)
    finally:
        raw.stdin.close()
    if raw.wait():
        raise RuntimeError("ffmpeg encode failed")
    print("Rendering original soundtrack…", flush=True)
    make_audio(wav_path)
    merged = OUT.with_suffix(".muxed.mp4")
    subprocess.run([
        ffmpeg, "-y", "-loglevel", "error", "-i", str(OUT), "-i", str(wav_path),
        "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", str(merged),
    ], check=True)
    merged.replace(OUT)
    wav_path.unlink(missing_ok=True)
    print(f"Wrote {OUT} ({OUT.stat().st_size / 1024 / 1024:.1f} MiB)")


if __name__ == "__main__":
    sys.exit(main())
