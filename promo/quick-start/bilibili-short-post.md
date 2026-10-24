# B 站投稿包 — 28 秒精简版

## 上传文件

- 视频：`promo/quick-start/dsh-connect-tabbit-short.mp4`（28 秒 / 720p / 0.8 MB）
- 封面：`promo/bilibili-intro/cover.png`（或从视频 00:02 处截取）

## 标题（主打）

**28 秒白嫖 34 个大模型！DSH×Tabbit 一键装，Kimi-K3/DeepSeek-V4 免费用**

### 备选

1. 一行命令白嫖 34 个大模型（Kimi-K3 · DeepSeek-V4 · GLM），AI 编程白嫖党狂喜
2. 别再充 API 了！28 秒装好 DSH×Tabbit，国内国际双版本实测可用

## 简介

一行命令，把 Tabbit 浏览器的 34 个模型额度装进 DeepSeek Harness：

```
dsh plugin --profile desktop add \
  github:xianshengl487-star/dsh-connect-tabbit \
  dsh-connect-workbuddy dsh-connect-trae
```

（最后一条指令一并装上 WorkBuddy / Trae 系列；只用 Tabbit 的话删掉后两个包名即可）

装完重启 DSH → 设置 → 插件配置 → 登录 Tabbit（国内版 / 国际版都支持，国际版需独立账号）→ 选模型开聊。无需 Python / Docker，网关只监听本机回环，账号保存在自己电脑上。

00:00 34 个免费大模型，国内版 + 国际版
00:05 三步上手：装 → 登录 → 选模型
00:13 工具真实执行，含引号代码参数原样保真
00:21 一键安装命令（见上）

2026-10-24 实测：国内版（23 模型）+ 国际版（34 模型）全链路真实补全通过；真实工具调用往返双版本一次通过；每日签到真实领取成功；76 项自动化测试全绿（GitHub Actions CI）。

开源（MIT）：github.com/xianshengl487-star/dsh-connect-tabbit

注意：第三方插件，不隶属 Tabbit / DeepSeek；倍率是相对额度消耗不是人民币价格；Token 本地估算不是官方账单；账号过期、额度耗尽或上游变化仍会导致失败。

## 标签

DSH · Tabbit · 白嫖 · AI工具 · DeepSeek · Kimi · GLM · 开源 · AI编程 · 大模型

## 分区建议

科技 → 软件应用（或 知识·科技 → 效率工具）
