# 国际版（Tabbit Global）三步上手

国际版使用独立的账号池与官方源 `https://web.tabbit.ai`，与国内版登录态互不通用。以下三步完成接入（2026-10-24 已逐步实测）。

## 1. 安装国际版浏览器（可选，但推荐）

从官网下载国际版安装器（如 `Tabbit_stable_x64_intl_*.exe`）并安装。默认安装到：

```
%LOCALAPPDATA%\Tabbit\Application\Tabbit Browser.exe
```

该路径在插件的浏览器自动发现列表中，登录窗口与“导入本机已登录账号”都能直接使用。国内版（`Tabbit Browser` 目录）与国际版（`Tabbit` 目录）可以共存，用户数据互相独立。

## 2. 登录国际版账号（二选一）

- **方式 A · 插件内登录**：DSH → 设置 → 插件配置 → dsh-connect-tabbit → 国际版卡片 → **登录 Tabbit**。插件会用国际版浏览器打开隔离登录窗口（独立临时 profile，不影响你正在用的浏览器窗口），登录成功后凭据自动保存，窗口自动关闭。
- **方式 B · 浏览器登录后导入**：先在国际版浏览器里登录 `web.tabbit.ai`，然后**退出浏览器**（Cookies 文件被浏览器占用时无法读取），再回到插件卡片点 **导入本机已登录账号**。

## 3. 使用

登录成功后国际版网关自动加载 20 个模型目录（Kimi-K3、DeepSeek-V4-Pro、GLM-5.2、Qwen3.7-Max、LongCat-2.0 等），在 DSH 模型选择器中选 `tabbit-global` 区域的模型即可对话。额度、倍率、每日签到、Token 统计与国内版同卡片展示，计数单独存放在 `token-usage-tabbit-global.json`。

## 验证记录（2026-10-24）

| 环节 | 结果 |
|---|---|
| 国际版浏览器发现（`findLoginBrowser`） | ✅ 命中 `%LOCALAPPDATA%\Tabbit\Application\Tabbit Browser.exe` |
| 隔离登录窗口打开 web.tabbit.ai + CDP 控制 | ✅ connected（`test/live-global-login-window.mjs`） |
| Cookie 导入扫描目录识别 | ✅ 真实扫到已登录账号（`test/live-global-import.mjs`） |
| 账号导入国际版账号池 | ✅ imported=1，enabled（`test/live-global-adopt.mjs`） |
| 国际版控制面 e2e | ✅ embedded 网关，34 模型 / 1 账号（登录后实时目录） |
| 国际版全链路真实补全 | ✅ `completion: passed, text: OK`（网关→shim→DSH 适配器） |
| 国际版官方源可达 | ✅ `web.tabbit.ai` HTTP 200 |
| 双网关并行（国内版 + 国际版独立随机端口） | ✅ 运行中的 DSH Desktop 实测两个独立网关端口 |

> 完成第 2 步登录后，可运行 `TABBIT_REGION=tabbit-global node test/e2e-gateway.mjs` 复核控制面；`TABBIT_TEST_COMPLETION=1 TABBIT_REGION=tabbit-global node test/e2e-fullchain.mjs` 验证一次真实补全。
