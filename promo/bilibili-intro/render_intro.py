#!/usr/bin/env python3
"""Render a caption-led, original 16:9 introduction to DSH Connect Tabbit."""

from __future__ import annotations

import math
import os
import subprocess
import sys
import wave
from array import array
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
import imageio_ffmpeg


ROOT = Path(__file__).resolve().parent
OUT = ROOT / "dsh-connect-tabbit-intro.mp4"
COVER = ROOT / "cover.png"
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
LIME = "#c9e77c"
CORAL = "#f38368"
GOLD = "#e5b85d"
TEAL = "#76c8b5"

FONT_ZH = Path(r"C:\Windows\Fonts\NotoSansSC-VF.ttf")
FONT_ZH_BOLD = Path(r"C:\Windows\Fonts\Dengb.ttf")
FONT_LATIN = Path(r"C:\Windows\Fonts\consola.ttf")
FONT_LATIN_BOLD = Path(r"C:\Windows\Fonts\consolab.ttf")

SCENES = [
    (0, 6, "开场"),
    (6, 17, "内置网关"),
    (17, 29, "账号池"),
    (29, 40, "模型设置"),
    (40, 52, "工具调用"),
    (52, 63, "额度与用量"),
    (63, 73, "长任务"),
    (73, 82, "边界"),
    (82, 90, "开始使用"),
]
DURATION = SCENES[-1][1]
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


def pop(x: float) -> float:
    x = max(0.0, min(1.0, x))
    return 1 + 0.16 * math.exp(-7 * x) * math.sin(12 * x)


def clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def text(draw: ImageDraw.ImageDraw, xy, value, size=24, fill=WHITE, *, anchor=None,
         latin=False, bold=False, stroke=0, stroke_fill=BG):
    draw.text(xy, value, font=font(size, latin, bold), fill=fill, anchor=anchor,
              stroke_width=stroke, stroke_fill=stroke_fill)


def centered(draw, xy, value, size=24, fill=WHITE, **kw):
    text(draw, xy, value, size, fill, anchor="mm", **kw)


def panel(draw, box, fill=PANEL, outline=LINE, radius=22, width=1):
    x1, y1, x2, y2 = box
    draw.rounded_rectangle((x1 + 1, y1 + 7, x2 + 1, y2 + 7), radius=radius, fill="#0d1213")
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def pill(draw, xy, label, color=LIME, bg=PANEL2, size=17, width=None):
    x, y = xy
    f = font(size, bold=True)
    tw = draw.textbbox((0, 0), label, font=f)[2]
    w = width or tw + 30
    h = 34
    draw.rounded_rectangle((x, y, x + w, y + h), radius=17, fill=bg, outline=LINE, width=1)
    text(draw, (x + 15, y + h // 2), label, size, color, anchor="lm", bold=True)
    return w


def arrow(draw, start, end, color=TEAL, width=4, progress=1.0):
    x1, y1 = start
    x2, y2 = end
    p = ease(progress)
    ex, ey = x1 + (x2 - x1) * p, y1 + (y2 - y1) * p
    draw.line((x1, y1, ex, ey), fill=color, width=width)
    if p > 0.82:
        angle = math.atan2(ey - y1, ex - x1)
        r = 13
        a1, a2 = angle + 2.6, angle - 2.6
        draw.polygon([(ex, ey), (ex + r * math.cos(a1), ey + r * math.sin(a1)),
                      (ex + r * math.cos(a2), ey + r * math.sin(a2))], fill=color)


def node(draw, box, title, sub, accent=LIME, fill=PANEL2, title_color=WHITE):
    x1, y1, x2, y2 = box
    draw.rounded_rectangle(box, radius=18, fill=fill, outline=LINE, width=2)
    draw.rounded_rectangle((x1 + 14, y1 + 16, x1 + 22, y2 - 16), radius=4, fill=accent)
    text(draw, (x1 + 40, y1 + 25), title, 23, title_color, bold=True)
    text(draw, (x1 + 40, y1 + 60), sub, 16, MUTED)


def background(t: float, section: int):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    # Quiet drafting grid, clipped visually by low contrast.
    for x in range(42, W, 48):
        d.line((x, 74, x, 658), fill="#192123", width=1)
    for y in range(90, 660, 48):
        d.line((42, y, W - 42, y), fill="#192123", width=1)
    text(d, (54, 36), "DSH CONNECT  /  TABBIT", 15, MUTED, latin=True, bold=True)
    text(d, (W - 54, 36), "THIRD-PARTY PLUGIN     0.4.3", 14, MUTED,
         anchor="ra", latin=True)
    d.line((54, 62, W - 54, 62), fill=LINE, width=1)
    # Progress is presented as a single editorial timeline, not slide pagination.
    total = DURATION
    d.rounded_rectangle((54, 675, W - 54, 680), radius=2, fill="#263133")
    d.rounded_rectangle((54, 675, 54 + (W - 108) * clamp01(t / total), 680), radius=2, fill=LIME)
    text(d, (54, 698), f"{section:02d}  /  09", 12, MUTED, latin=True, bold=True)
    text(d, (W - 54, 698), "界面示意 · 功能以当前版本为准", 12, MUTED, anchor="ra")
    return img


def scene_open(t: float):
    img = background(t, 1)
    d = ImageDraw.Draw(img)
    p = ease(t / 1.2)
    text(d, (82, 142 + (1 - p) * 22), "白嫖 34 个大模型", 72, PAPER, bold=True)
    text(d, (82, 226 + (1 - p) * 22), "DSH × Tabbit 一键直连", 68, LIME, bold=True)
    text(d, (88, 338), "国内版 + 国际版 · Token 统计 · 每日签到 · 长任务续接", 25, MUTED)
    pill(d, (88, 407), "DSH CONNECT TABBIT", color=INK, bg=LIME, size=16)
    text(d, (88, 510), "把浏览器的模型额度，变成你的免费本地网关。", 24, WHITE)
    # Original abstract routing emblem.
    cx, cy = 978, 340
    orbit = 154 + 5 * math.sin(t * 1.3)
    for r, color, width in [(orbit, LINE, 2), (orbit * .68, "#425252", 1)]:
        d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=color, width=width)
    for i, (ang, col, rr) in enumerate([(0.4, LIME, 13), (2.55, CORAL, 10), (4.45, TEAL, 9)]):
        a = ang + t * (0.16 if i % 2 == 0 else -0.12)
        x, y = cx + orbit * math.cos(a), cy + orbit * math.sin(a)
        d.ellipse((x - rr, y - rr, x + rr, y + rr), fill=col)
    d.rounded_rectangle((cx - 97, cy - 70, cx + 97, cy + 70), radius=28, fill=PANEL,
                        outline="#506264", width=2)
    # A simple custom bridge glyph, not a product logo.
    d.rounded_rectangle((cx - 53, cy - 31, cx - 7, cy + 31), radius=10, outline=LIME, width=8)
    d.rounded_rectangle((cx + 7, cy - 31, cx + 53, cy + 31), radius=10, outline=TEAL, width=8)
    d.line((cx - 15, cy, cx + 15, cy), fill=PAPER, width=7)
    centered(d, (cx, cy + 113), "MODEL  →  TOOLS", 17, MUTED, latin=True, bold=True)
    return img


def scene_gateway(t: float):
    img = background(t, 2)
    d = ImageDraw.Draw(img)
    text(d, (70, 102), "把网关，装回插件里", 45, PAPER, bold=True)
    text(d, (74, 164), "以前：外部服务要单独启动、配置和维护", 21, MUTED)
    # Collapsing old chain.
    p = ease(t / 3.2)
    panel(d, (72, 228, 536, 464), fill="#1b2426")
    pill(d, (96, 250), "旧连接方式", color=CORAL, size=15)
    node(d, (100, 316, 236, 403), "DSH", "模型适配器", PAPER)
    node(d, (362, 316, 506, 403), "网关", "外部进程", CORAL)
    arrow(d, (238, 360), (351, 360), CORAL, 3, 1 - .68 * p)
    d.line((282, 337, 306, 384), fill=CORAL, width=4)
    d.line((306, 337, 282, 384), fill=CORAL, width=4)
    text(d, (98, 428), "安装依赖 · 固定端口 · 额外故障点", 16, MUTED)
    # New embedded path occupies the visual center and grows with the transition.
    panel(d, (568, 228, 1208, 464), fill="#202b2c", outline="#596d61", width=2)
    pill(d, (592, 250), "现在：插件内置", color=INK, bg=LIME, size=15)
    slide = ease((t - 1.0) / 2.6)
    offset = (1 - slide) * 56
    node(d, (600 + offset, 316, 750 + offset, 403), "DSH", "同一进程", PAPER)
    node(d, (818 + offset, 316, 976 + offset, 403), "内置网关", "随机本机端口", LIME)
    node(d, (1046 + offset, 316, 1177 + offset, 403), "Tabbit", "国内 / 国际", TEAL)
    arrow(d, (754 + offset, 359), (806 + offset, 359), LIME, 4, (t - .7) / 1.5)
    arrow(d, (980 + offset, 359), (1034 + offset, 359), TEAL, 4, (t - 1.5) / 1.5)
    # Moving packet reinforces that this is a live route.
    route = clamp01((t - 2.4) / 2.4)
    x = 750 + 294 * route
    if route < 1:
        d.ellipse((x - 8, 351 + 5 * math.sin(t * 7) - 8, x + 8, 367 + 5 * math.sin(t * 7)), fill=GOLD)
    text(d, (76, 524), "随插件启动与释放", 22, WHITE, bold=True)
    text(d, (76, 562), "无需 Python / Docker / 独立常驻网关", 20, MUTED)
    text(d, (678, 524), "国内版与国际版各自隔离", 22, WHITE, bold=True)
    text(d, (678, 562), "网关只监听本机回环地址", 20, MUTED)
    return img


def scene_accounts(t: float):
    img = background(t, 3)
    d = ImageDraw.Draw(img)
    text(d, (70, 100), "登录或导入，账号留在本机", 43, PAPER, bold=True)
    text(d, (74, 158), "每个版本使用自己的账号池", 21, MUTED)
    # Login window card.
    xoff = 48 * (1 - ease(t / 1.1))
    panel(d, (74 + xoff, 224, 416 + xoff, 546), fill=PAPER, outline="#fff4d9")
    pill(d, (99 + xoff, 246), "添加账号", color=INK, bg=LIME, size=16)
    text(d, (101 + xoff, 309), "选择接入方式", 25, INK, bold=True)
    for i, (title, sub, color) in enumerate([
        ("官方登录", "浏览器中完成授权", LIME),
        ("导入凭据 / 文件", "JWT · Cookie · JSON", TEAL),
        ("导入本机登录态", "支持的 Windows 配置", GOLD),
    ]):
        yy = 358 + i * 54
        d.rounded_rectangle((100 + xoff, yy, 386 + xoff, yy + 42), radius=12, fill="#ded8ca")
        d.ellipse((112 + xoff, yy + 13, 128 + xoff, yy + 29), fill=color)
        text(d, (143 + xoff, yy + 11), title, 17, INK, bold=True)
        text(d, (143 + xoff, yy + 33), sub, 13, "#626c65")
    # Region pools are deliberately separate.
    panel(d, (492, 224, 1205, 546), fill=PANEL)
    pill(d, (520, 246), "账号池分区", color=LIME, size=15)
    # divider between independent credentials
    d.line((850, 300, 850, 500), fill=LINE, width=2)
    for x, title, sub, color in [(526, "Tabbit 国内版", "web.tabbit.com", LIME),
                                (882, "Tabbit 国际版", "web.tabbit.ai", TEAL)]:
        text(d, (x, 315), title, 25, WHITE, bold=True)
        text(d, (x, 352), sub, 16, MUTED, latin=True)
        for j in range(2):
            yy = 390 + j * 52
            d.rounded_rectangle((x, yy, x + 288, yy + 39), radius=11, fill=PANEL2, outline=LINE)
            d.ellipse((x + 14, yy + 14, x + 26, yy + 26), fill=color if j == 0 else "#5b6762")
            text(d, (x + 42, yy + 20), f"账号槽位 0{j + 1}", 16, WHITE, anchor="lm")
            pill(d, (x + 189, yy + 3), "可管理", color, bg=BG, size=12, width=84)
    text(d, (78, 594), "本机保存凭据", 21, LIME, bold=True)
    text(d, (262, 594), "→", 23, MUTED, latin=True)
    text(d, (307, 594), "运行时同步内存副本", 21, WHITE, bold=True)
    text(d, (730, 594), "不会把完整凭据展示给设置卡片", 18, MUTED)
    return img


def scene_models(t: float):
    img = background(t, 4)
    d = ImageDraw.Draw(img)
    text(d, (70, 100), "模型、额度、倍率，集中查看", 43, PAPER, bold=True)
    text(d, (74, 158), "设置卡片把常用状态放在模型旁边", 21, MUTED)
    panel(d, (74, 218, 798, 564), fill="#202a2b")
    # Faux UI header and region tabs.
    d.rounded_rectangle((96, 240, 776, 293), radius=14, fill="#151d1f")
    text(d, (118, 266), "dsh-connect-tabbit", 18, WHITE, anchor="lm", bold=True, latin=True)
    pill(d, (588, 249), "国内版", color=INK, bg=LIME, size=14, width=84)
    pill(d, (682, 249), "国际版", color=MUTED, bg=PANEL2, size=14, width=84)
    text(d, (105, 326), "模型选择", 17, MUTED, bold=True)
    for i, (name, mult, col) in enumerate([("Kimi-K3 · 1M 上下文", "倍率可见", TEAL), ("DeepSeek-V4-Pro", "倍率可见", LIME), ("GLM / Qwen / MiMo · 34 个", "目录动态刷新", GOLD)]):
        yy = 354 + i * 57
        d.rounded_rectangle((102, yy, 768, yy + 45), radius=11, fill=PANEL2 if i != 1 else "#35443d",
                            outline=LINE)
        d.ellipse((117, yy + 15, 133, yy + 31), fill=col)
        text(d, (149, yy + 23), name, 18, WHITE, anchor="lm", bold=i == 1)
        text(d, (740, yy + 23), mult, 15, MUTED, anchor="rm")
    # Side stack: quota, check-in, account pool.
    for i, (y, title, detail, col, icon) in enumerate([
        (218, "周期额度", "官方接口提供时显示", LIME, "01"),
        (335, "模型倍率", "相对消耗，不是人民币单价", TEAL, "02"),
        (452, "每日签到", "读取状态并确认结果", GOLD, "03"),
    ]):
        panel(d, (836, y, 1205, y + 100), fill=PANEL)
        text(d, (862, y + 31), icon, 16, col, latin=True, bold=True)
        text(d, (910, y + 31), title, 22, WHITE, anchor="lm", bold=True)
        text(d, (862, y + 69), detail, 15, MUTED)
    pill(d, (861, 577), "国内 / 国际独立账号池", color=WHITE, bg=PANEL2, size=14)
    return img


def scene_tools(t: float):
    img = background(t, 5)
    d = ImageDraw.Draw(img)
    text(d, (70, 98), "模型发起工具，DSH 负责执行", 43, PAPER, bold=True)
    text(d, (74, 155), "从一句话，走完真正的工具往返", 21, MUTED)
    # User request strip.
    panel(d, (74, 214, 1207, 289), fill=PAPER, outline="#faf2dd")
    pill(d, (96, 234), "用户", color=INK, bg=LIME, size=14, width=70)
    text(d, (190, 252), "“打开 Edge，访问 bilibili.com”", 24, INK, anchor="lm", bold=True)
    # Four stages on a clear left-to-right rail.
    cards = [
        (78, "01", "模型提议", "open_page(url)", LIME),
        (370, "02", "DSH 执行", "浏览器 / 系统工具", TEAL),
        (662, "03", "结果返回", "success · title", GOLD),
        (954, "04", "模型继续", "基于真实结果回复", CORAL),
    ]
    p = clamp01((t - .6) / 4.2)
    for i, (x, n, title, sub, color) in enumerate(cards):
        slide = 34 * (1 - ease((t - i * .38) / 1.0))
        box = (x, 369 + slide, x + 246, 489 + slide)
        panel(d, box, fill=PANEL2 if i == 1 else PANEL)
        text(d, (x + 20, 391 + slide), n, 15, color, latin=True, bold=True)
        text(d, (x + 58, 408 + slide), title, 22, WHITE, anchor="lm", bold=True)
        text(d, (x + 20, 454 + slide), sub, 15, MUTED, latin=i in (0, 2))
    for x1, x2, start in [(327, 359, .4), (619, 651, 1.1), (911, 943, 1.8)]:
        arrow(d, (x1, 429), (x2, 429), TEAL, 3, (t - start) / 1.3)
    # Trust ribbon and an explicit no-fabricated-success cue.
    d.rounded_rectangle((76, 525, 1204, 598), radius=16, fill="#28352f", outline="#52614d")
    d.ellipse((98, 550, 120, 572), fill=LIME)
    centered(d, (109, 561), "✓", 15, INK, bold=True)
    text(d, (141, 560), "模型文字不是执行证据", 20, WHITE, anchor="lm", bold=True)
    text(d, (495, 560), "工具结果由 DSH 执行器返回；失败会明确显示。", 18, MUTED, anchor="lm")
    return img


def scene_usage(t: float):
    img = background(t, 6)
    d = ImageDraw.Draw(img)
    text(d, (70, 100), "看得到消耗，也看得懂来源", 43, PAPER, bold=True)
    text(d, (74, 158), "官方回传优先；没有回传，就明确标估算", 21, MUTED)
    # Official path.
    panel(d, (74, 226, 625, 495), fill="#1f2c2a", outline="#496358", width=2)
    pill(d, (100, 248), "官方数据（若上游返回）", color=INK, bg=TEAL, size=14)
    text(d, (102, 317), "输入", 18, MUTED)
    text(d, (285, 317), "输出", 18, MUTED)
    text(d, (468, 317), "累计", 18, MUTED)
    for x, color in [(105, LIME), (288, TEAL), (471, GOLD)]:
        d.rounded_rectangle((x, 349, x + 130, 400), radius=12, fill="#11191a", outline=LINE)
        centered(d, (x + 65, 374), "—", 25, color, latin=True, bold=True)
    text(d, (102, 439), "收到官方 usage 才标为官方计数", 16, WHITE)
    # Estimate path.
    panel(d, (656, 226, 1207, 495), fill="#2b2521", outline="#75604a", width=2)
    pill(d, (682, 248), "本地文本估算", color=INK, bg=GOLD, size=14)
    text(d, (684, 322), "按文本长度近似统计", 24, WHITE, bold=True)
    # Stylized ledger bars, easing in sequentially.
    vals = [(.68, LIME, "输入"), (.42, TEAL, "输出"), (.82, GOLD, "累计")]
    for i, (v, c, name) in enumerate(vals):
        yy = 370 + i * 32
        text(d, (684, yy + 8), name, 14, MUTED, anchor="lm")
        d.rounded_rectangle((752, yy, 1153, yy + 14), radius=7, fill="#171d1e")
        d.rounded_rectangle((752, yy, 752 + 401 * v * ease((t - i * .3) / 1.2), yy + 14), radius=7, fill=c)
    # Important accounting limitation held in a high contrast band.
    d.rounded_rectangle((75, 526, 1206, 606), radius=16, fill=PAPER)
    text(d, (101, 558), "估算 ≠ 官方账单", 24, INK, anchor="lm", bold=True)
    text(d, (445, 558), "不等于实际扣费 · 不计入 DSH 人民币费用账本", 19, "#53605a", anchor="lm")
    pill(d, (1013, 540), "透明标注", color=INK, bg=LIME, size=14, width=155)
    return img


def scene_long(t: float):
    img = background(t, 7)
    d = ImageDraw.Draw(img)
    text(d, (70, 99), "长任务中断后，尽量接回原任务", 43, PAPER, bold=True)
    text(d, (74, 157), "有保活、有续接、有上限；不把半截结果说成完成", 20, MUTED)
    # Timeline is a single continuous path. The reconnect loops back to the same task.
    y = 360
    d.line((116, y, 1147, y), fill="#405153", width=5)
    milestones = [(151, "生成中", LIME), (404, "保活", TEAL), (658, "短暂断流", CORAL), (916, "续接原事件", GOLD), (1128, "完成 / 报错", LIME)]
    progress = clamp01((t - .6) / 4.7)
    d.line((116, y, 116 + (1031 * progress), y), fill=TEAL, width=5)
    for i, (x, label, color) in enumerate(milestones):
        appear = ease((t - .15 * i) / 1.0)
        r = 12 + (2 if i == 2 and t > 4.5 and t < 6 else 0)
        d.ellipse((x - r, y - r, x + r, y + r), fill=color if appear else BG, outline=color, width=3)
        centered(d, (x, y + 44), label, 16, WHITE if appear else MUTED)
    # The break is visible, then a curved return line meets the same run marker.
    if 2.4 < t < 7.2:
        d.line((658, 344, 658, 317, 694, 317), fill=CORAL, width=4)
        d.arc((631, 271, 758, 362), 190, 350, fill=GOLD, width=4)
        arrow(d, (740, 299), (797, 326), GOLD, 3, (t - 3.0) / 2.1)
    panel(d, (152, 463, 1130, 574), fill=PANEL)
    for i, (x, title, sub, color) in enumerate([
        (184, "SSE 保活", "减少空闲断连", TEAL),
        (494, "事件续接", "按游标去重", GOLD),
        (804, "有限重试", "预算耗尽就报错", CORAL),
    ]):
        d.ellipse((x, 493, x + 20, 513), fill=color)
        text(d, (x + 34, 499), title, 20, WHITE, anchor="lm", bold=True)
        text(d, (x + 34, 539), sub, 15, MUTED)
    return img


def scene_limits(t: float):
    img = background(t, 8)
    d = ImageDraw.Draw(img)
    text(d, (70, 101), "更稳，不等于永不断开", 45, PAPER, bold=True)
    text(d, (74, 160), "工具桥接与长任务能力仍依赖账号和上游服务", 21, MUTED)
    cards = [
        (77, "账号过期", "需要重新登录", CORAL, "AUTH"),
        (475, "额度用尽", "等待周期恢复", GOLD, "QUOTA"),
        (873, "上游变化 / 停服", "可能需要适配更新", TEAL, "UPSTREAM"),
    ]
    for i, (x, title, sub, color, tag) in enumerate(cards):
        yoff = 28 * (1 - ease((t - .15 * i) / 1.0))
        panel(d, (x, 252 + yoff, x + 330, 389 + yoff), fill=PANEL)
        pill(d, (x + 23, 274 + yoff), tag, color=color, size=13)
        text(d, (x + 23, 331 + yoff), title, 24, WHITE, bold=True)
        text(d, (x + 23, 367 + yoff), sub, 17, MUTED)
    # Specific verification boundary, plainly visible rather than buried in the caption.
    d.rounded_rectangle((77, 445, 1204, 582), radius=20, fill="#2a2521", outline="#655a42", width=2)
    d.ellipse((104, 475, 144, 515), fill=GOLD)
    centered(d, (124, 495), "!", 25, INK, latin=True, bold=True)
    text(d, (169, 478), "国际版需独立账号；2026-10-24 已完成国际版真实账号全链路验证。", 21, WHITE, bold=True)
    text(d, (169, 528), "国内版与国际版账号、额度和模型目录彼此独立（34 模型 / e2e 通过）。", 18, MUTED)
    return img


def scene_finish(t: float):
    img = background(t, 9)
    d = ImageDraw.Draw(img)
    text(d, (74, 104), "三步接入，开始使用", 45, PAPER, bold=True)
    steps = [(86, "01", "安装插件"), (381, "02", "登录 / 导入"), (676, "03", "选择模型")]
    p = clamp01((t - .3) / 3.0)
    for i, (x, num, label) in enumerate(steps):
        y = 214 + (1 - ease((t - .16 * i) / 1.1)) * 30
        d.rounded_rectangle((x, y, x + 246, y + 96), radius=22, fill=PANEL, outline=LINE, width=2)
        text(d, (x + 22, y + 28), num, 17, LIME if i < 2 else TEAL, latin=True, bold=True)
        text(d, (x + 22, y + 68), label, 25, WHITE, bold=True)
        if i < 2:
            arrow(d, (x + 256, y + 48), (x + 285, y + 48), TEAL, 3, p)
    # Final callout with the product name and an original bridge motif.
    panel(d, (78, 367, 1204, 589), fill=PAPER, outline="#fff4d9")
    text(d, (111, 411), "DSH CONNECT", 18, "#5b655c", latin=True, bold=True)
    text(d, (107, 471), "TABBIT", 52, INK, latin=True, bold=True)
    text(d, (109, 526), "0.4.3  ·  MIT  ·  第三方插件", 17, "#5b655c", latin=True)
    text(d, (109, 556), "github.com/xianshengl487-star/dsh-connect-tabbit", 15, "#7c8a7f", latin=True)
    # abstract loop icon
    cx, cy = 1032, 480
    d.rounded_rectangle((cx - 72, cy - 49, cx - 6, cy + 49), radius=20, outline="#94b75c", width=10)
    d.rounded_rectangle((cx + 6, cy - 49, cx + 72, cy + 49), radius=20, outline="#4da895", width=10)
    d.line((cx - 24, cy, cx + 24, cy), fill=INK, width=10)
    text(d, (640, 625), "安装 → 登录 / 导入 → 选模型 → 开始对话", 20, WHITE, anchor="mm", bold=True)
    return img


def draw_scene(index: int, local_t: float):
    return [scene_open, scene_gateway, scene_accounts, scene_models, scene_tools,
            scene_usage, scene_long, scene_limits, scene_finish][index](local_t)


def frame_at(t: float):
    index = len(SCENES) - 1
    start, end, _ = SCENES[index]
    for i, (a, b, _) in enumerate(SCENES):
        if a <= t < b:
            index, start, end = i, a, b
            break
    local = max(0.0, min(end - start, t - start))
    img = draw_scene(index, local)
    transition = 0.28
    if index < len(SCENES) - 1 and t >= end - transition:
        alpha = ease((t - (end - transition)) / transition)
        nxt = draw_scene(index + 1, 0)
        img = Image.blend(img, nxt, alpha)
    if index == 0 and t < 0.45:
        img = Image.blend(Image.new("RGB", (W, H), BG), img, ease(t / 0.45))
    if t > DURATION - 0.45:
        img = Image.blend(img, Image.new("RGB", (W, H), BG), ease((t - (DURATION - 0.45)) / 0.45))
    return img


def midi_hz(n: int) -> float:
    return 440.0 * 2 ** ((n - 69) / 12)


def make_audio(path: Path):
    """Create a quiet, original 96 BPM synth score and soft UI accents."""
    count = int(DURATION * SR)
    # C-minor / Eb / Ab / Bb gives the product piece a warm, restrained pulse.
    roots = [36, 44, 39, 46]
    scale = [60, 63, 65, 67, 70, 72, 75, 77]
    beat = 60 / 96
    pcm = array("h")
    for i in range(count):
        sec = i / SR
        b = sec / beat
        chord = roots[int(sec // (beat * 8)) % len(roots)]
        # Quiet soft-pad triad.
        pad = 0.032 * (math.sin(2 * math.pi * midi_hz(chord + 24) * sec) +
                       0.6 * math.sin(2 * math.pi * midi_hz(chord + 31) * sec) +
                       0.42 * math.sin(2 * math.pi * midi_hz(chord + 36) * sec))
        # Gentle kick and backbeat, each with a short decay.
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
        # Short marimba-like pentatonic notes on an eighth-note lattice.
        slot = int(b * 2)
        local = (b * 2) - slot
        note = scale[(slot + slot // 8) % len(scale)]
        melody_env = math.exp(-local * 13)
        melody = .033 * melody_env * math.sin(2 * math.pi * midi_hz(note) * sec)
        # Tiny transition ticks are low in the mix, avoiding stock sound effects.
        tick = 0.0
        for boundary in [6, 17, 29, 40, 52, 63, 73, 82]:
            delta = sec - boundary
            if 0 <= delta < .055:
                tick += .028 * math.exp(-delta * 85) * math.sin(2 * math.pi * (850 - 500 * delta) * delta)
        fade = min(1.0, sec / 1.2, (DURATION - sec) / 1.8)
        sample = max(-.8, min(.8, (pad + kick + snare + melody + tick) * fade))
        # Subtle stereo width from a tiny delayed/tinted split.
        left = int(sample * 32767)
        right = int(max(-.8, min(.8, (pad * .92 + kick + snare + melody * 1.04 + tick) * fade)) * 32767)
        pcm.append(left)
        pcm.append(right)
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(SR)
        wav.writeframes(pcm.tobytes())


def render(output: Path):
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    wav_path = ROOT / "soundtrack.wav"
    raw = subprocess.Popen([
        ffmpeg, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-", "-an", "-c:v", "libx264",
        "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        str(output),
    ], stdin=subprocess.PIPE)
    if raw.stdin is None:
        raise RuntimeError("Could not open ffmpeg frame pipe")
    try:
        for frame_no in range(int(DURATION * FPS)):
            t = frame_no / FPS
            raw.stdin.write(frame_at(t).tobytes())
            if frame_no % (FPS * 10) == 0:
                print(f"video {t:05.1f}s / {DURATION:.0f}s", flush=True)
    finally:
        raw.stdin.close()
    code = raw.wait()
    if code:
        raise RuntimeError(f"ffmpeg video encode failed: {code}")
    print("Rendering original soundtrack…", flush=True)
    make_audio(wav_path)
    merged = output.with_suffix(".muxed.mp4")
    subprocess.run([
        ffmpeg, "-y", "-loglevel", "error", "-i", str(output), "-i", str(wav_path),
        "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", str(merged),
    ], check=True)
    merged.replace(output)
    wav_path.unlink(missing_ok=True)
    print(f"Wrote {output} ({output.stat().st_size / 1024 / 1024:.1f} MiB)", flush=True)


def make_cover():
    img = scene_open(2.0)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((797, 535, 1191, 594), radius=18, fill=CORAL)
    text(d, (994, 565), "插件介绍 · 真实使用路径", 19, INK, anchor="mm", bold=True)
    img.save(COVER, optimize=True)


def main():
    make_cover()
    output = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else OUT
    render(output)


if __name__ == "__main__":
    main()
