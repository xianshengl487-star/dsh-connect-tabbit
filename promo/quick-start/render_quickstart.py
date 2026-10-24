#!/usr/bin/env python3
"""Render a 62-second quick-start video: the pitch, the three setup steps, and three real usage scenes."""

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
OUT = ROOT / "dsh-connect-tabbit-quickstart.mp4"
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
    (0, 7, "hook"),
    (7, 21, "steps"),
    (21, 34, "code"),
    (34, 46, "docs"),
    (46, 55, "free"),
    (55, 62, "end"),
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
    text(d, (54, 36), "DSH CONNECT  /  TABBIT  ·  QUICK START", 15, MUTED, latin=True, bold=True)
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
    p = ease(t / 1.1)
    text(d, (74, 138 + (1 - p) * 20), "34 个免费大模型", 66, PAPER, bold=True)
    text(d, (74, 218 + (1 - p) * 20), "装进你的 DeepSeek Harness", 56, LIME, bold=True)
    chips = [("国内版 + 国际版", LIME), ("零配置 · 内置网关", TEAL), ("Token 统计与倍率", GOLD), ("每日签到领额度", CORAL)]
    x = 78
    for i, (label, color) in enumerate(chips):
        appear = ease((t - 1.0 - i * 0.22) / 0.5)
        if appear <= 0:
            continue
        w = pill(d, (x, 330), label, color=color)
        x += w + 14
    text(d, (78, 420), "Tabbit 浏览器的模型额度 → DSH 内置网关，随插件启停", 22, WHITE)
    text(d, (78, 458), "网关只监听本机回环随机端口，账号保存在本机", 18, MUTED)
    d.rounded_rectangle((76, 512, 740, 570), radius=16, fill="#223029", outline="#4c6a52", width=2)
    centered(d, (408, 541), "2026-10-24 双版本真实链路验证 · 76 项测试全通过", 19, PAPER)
    cx, cy = 1000, 360
    orbit = 132 + 5 * math.sin(t * 1.3)
    for r, color, width in [(orbit, LINE, 2), (orbit * 0.68, "#425252", 1)]:
        d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=color, width=width)
    for i, (ang, col, rr) in enumerate([(0.4, LIME, 12), (2.55, CORAL, 9), (4.45, TEAL, 8)]):
        a = ang + t * (0.16 if i % 2 == 0 else -0.12)
        x, y = cx + orbit * math.cos(a), cy + orbit * math.sin(a)
        d.ellipse((x - rr, y - rr, x + rr, y + rr), fill=col)
    d.rounded_rectangle((cx - 88, cy - 60, cx + 88, cy + 60), radius=24, fill=PANEL, outline="#506264", width=2)
    centered(d, (cx, cy - 16), "CN", 30, LIME, latin=True, bold=True)
    centered(d, (cx, cy + 20), "GLOBAL", 22, TEAL, latin=True, bold=True)
    return img


def scene_steps(t: float):
    img = background(t, 2)
    d = ImageDraw.Draw(img)
    text(d, (70, 100), "三步上手，一分钟搞定", 44, PAPER, bold=True)
    cards = [
        ("01", "安装插件", "插件市场搜索 dsh-connect-tabbit", LIME),
        ("02", "登录 / 导入", "隔离登录窗口 · 浏览器 Cookie 导入", TEAL),
        ("03", "选模型开聊", "tabbit-cn 23 个 · tabbit-global 34 个", GOLD),
    ]
    for i, (num, title, sub, color) in enumerate(cards):
        x = 74 + i * 396
        slide = 30 * (1 - ease((t - 0.2 - i * 0.35) / 0.9))
        y = 190 + slide
        panel(d, (x, y, x + 340, y + 210), fill=PANEL if i != 1 else "#2c3a34")
        text(d, (x + 26, y + 30), num, 17, color, latin=True, bold=True)
        text(d, (x + 26, y + 68), title, 30, WHITE, bold=True)
        text(d, (x + 26, y + 124), sub, 16, MUTED)
        if i == 1:
            pill(d, (x + 26, y + 158), "登录 Tabbit", color=INK, bg=LIME, size=13)
            pill(d, (x + 150, y + 158), "导入本机账号", color=WHITE, size=13)
        if i < 2:
            arrow(d, (x + 348, y + 105), (x + 388, y + 105), TEAL, 4, (t - 0.7 - i * 0.5) / 1.0)
    d.rounded_rectangle((76, 470, 1204, 530), radius=16, fill="#28352f", outline="#52614d", width=2)
    centered(d, (640, 500), "无需 Python / Docker / 独立网关 —— 安装完就能用，重启 DSH 后生效", 20, PAPER)
    text(d, (76, 560), "国际版需独立账号：装国际版浏览器 → 登录 → 插件内一键导入（详见仓库 docs）", 17, MUTED)
    return img


def scene_code(t: float):
    img = background(t, 3)
    d = ImageDraw.Draw(img)
    text(d, (70, 98), "场景 ① · AI 编程：工具真实执行", 40, PAPER, bold=True)
    panel(d, (74, 158, 1206, 226), fill=PAPER, outline="#faf2dd", radius=14)
    pill(d, (94, 172), "用户", color=INK, bg=LIME, size=13, h=26)
    text(d, (170, 192), "\u201c写个批量重命名脚本，把 DSC_ 前缀改成 2026_\u201d", 21, INK, anchor="lm", bold=True)
    cards = [
        ("01", "模型提议", 'write_file("rename.py", …)', LIME),
        ("02", "DSH 执行", "真正写入磁盘", TEAL),
        ("03", "结果返回", "success · bytes=412", GOLD),
        ("04", "模型继续", "交付并验证脚本", CORAL),
    ]
    for i, (num, title, sub, color) in enumerate(cards):
        x = 74 + i * 292
        slide = 26 * (1 - ease((t - 0.4 - i * 0.3) / 0.9))
        y = 268 + slide
        panel(d, (x, y, x + 268, y + 128), fill=PANEL2 if i == 1 else PANEL, radius=14)
        text(d, (x + 20, y + 22), num, 14, color, latin=True, bold=True)
        text(d, (x + 58, y + 38), title, 21, WHITE, anchor="lm", bold=True)
        text(d, (x + 20, y + 84), sub, 14, MUTED, latin=i in (0, 2))
        if i < 3:
            arrow(d, (x + 274, y + 64), (x + 286, y + 64), TEAL, 3, (t - 0.9 - i * 0.35) / 0.9)
    panel(d, (74, 436, 700, 520), fill="#161d1f", radius=12)
    text(d, (96, 456), 'content = "print(\"hello\")"', 16, LIME, latin=True, bold=True)
    text(d, (96, 490), "含引号 / 多行代码原样保真（CDATA 信封，免转义）", 15, MUTED)
    d.rounded_rectangle((716, 436, 1204, 520), radius=12, fill="#28352f", outline="#52614d", width=2)
    d.ellipse((736, 462, 756, 482), fill=LIME)
    centered(d, (746, 472), "✓", 14, INK, bold=True)
    text(d, (772, 478), "模型\u201c说做了\u201d ≠ 做了：只有真实工具结果才算数", 17, WHITE, anchor="lm")
    return img


def scene_docs(t: float):
    img = background(t, 4)
    d = ImageDraw.Draw(img)
    text(d, (70, 98), "场景 ② · 长资料，直接丢给它", 40, PAPER, bold=True)
    files = [("30 万字行业报告.pdf", 200, GOLD), ("往期会议记录.docx", 262, TEAL), ("学习资料包.zip", 324, CORAL)]
    for i, (name, y, color) in enumerate(files):
        appear = ease((t - 0.2 - i * 0.25) / 0.8)
        x = 86 + (1 - appear) * 30
        panel(d, (x, y, x + 320, y + 48), fill=PANEL, radius=10)
        d.rounded_rectangle((x + 12, y + 12, x + 30, y + 36), radius=4, fill=color)
        text(d, (x + 44, y + 24), name, 17, WHITE, anchor="lm")
    pill(d, (90, 400), "> 18,000 字符自动走官方文档附件通道", color=INK, bg=GOLD, size=15)
    text(d, (90, 458), "正文只保留当前请求与最近工具结果，", 16, MUTED)
    text(d, (90, 486), "完整上下文作为附件发给同一账号", 16, MUTED)
    arrow(d, (430, 300), (600, 300), GOLD, 5, (t - 1.2) / 1.2)
    panel(d, (620, 190, 1206, 330), fill="#2c3a34", radius=16)
    text(d, (646, 218), "选长上下文模型", 16, MUTED)
    names = [("Kimi-K3", "1M"), ("DeepSeek-V4.1-Flash", "1M"), ("MiMo-V2.6-Pro", "1M")]
    for i, (name, ctx) in enumerate(names):
        y = 250 + i * 42
        appear = ease((t - 1.5 - i * 0.2) / 0.6)
        if appear <= 0:
            break
        panel(d, (646, y, 940, y + 34), fill=PANEL2, radius=10, width=1)
        text(d, (662, y + 17), name, 17, WHITE, anchor="lm", latin=True, bold=True)
        pill(d, (960, y + 2), ctx + " 上下文", color=GOLD, size=12, h=28)
    panel(d, (620, 360, 1206, 470), fill=PANEL, radius=16)
    text(d, (646, 388), "输出", 16, MUTED)
    outs = ["总结成要点", "全文翻译", "提取数据与结论"]
    x = 646
    for i, label in enumerate(outs):
        appear = ease((t - 2.2 - i * 0.2) / 0.5)
        if appear > 0:
            x += pill(d, (x, 416), label, color=LIME, size=15) + 12
    text(d, (90, 540), "上下文长度按官方目录标称显示；长任务跨窗口自动压缩与续接", 16, MUTED)
    return img


def scene_free(t: float):
    img = background(t, 5)
    d = ImageDraw.Draw(img)
    text(d, (70, 98), "场景 ③ · 每天 30 秒，额度不断档", 40, PAPER, bold=True)
    panel(d, (74, 170, 470, 400), fill=PANEL, radius=16)
    press = 0.5 + 0.5 * math.sin(max(0.0, t - 0.8) * 6)
    d.rounded_rectangle((110, 210, 434, 280), radius=16, fill=LIME if press > 0.5 else "#8db84e")
    centered(d, (272, 245), "每 日 签 到", 26, INK, bold=True)
    text(d, (110, 306), "单账号签到 / 全池一键（号池行内按钮）", 15, MUTED)
    if t > 2.0:
        d.ellipse((384, 330, 420, 366), fill=LIME, outline=INK, width=3)
        centered(d, (402, 348), "✓", 22, INK, bold=True)
        text(d, (110, 336), "服务端日期确认 · 幂等领取", 15, MUTED)
    arrow(d, (486, 285), (560, 285), GOLD, 5, (t - 2.4) / 1.0)
    panel(d, (570, 170, 880, 400), fill=PANEL, radius=16)
    text(d, (596, 198), "周期额度", 16, MUTED)
    for i, (label, v, color) in enumerate([("国内版", 0.62, LIME), ("国际版", 0.45, TEAL)]):
        y = 240 + i * 70
        text(d, (596, y + 14), label, 16, WHITE, anchor="lm")
        d.rounded_rectangle((700, y, 840, y + 26), radius=13, fill="#171d1e")
        grow = ease((t - 2.8 - i * 0.3) / 1.2) * v
        d.rounded_rectangle((700, y, 700 + 140 * min(grow, 1), y + 26), radius=13, fill=color)
        text(d, (596, y + 52), f"剩余 {int(min(grow, 1) * 100)}%", 13, MUTED)
    arrow(d, (896, 285), (960, 285), GOLD, 5, (t - 3.6) / 1.0)
    panel(d, (970, 170, 1206, 400), fill=PANEL, radius=16)
    text(d, (996, 198), "多账号池", 16, MUTED)
    rows = [("user_a…21", LIME, "可用"), ("user_b…12", LIME, "可用"), ("user_4…34", TEAL, "国际版")]
    for i, (name, color, tag) in enumerate(rows):
        y = 236 + i * 52
        appear = ease((t - 4.0 - i * 0.2) / 0.5)
        if appear <= 0:
            break
        d.ellipse((998, y + 8, 1012, y + 22), fill=color)
        text(d, (1024, y + 15), name, 15, WHITE, anchor="lm", latin=True)
        pill(d, (1120, y - 2), tag, size=11, h=24, color=color)
    text(d, (996, 398 - 40), "按版本分组 · 冷却自动轮换", 13, MUTED)
    d.rounded_rectangle((76, 440, 1204, 496), radius=14, fill=PAPER)
    text(d, (100, 468), "倍率 = 相对额度消耗", 19, INK, anchor="lm", bold=True)
    text(d, (420, 468), "不是人民币价格 · Token 面板区分官方计数与本地估算", 16, "#53605a", anchor="lm")
    return img


def scene_end(t: float):
    img = background(t, 6)
    d = ImageDraw.Draw(img)
    p = ease(t / 0.9)
    text(d, (74, 150 + (1 - p) * 18), "现在就试", 58, PAPER, bold=True)
    x = 78
    for i, label in enumerate(["① 安装插件", "② 登录 / 导入", "③ 选模型开聊"]):
        if ease((t - 0.5 - i * 0.25) / 0.5) > 0:
            x += pill(d, (x, 250), label, color=LIME if i == 0 else TEAL if i == 1 else GOLD, size=17, h=36) + 14
    panel(d, (78, 330, 1202, 450), fill=PAPER, outline="#fff4d9", radius=18)
    text(d, (110, 366), "GITHUB", 15, "#5b655c", latin=True, bold=True)
    text(d, (106, 404), "github.com/xianshengl487-star/dsh-connect-tabbit", 26, INK, latin=True, bold=True)
    text(d, (76, 490), "重启 DSH Desktop 后生效 · 0.4.6 · MIT · 第三方插件", 18, MUTED)
    text(d, (76, 528), "国内版 web.tabbit.com / 国际版 web.tabbit.ai · 账号彼此独立", 16, MUTED)
    return img


def frame_at(t: float):
    index = len(SCENES) - 1
    start, end = SCENES[-1][0], SCENES[-1][1]
    for i, (a, b, _) in enumerate(SCENES):
        if a <= t < b:
            index, start, end = i, a, b
            break
    local = max(0.0, min(end - start, t - start))
    return [scene_hook, scene_steps, scene_code, scene_docs, scene_free, scene_end][index](local)


def midi_hz(n: int) -> float:
    return 440.0 * 2 ** ((n - 69) / 12)


def make_audio(path: Path):
    count = int(DURATION * SR)
    roots = [36, 44, 39, 46]
    scale = [60, 63, 65, 67, 70, 72, 75, 77]
    beat = 60 / 96
    boundaries = [row[0] for row in SCENES[1:]]
    pcm = array("h")
    for i in range(count):
        sec = i / SR
        b = sec / beat
        chord = roots[int(sec // (beat * 8)) % len(roots)]
        pad = 0.032 * (math.sin(2 * math.pi * midi_hz(chord + 24) * sec) +
                       0.6 * math.sin(2 * math.pi * midi_hz(chord + 31) * sec) +
                       0.42 * math.sin(2 * math.pi * midi_hz(chord + 36) * sec))
        phase = b % 1
        kick = 0.0
        if phase < .20:
            env = math.exp(-phase * 23)
            kick = .13 * env * math.sin(2 * math.pi * (64 - 26 * phase) * phase * 1.2)
        half = b % 2
        snare = 0.0
        if .98 < half < 1.09:
            env = math.exp(-(half - .98) * 32)
            noise = math.sin(i * 12.9898) * math.sin(i * .0173)
            snare = .026 * env * noise
        slot = int(b * 2)
        local = (b * 2) - slot
        note = scale[(slot + slot // 8) % len(scale)]
        melody_env = math.exp(-local * 13)
        melody = .033 * melody_env * math.sin(2 * math.pi * midi_hz(note) * sec)
        tick = 0.0
        for boundary in boundaries:
            delta = sec - boundary
            if 0 <= delta < .055:
                tick += .028 * math.exp(-delta * 85) * math.sin(2 * math.pi * (850 - 500 * delta) * delta)
        fade = min(1.0, sec / 1.2, (DURATION - sec) / 1.8)
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
