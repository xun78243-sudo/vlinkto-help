# 微联叮小助手

Electron 桌面应用：**自动从微联叮客户端取当前 access-token**，并把原先的
「按聊天记录自动创建考试日程」能力封装成带开关的 **考试日程小助理**（开启后立即执行一次，
之后每 3 小时执行一次）。应用常驻系统托盘，关闭窗口只是隐藏。

> 旧的 Python 命令行 / 托盘版保留在 `legacy/` 目录，功能等价，可对照排查。

---

## 功能

| 模块 | 说明 |
| --- | --- |
| 账号 | 启动时自动读取微联叮客户端当前登录的 token（`%APPDATA%\vlinkto`），支持「重新获取 Token」按钮随时刷新 |
| 考试日程小助理 | 开关打开 → 立即检测一次 → 之后每 3 小时自动检测；开关关闭 → 停止定时器 |
| 手动执行 | 「立即执行一次」按钮，随时触发一轮检测 |
| 试运行 | 只做判定与日志，不真正创建日程，用来验证规则 |
| 系统托盘 | 关闭窗口隐藏到托盘；托盘右键可显示主窗口、开关小助理、立即执行、重新获取 Token、打开日志/配置、开机自启、退出 |
| 日志 | 界面实时日志 + 按天写入 `logs\exam_YYYY-MM-DD.log` |
| 幂等 | 每条消息按 `msgId` 记账（`state.json`），同一条消息不会重复建日程；首次启动会自动迁移旧 Python 版的记账文件 |

检测逻辑（与 Python 版一致）：

1. 拉取指定群（默认「人力资源部」所在的群）最近的聊天记录，自动翻页到今天零点；
2. 只处理**发送部门 = 人力资源部**、**发布时间 = 今天**、**文本类型**的消息；
3. 依次尝试解密：新版 SM4 传输加密（HKDF-SM3 派生密钥 + HMAC-SM3 校验）→ 旧版 SM2 → 明文；
4. 同时命中「考试/培训类关键词」+「全员受众（含 `@所有人`）」才触发，命中「取消/改期/作废」则跳过；
5. 以消息首行为日程标题，创建**当天 17:00–17:30** 的日程。

---

## 运行

### 方式一：双击 `start.bat`（推荐）

```
start.bat
```

脚本会先清掉可能存在的 `ELECTRON_RUN_AS_NODE` 环境变量再启动（某些工具链会设置它，
导致 `electron.exe` 被当成纯 Node 运行而直接报错退出）。

### 方式二：命令行

```powershell
npm install          # 首次
npm start
```

开发模式（自动打开 DevTools）：`npm run dev`

> 如果命令行里已经设置了 `ELECTRON_RUN_AS_NODE=1`，请先 `Remove-Item Env:\ELECTRON_RUN_AS_NODE`
> 或直接用 `start.bat`。

### 前置条件

- 微联叮客户端处于**已登录**状态（token 从它的本地数据里读取，不在代码里硬编码）；
- 机器能访问 `work.hanweb.com`。

---

## 数据目录

首次启动会在 `%APPDATA%\微联叮小助手\` 下创建：

| 文件 | 说明 |
| --- | --- |
| `config.json` | 全部可配置项（接口、群、部门、关键词、日程时间、加密私钥、开关） |
| `state.json` | 已处理消息记账，用于幂等 |
| `logs\exam_YYYY-MM-DD.log` | 按天滚动日志 |

界面上的「打开配置文件」「打开日志目录」按钮会直接定位到这些位置。
改完 `config.json` 后重启应用生效（开关状态除外，开关即时生效）。

### 常用配置项

```jsonc
{
  "chat": {
    "groupId": "cda6b214bd004867a1e46af520ad8696",   // 目标群
    "senderGroupNames": ["人力资源部"],                // 只看这些部门的发言
    "maxPages": 10                                    // 最多回溯页数
  },
  "rules": {
    "eventKeywords": ["考试", "考核", "培训"],          // 任一命中
    "audienceKeywords": ["所有人", "全体", "全员"],     // 任一命中（@所有人 自动算命中）
    "excludeKeywords": ["取消", "改期", "作废"],        // 任一命中直接跳过
    "requireAudienceKeyword": true                    // false 时只要有考试关键词就建
  },
  "schedule": {
    "startTime": "17:00",
    "endTime": "17:30",
    "persons": "a5a9854995ee43d5a10f0e3c52d4e21b"
  },
  "exam": {
    "enabled": false,     // 开关（界面上切换会同步写回）
    "intervalHours": 3    // 检测间隔
  }
}
```

---

## Token 说明

- token 全部来自微联叮客户端，代码里不保存任何 token 常量；
- 取 token 的顺序（移植自 `get-vlinkto-token.ps1`）：
  1. `%APPDATA%\vlinkto\config.json` 的 `mdltoken` 字段（最可靠）；
  2. `%APPDATA%\vlinkto` 下 Electron Local Storage 的 `*.ldb` / `*.log` 里内嵌的 JWT；
- 多个副本时取 **exp 最晚且未过期** 的那枚；解析 JWT 的 `exp` 显示剩余时间；
- 每轮检测前都会重新读一次，token 过期会在界面和日志里明确提示，「重新获取 Token」按钮
  可手动刷新（通常做完这步需要在微联叮客户端重新登录）。

---

## 自检

```powershell
npm run check        # 离线自检：SM3/SM4/SM2 标准向量、规则、标题、入参、token 读取
npm run check:live   # 额外跑一次真实接口（dry-run，不建日程）
npm run smoke        # Electron 冒烟：渲染、开关、定时器、刷新按钮、关窗隐藏到托盘
```

`npm run check:live` 的输出形如：

```
共 14 条 / 本部门 4 条 / 当天 1 条 / 命中 1 条 / 将建 1 条 / 解密失败 0 条
```

---

## 打包（可选）

```powershell
npm install --save-dev electron-builder
npx electron-builder --win
```

产物在 `dist\`（已配置 nsis 安装包 + portable 免安装版，图标取 `assets/icon.png`）。

---

## 目录结构

```
src/
  main.js              主进程：窗口、托盘、IPC、token、定时器
  preload.js           contextBridge 安全桥
  config.js            默认配置 + userData 持久化 + 旧版 state 迁移
  token.js             从微联叮客户端取 access-token
  exam/
    crypto.js          SM3 / HMAC-SM3 / SM4 / SM2（纯 JS，不依赖 OpenSSL）
    im.js              消息解密门面（SM4 传输链路 / 旧 SM2 / 明文）+ 密文形态识别
    api.js             统一 HTTP 封装（access-token 头、重试、401 识别）
    chat.js            拉聊天记录、规则判定、建日程、幂等
  renderer/            界面（index.html / styles.css / renderer.js）
assets/                应用与托盘图标
scripts/
  check-core.js        核心自检
  make-icons.js        生成 PNG 图标（无第三方依赖）
legacy/               旧 Python 实现（等价参考）
```

---

## 常见问题

**1. 启动就退出，命令行报 `Cannot read properties of undefined (reading 'requestSingleInstanceLock')`**

当前 shell 设置了 `ELECTRON_RUN_AS_NODE=1`，Electron 被当成普通 Node 跑了。
用 `start.bat`，或先 `Remove-Item Env:\ELECTRON_RUN_AS_NODE`。

**2. 界面提示「未能获取 access-token」**

微联叮客户端没登录 / 已退出登录。登录后点「重新获取 Token」。

**3. 检测到了消息但没建日程**

看日志里的跳过原因：非本部门、非当天、关键词/受众不满足、已处理过（幂等）、
或密文无法解密（`transferKey` / SM2 私钥不对）。

**4. 关闭窗口后程序不见了**

它藏在托盘右下角，单击托盘图标或右键「显示主窗口」即可；右键「退出」才真正结束进程。
