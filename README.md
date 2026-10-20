# 微联叮小助手

Electron 桌面应用：**自动从微联叮客户端取当前 access-token**，并把原先的
「按聊天记录自动创建考试日程」能力封装成带开关的 **考试日程小助理**（开启后立即执行一次，
之后每 3 小时执行一次）。应用常驻系统托盘，关闭窗口只是隐藏。

> 旧的 Python 命令行 / 托盘版留在本地 `legacy/` 目录（未纳入仓库），功能等价，可对照排查。

---

## 下载

不用自己编译，直接下打包好的 exe（[Releases](https://github.com/xun78243-sudo/vlinkto-help/releases/latest)）：

| 文件 | 大小 | 适用 |
| --- | --- | --- |
| [vlinkto-assistant-setup-1.0.0.exe](https://github.com/xun78243-sudo/vlinkto-help/releases/latest/download/vlinkto-assistant-setup-1.0.0.exe) | 106 MB | 安装版：按用户安装、免管理员，自动建桌面与开始菜单快捷方式 |
| [vlinkto-assistant-portable-1.0.0.exe](https://github.com/xun78243-sudo/vlinkto-help/releases/latest/download/vlinkto-assistant-portable-1.0.0.exe) | 106 MB | 便携版：单文件免安装，双击即用 |

使用前提：微联叮客户端已登录、机器能访问 `work.hanweb.com`。

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

### 方式一：装成正式应用（推荐给使用者）

双击 `dist\微联叮小助手-安装版-1.0.0.exe` 按向导装好，之后从桌面 / 开始菜单的
「微联叮小助手」启动；也可以直接用免安装的 `dist\微联叮小助手-便携版-1.0.0.exe`。
详见下方「[打包成安装包](#打包成安装包)」。

### 方式二：源码方式运行（开发调试用）

双击 `start.bat`：

```
start.bat
```

脚本会先清掉可能存在的 `ELECTRON_RUN_AS_NODE` 环境变量再启动（某些工具链会设置它，
导致 `electron.exe` 被当成纯 Node 运行而直接报错退出）。

或者命令行：

```powershell
npm install          # 首次
npm start
```

开发模式（自动打开 DevTools）：`npm run dev`

> 如果命令行里已经设置了 `ELECTRON_RUN_AS_NODE=1`，请先 `Remove-Item Env:\ELECTRON_RUN_AS_NODE`
> 或直接用 `start.bat`。打包后的 exe 同样受这个变量影响（会以 Node 方式启动并立刻退出）。

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

## 打包成安装包

```powershell
npm run dist        # = electron-builder --win
```

产物在 `dist\`：

| 文件 | 说明 |
| --- | --- |
| `微联叮小助手-安装版-1.0.0.exe` | NSIS 安装包（约 106 MB）：可选安装目录、自动建桌面与开始菜单快捷方式、装完可直接启动 |
| `微联叮小助手-便携版-1.0.0.exe` | 单文件免安装版，双击即用（每次启动自解压到临时目录） |
| `win-unpacked\` | 未打包的绿色目录，可直接运行 `微联叮小助手.exe` |

安装行为（`package.json` 的 `build` 字段已配好）：

- 默认**按当前用户安装**（不需要管理员权限），默认目录 `%LOCALAPPDATA%\Programs\vlinkto-exam-assistant`；
- 安装向导允许修改安装路径；桌面、开始菜单快捷方式名均为「微联叮小助手」；
- 卸载：设置 → 应用 → 微联叮小助手，或安装目录下的 `Uninstall 微联叮小助手.exe`；
- 卸载**不删除** `%APPDATA%\微联叮小助手`（配置、记账、日志会保留，重装后继续用）。

图标由 `npm run icons` 生成（`assets/icon.ico` 含 16/24/32/48/64/128/256 多尺寸，
同时生成 `icon.png`、`tray.png`、`tray@2x.png`）。改版本号改 `package.json` 的 `version`
后重新 `npm run dist` 即可。

> 打包机需要能访问 npm 源与 electron 二进制（首次会下载 ~158 MB 的 electron zip，
> 之后命中 `%LOCALAPPDATA%\electron\Cache` 缓存）；NSIS 工具链已在
> `%LOCALAPPDATA%\electron-builder\Cache` 缓存，可离线重复打包。
>
> 若打包中途被中断，可能残留临时锁 `%TEMP%\eb-dl-*.lock*`，删掉再打包即可。

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
assets/
  icon.png / icon.ico  应用图标（ico 为多尺寸，打包用）
  tray.png / tray@2x.png  托盘图标
scripts/
  check-core.js        核心自检
  make-icons.js        生成 PNG/ICO 图标（无第三方依赖）
dist/                  打包产物（安装包、便携版、win-unpacked）
legacy/                旧 Python 实现（等价参考）
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

**5. 安装包装好后双击图标没反应 / 一闪就没了**

先确认不是环境变量问题：若在设置了 `ELECTRON_RUN_AS_NODE=1` 的终端里启动，exe 会以
Node 方式跑并立刻退出（可临时 `Remove-Item Env:\ELECTRON_RUN_AS_NODE` 后重试；
从桌面双击不受影响）。其次看 `%APPDATA%\微联叮小助手\logs\` 里当天日志有没有「启动」记录。

**6. 装完发现不是最新代码**

改完代码要重新 `npm run dist` 才会生成新的 exe；`dist\win-unpacked\` 是本次打包的
绿色副本，可直接双击里面的 `微联叮小助手.exe` 快速验证，无需安装。
