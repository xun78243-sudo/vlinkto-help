# 微联叮小助手

Electron 桌面应用：**自动从微联叮客户端取当前 access-token**，提供两个能力：

- **考试日程小助理** —— 按聊天记录自动创建考试日程（开启后立即执行一次，之后每 3 小时一次）；
- **缺陷单总结助手** —— 输入工单编号 + git 分支地址，自动生成工单里要填的
  标题 / 问题描述 / 分析过程 / 处理措施（含更新包提交路径），每项可一键复制。

应用常驻系统托盘，关闭窗口只是隐藏。

> 旧的 Python 命令行 / 托盘版留在本地 `legacy/` 目录（未纳入仓库），功能等价，可对照排查。

---

## 下载

不用自己编译，直接下打包好的 exe（[Releases](https://github.com/xun78243-sudo/vlinkto-help/releases/latest)）：

| 文件 | 大小 | 适用 |
| --- | --- | --- |
| [vlinkto-assistant-setup-1.1.0.exe](https://github.com/xun78243-sudo/vlinkto-help/releases/latest/download/vlinkto-assistant-setup-1.1.0.exe) | 106 MB | 安装版：按用户安装、免管理员，自动建桌面与开始菜单快捷方式 |
| [vlinkto-assistant-portable-1.1.0.exe](https://github.com/xun78243-sudo/vlinkto-help/releases/latest/download/vlinkto-assistant-portable-1.1.0.exe) | 106 MB | 便携版：单文件免安装，双击即用 |

使用前提：微联叮客户端已登录、机器能访问 `work.hanweb.com`；
缺陷单总结还要求能访问内网 `192.168.10.51`（AI 服务）和 `192.168.5.15`（GitLab）。

> 上面是 1.1.0（含缺陷单总结）的链接。若暂时 404，说明该版本还没发到 Release，
> 可直接用本地 `dist\` 下的安装包，或自己 `npm run dist` 打一个。

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
| 缺陷单总结 | 工单编号 + git 分支地址 → 标题 / 问题描述 / 分析过程 / 处理措施，四项各自一键复制 |

检测逻辑（与 Python 版一致）：

1. 拉取指定群（默认「人力资源部」所在的群）最近的聊天记录，自动翻页到今天零点；
2. 只处理**发送部门 = 人力资源部**、**发布时间 = 今天**、**文本类型**的消息；
3. 依次尝试解密：新版 SM4 传输加密（HKDF-SM3 派生密钥 + HMAC-SM3 校验）→ 旧版 SM2 → 明文；
4. 同时命中「考试/培训类关键词」+「全员受众（含 `@所有人`）」才触发，命中「取消/改期/作废」则跳过；
5. 以消息首行为日程标题，创建**当天 17:00–17:30** 的日程。

---

## 缺陷单总结助手

### 怎么用

1. 切到「缺陷单总结」页签；
2. 填 **工单编号**（如 `JETABLE2026101400071`）和 **git 地址（含分支）**，例如
   `http://192.168.5.15/jpaas/jagent/be/jagent-web/tree/release-4.3.5.17`；
3. 点「生成总结」，依次跑三步：**查工单 → 拉取提交 → AI 生成**（通常 15–40 秒，界面有进度点）；
4. 在四个文本框里核对、按需修改，逐个点「复制」贴进工单系统。

### 四个字段从哪来

| 字段 | 来源 |
| --- | --- |
| 标题 | 待办列表里的 `applyName`（详情接口的 `applyName` 是 null，只能用列表的） |
| 工单问题描述 | 详情 `prepareData.formData.model` 中 `fieldName = nrxq` 的 `fieldValueTwo` |
| 工单分析过程 | 内网大模型（默认 `Qwen3.6-27B`）结合「标题 + 描述 + 版本 + 本人在该分支的提交」生成 |
| 工单处理措施及更新包提交路径 | 模型写的**处理措施** + **程序拼接**的提交清单（分支、commit 地址、涉及文件） |

提交清单不让模型生成，避免编造 commit 或文件路径；模型只写分析与措施。

### 实现要点（都是实测踩出来的）

- 工单列表接口的 `pageNo` / `pageSize` **必须放 query**，放 body 会被忽略（永远返回第一页）；
  服务端默认页大小只有 10，本程序一次请求 100 条。
- `formData.model` 是一段 **JSON 字符串**，要二次 `JSON.parse` 才能拿到字段数组。
- `thirdAppUrl` 实测是**相对路径**（`/index.html#/tododetail?iid=…`），只按 `?iid=` 取值，绝对地址同样兼容。
- git 提交不走 GitLab REST API（那需要额外 token），而是 `git fetch --depth` 到缓存目录
  （`%APPDATA%\微联叮小助手\git-cache\<hash>`）后 `git log`。
- 认证有两种方式，**填了设置里的仓库账号密码就用 Basic 认证（优先）**，否则复用本机凭据
  （Windows 凭据管理器里记住的）；后一种要求这台机器上曾经 clone / pull 过该仓库。
  密码只存在本机 `config.json` 里，不进仓库、不写日志；拉取时通过 git 的
  **环境变量配置**（`GIT_CONFIG_COUNT`）传 `Authorization: Basic`，既不拼进 URL，
  也不会出现在进程命令行里；命令行只有一条不带密钥的 `-c credential.helper=`（禁用凭据助手防弹窗）。
- 提交人过滤：「git 账号」或「git 名称」命中作者名 / 邮箱即算本人（默认取本机 git 配置）。
- 分支不存在时会列出相近分支名；凭据缺失会明确提示先手动 clone 一次。

### 设置项（界面右上角「设置」，存 `config.json` 的 `defect` 段）

| 项 | 默认值 |
| --- | --- |
| git 账号 / 名称 | `xuning` / `徐宁` |
| 仓库访问账号 / 密码 | 留空 = 用本机 git 凭据；填了就按 HTTP Basic 认证拉取（只存本机 `config.json`） |
| 默认 git 地址 | `http://192.168.5.15/jpaas/jagent/be/jagent-web/tree/release-4.3.5.17` |
| AI 服务地址 | `http://192.168.10.51:31587/common-inference-server/interface/v1` |
| AI 模型 | `Qwen3.6-27B`（下拉列出内网模型的对话类部分） |
| 提交条数 | 参与分析最多 20 条，提交清单展示最多 10 条 |
| 工单扫描 | 最多 100 条待办 |

> AI 服务是内网 OpenAI 兼容接口（`/chat/completions`、`/models`），默认无需密钥；
> 若你的环境要求鉴权，在设置里填「AI 接口密钥」，会以 `Authorization: Bearer` 发送。

---

## 运行

### 方式一：装成正式应用（推荐给使用者）

双击 `dist\微联叮小助手-安装版-1.1.0.exe` 按向导装好，之后从桌面 / 开始菜单的
「微联叮小助手」启动；也可以直接用免安装的 `dist\微联叮小助手-便携版-1.1.0.exe`。
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
npm run check          # 离线：国密向量、规则、token、缺陷单纯函数（URL 解析 / AI JSON / 清单拼装）
npm run check:live     # 额外跑一次真实聊天接口（dry-run，不建日程）
npm run check:defect   # 缺陷单联网自检：查工单 + 拉 git 提交 + 真实调用一次模型
npm run smoke          # Electron 冒烟：页签、开关、定时器、刷新按钮、关窗隐藏到托盘
npm run smoke:defect   # Electron 端到端：界面点「生成总结」并读回四个字段
```

`npm run check:live` 的输出形如：

```
共 14 条 / 本部门 4 条 / 当天 1 条 / 命中 1 条 / 将建 1 条 / 解密失败 0 条
```

`npm run check:defect` 会打印工单定位结果、拉到的提交数与本人提交数，`--ai`（默认带上）还会
打印模型生成的分析与措施，便于判断模型输出质量。

两个 Electron 冒烟脚本都会输出一行 JSON（`SMOKE` / `SMOKE_DEFECT`），除内容外还包含布局几何量
（页签、输入框、结果块尺寸、是否横向溢出），可用于回归检查样式有没有被改坏。
加 `--capture=<路径>` 还会把窗口截图存成 PNG：

```powershell
node_modules\electron\dist\electron.exe . --smoke --smoke-defect --capture=%TEMP%\defect.png
```

---

## 打包成安装包

```powershell
npm run dist        # = electron-builder --win
```

产物在 `dist\`：

| 文件 | 说明 |
| --- | --- |
| `微联叮小助手-安装版-1.1.0.exe` | NSIS 安装包（约 106 MB）：可选安装目录、自动建桌面与开始菜单快捷方式、装完可直接启动 |
| `微联叮小助手-便携版-1.1.0.exe` | 单文件免安装版，双击即用（每次启动自解压到临时目录） |
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
> 若打包时报 `read ECONNRESET` / `ETIMEDOUT`（electron-builder 打包时会联网校验 electron 包），
> 改用 `npm run dist:local` —— 它直接复用本机 `node_modules\electron\dist`，完全不联网，
> 产物一样。
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
  defect/
    ticket.js          待办列表定位工单（多页查找）+ 详情 formData.model 解析
    git.js             git 地址解析、浅拉取提交、按提交人过滤、更新包清单拼装
    ai.js              内网 OpenAI 兼容接口调用、提示词、JSON 容错解析
    index.js           三步编排 + 四段内容组装
  renderer/            界面（index.html / styles.css / defect.css / renderer.js）
assets/
  icon.png / icon.ico  应用图标（ico 为多尺寸，打包用）
  tray.png / tray@2x.png  托盘图标
scripts/
  check-core.js        核心自检（含缺陷单纯函数用例）
  check-defect.js      缺陷单联网自检（查工单 / 拉提交 / 调模型）
  make-icons.js        生成 PNG/ICO 图标（无第三方依赖）
dist/                  打包产物（安装包、便携版、win-unpacked）
legacy/                旧 Python 实现（等价参考，未纳入仓库）
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

**7. 缺陷单总结报「本机没有该仓库的访问凭据」**

两种解决办法，任选其一：

- 到「设置」里填 **仓库访问账号 / 密码**（推荐，换机器只改配置即可）；
- 或先在这台机器上对仓库执行一次
  `git clone http://192.168.5.15/jpaas/jagent/be/jagent-web.git` 并输入账号密码，
  凭据会被 Windows 凭据管理器记住，之后程序直接复用。

**8. 缺陷单总结提示「没有匹配的提交记录」**

说明该分支最近 200 条提交里没有作者名/邮箱匹配「git 账号 + 名称」的记录。
到「设置」里把 git 账号改成你的 GitLab 用户名（如 `xuning`），名称填中文名（如 `徐宁`），
两者任意一个命中即可。注意作者名是提交时 `user.name` 的值，可能是中文名也可能是拼音。

**9. 缺陷单总结卡在「AI 生成」很久 / 报超时**

模型生成通常 15–40 秒（20 条提交、两千多字的输入）。超过 120 秒会报超时，
可在设置里换更快的模型（如 `flash`）再试；日志里会记录实际耗时。
