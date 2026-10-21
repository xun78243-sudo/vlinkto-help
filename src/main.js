'use strict'
/**
 * 微联叮小助手 —— Electron 主进程。
 * 负责：窗口、系统托盘、token 自动获取、考试日程小助理的开关与定时（每 3 小时）。
 */

const path = require('path')
const fs = require('fs')

const {
  app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, Notification, dialog, clipboard,
} = require('electron')

const store = require('./config')
const { findToken } = require('./token')
const chat = require('./exam/chat')
const { AuthError } = require('./exam/api')
const defect = require('./defect')
const defectAi = require('./defect/ai')

const APP_NAME = '微联叮小助手'
const ASSETS = path.join(__dirname, '..', 'assets')
const LEGACY_STATE = path.join(__dirname, '..', 'legacy', 'state.json')

let mainWindow = null
let tray = null
let isQuitting = false
let userDir = ''

const MAX_LOGS = 400
const logs = []

const state = {
  token: null,
  exam: {
    enabled: false,
    running: false,
    lastRunAt: null,
    lastResult: null,
    nextRunAt: null,
    timer: null,
  },
  defect: {
    running: false,
    lastStage: null,
    lastResult: null,
  },
}

// ============================================================================
// 日志
// ============================================================================

function pad2(value) {
  return String(value).padStart(2, '0')
}

function stampOf(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
    + `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

function logFile() {
  const dir = store.logDir(userDir)
  fs.mkdirSync(dir, { recursive: true })
  const now = new Date()
  return path.join(dir, `exam_${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}.log`)
}

function log(level, message) {
  const entry = { time: stampOf(), level, message: String(message) }
  logs.push(entry)
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS)
  try {
    fs.appendFileSync(logFile(), `${entry.time} ${String(level).toUpperCase().padEnd(5)} ${entry.message}\n`, 'utf8')
  } catch (error) {
    /* 写日志失败不影响主流程 */
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log:append', entry)
  }
}

// ============================================================================
// 状态广播
// ============================================================================

function tokenView() {
  if (!state.token) return null
  return {
    ok: Boolean(state.token.ok),
    username: state.token.username || '',
    source: state.token.source || '',
    expiresAt: state.token.expiresAt ? state.token.expiresAt.toISOString() : null,
    expiresText: state.token.expiresAt ? stampOf(state.token.expiresAt) : '',
    remainingHours: state.token.remainingHours ?? null,
    fetchedAt: state.token.fetchedAt || null,
    error: state.token.error || '',
  }
}

function examView() {
  return {
    enabled: state.exam.enabled,
    running: state.exam.running,
    lastRunAt: state.exam.lastRunAt,
    lastResult: state.exam.lastResult,
    nextRunAt: state.exam.nextRunAt,
    intervalHours: Number(store.loadConfig(userDir).exam.intervalHours) || 3,
  }
}

function appView() {
  let cfg
  try {
    cfg = store.loadConfig(userDir)
  } catch (error) {
    cfg = store.DEFAULTS
  }
  return {
    version: app.getVersion(),
    appName: APP_NAME,
    userDir,
    logDir: store.logDir(userDir),
    configPath: store.configPath(userDir),
    closeToTray: cfg.app.closeToTray !== false,
    autoLaunch: app.getLoginItemSettings().openAtLogin,
    dryRun: Boolean(cfg.app.dryRun),
    groupId: cfg.chat.groupId,
    departments: cfg.chat.senderGroupNames,
    scheduleTime: `${cfg.schedule.startTime}-${cfg.schedule.endTime}`,
  }
}

function defectConfig() {
  try {
    return store.loadConfig(userDir).defect || store.DEFAULTS.defect
  } catch (error) {
    return store.DEFAULTS.defect
  }
}

function defectView() {
  const cfg = defectConfig()
  return {
    running: Boolean(state.defect.running),
    gitUser: cfg.gitUser || '',
    gitName: cfg.gitName || '',
    defaultGitUrl: cfg.defaultGitUrl || '',
    gitAuthUser: cfg.gitAuthUser || '',
    hasGitPassword: Boolean(cfg.gitAuthPassword),
    aiModel: cfg.aiModel || '',
    aiBaseUrl: cfg.aiBaseUrl || '',
    hasApiKey: Boolean(cfg.aiApiKey),
    commitLimit: Number(cfg.commitLimit) || 20,
    maxTickets: Number(cfg.maxTickets) || 100,
  }
}

function sendDefectStage(stage, stageState, detail) {
  state.defect.lastStage = { stage, state: stageState, at: Date.now() }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('defect:stage', {
      stage, state: stageState, detail: detail || null,
    })
  }
}

function snapshot() {
  return {
    token: tokenView(), exam: examView(), app: appView(), defect: defectView(),
  }
}

function broadcast() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state:update', snapshot())
  }
  updateTray()
}

// ============================================================================
// token
// ============================================================================

async function refreshToken(reason = 'manual') {
  let info
  try {
    info = findToken()
  } catch (error) {
    info = { ok: false, error: error.message }
  }

  if (info.ok) {
    state.token = { ...info, fetchedAt: Date.now() }
    log('info', `已获取 access-token（${info.username || '未知用户'} · ${info.source}，`
      + `${info.remainingHours.toFixed(1)} 小时后到期）`)
  } else if (state.token && state.token.ok && state.token.expiresAt > new Date()) {
    log('warn', `自动获取 token 失败（${info.error}），继续使用 ${stampOf(state.token.expiresAt)} 到期的旧 token`)
  } else {
    state.token = { ...(state.token || {}), ...info, fetchedAt: Date.now() }
    state.token.ok = false
    log('error', `获取 access-token 失败：${info.error}`)
  }

  if (reason === 'manual') broadcast()
  return state.token
}

// ============================================================================
// 考试日程小助理
// ============================================================================

function intervalMs() {
  const hours = Number(store.loadConfig(userDir).exam.intervalHours) || 3
  return Math.max(1, hours) * 3600 * 1000
}

async function runExam(trigger = 'manual') {
  if (state.exam.running) {
    log('warn', '上一轮还在执行，本次跳过')
    return { skipped: true }
  }

  state.exam.running = true
  broadcast()
  log('info', `—— 开始检测（${trigger === 'auto' ? '定时' : trigger === 'enable' ? '开启开关' : '手动'}）——`)

  const startedAt = Date.now()
  let result
  try {
    const token = await refreshToken('run')
    if (!token || !token.ok) throw new Error(token && token.error ? token.error : '没有可用的 access-token')

    const cfg = store.loadConfig(userDir)
    const cfgState = store.loadState(userDir)
    const stats = await chat.runOnce(cfg, token.token, cfgState, {
      log,
      dryRun: Boolean(cfg.app.dryRun),
      onCreated: async (nextState) => store.saveState(userDir, nextState),
    })

    result = { ok: stats.failed === 0, stats, durationMs: Date.now() - startedAt }
    log('info', `汇总：共 ${stats.total} 条 / 本部门 ${stats.dept} 条 / 当天 ${stats.today} 条 / `
      + `命中 ${stats.qualified} 条 / 建日程 ${stats.created} 条 / 跳过 ${stats.skipped} 条 / `
      + `解密失败 ${stats.undecrypted} 条 / 建失败 ${stats.failed} 条`)
    if (stats.created > 0) {
      notify('已创建考试日程', stats.names.slice(0, 3).join('\n'))
    }
  } catch (error) {
    const message = error instanceof AuthError
      ? 'access-token 已失效，请点击「重新获取 Token」'
      : error.message
    log('error', `检测失败：${message}`)
    result = { ok: false, error: message, durationMs: Date.now() - startedAt }
    if (error instanceof AuthError) notify('token 需要更新', '请点击「重新获取 Token」再试')
  } finally {
    state.exam.running = false
    state.exam.lastRunAt = Date.now()
    state.exam.lastResult = result
    if (state.exam.enabled) state.exam.nextRunAt = Date.now() + intervalMs()
    broadcast()
  }
  return result
}

function startAuto() {
  stopAuto()
  state.exam.enabled = true
  const ms = intervalMs()
  state.exam.timer = setInterval(() => {
    runExam('auto')
  }, ms)
  state.exam.nextRunAt = Date.now() + ms
  persistExamSetting(true)
  log('info', `考试日程小助理已开启，每 ${Math.round(ms / 3600000)} 小时执行一次`)
  runExam('enable')
  broadcast()
}

function stopAuto() {
  if (state.exam.timer) {
    clearInterval(state.exam.timer)
    state.exam.timer = null
  }
  state.exam.enabled = false
  state.exam.nextRunAt = null
  persistExamSetting(false)
  log('info', '考试日程小助理已关闭')
  broadcast()
}

function persistExamSetting(enabled) {
  try {
    const cfg = store.loadConfig(userDir)
    cfg.exam.enabled = enabled
    store.saveConfig(userDir, cfg)
  } catch (error) {
    log('warn', `保存开关状态失败：${error.message}`)
  }
}

function notify(title, body) {
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body, silent: false }).show()
    }
  } catch (error) {
    /* 通知失败无所谓 */
  }
}

// ============================================================================
// 窗口与托盘
// ============================================================================

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 840,
    minHeight: 620,
    title: APP_NAME,
    backgroundColor: '#f4f6f9',
    icon: path.join(ASSETS, 'icon.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  mainWindow.once('ready-to-show', () => mainWindow.show())

  mainWindow.on('close', (event) => {
    const closeToTray = (() => {
      try {
        return store.loadConfig(userDir).app.closeToTray !== false
      } catch (error) {
        return true
      }
    })()
    if (!isQuitting && closeToTray) {
      event.preventDefault()
      mainWindow.hide()
      log('info', '窗口已隐藏到系统托盘（托盘图标右键可退出）')
    }
  })

  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' })
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function trayTooltip() {
  const parts = [APP_NAME]
  if (state.exam.running) parts.push('正在检测…')
  else if (state.exam.enabled) parts.push('自动检测已开启')
  else parts.push('自动检测已关闭')
  const token = tokenView()
  if (token && token.ok) parts.push(`token 剩 ${Math.max(0, Math.round(token.remainingHours || 0))} 小时`)
  else if (token) parts.push('token 需更新')
  return parts.join(' · ')
}

function updateTray() {
  if (!tray) return
  try {
    tray.setToolTip(trayTooltip())
    const enabled = state.exam.enabled
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主窗口', click: showWindow },
      { type: 'separator' },
      {
        label: '考试日程小助理',
        type: 'checkbox',
        checked: enabled,
        click: (item) => {
          if (item.checked) startAuto()
          else stopAuto()
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('state:update', snapshot())
        },
      },
      { label: '立即执行一次', click: () => runExam('manual'), enabled: !state.exam.running },
      { type: 'separator' },
      { label: '重新获取 Token', click: () => refreshToken('manual') },
      { label: '打开日志目录', click: () => shell.openPath(store.logDir(userDir)) },
      { label: '打开配置文件', click: () => shell.openPath(store.configPath(userDir)) },
      { type: 'separator' },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => setAutoLaunch(item.checked),
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true
          app.quit()
        },
      },
    ]))
  } catch (error) {
    /* 托盘更新失败忽略 */
  }
}

function createTray() {
  const iconPath = path.join(ASSETS, 'tray.png')
  let image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) image = nativeImage.createEmpty()
  tray = new Tray(image)
  tray.on('click', showWindow)
  tray.on('double-click', showWindow)
  updateTray()
}

function setAutoLaunch(enabled) {
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, args: [] })
    const cfg = store.loadConfig(userDir)
    cfg.app.autoLaunch = enabled
    store.saveConfig(userDir, cfg)
    log('info', `${enabled ? '已开启' : '已关闭'}开机自启`)
  } catch (error) {
    log('warn', `设置开机自启失败：${error.message}`)
  }
  broadcast()
}

// ============================================================================
// IPC
// ============================================================================

function registerIpc() {
  ipcMain.handle('app:snapshot', () => snapshot())
  ipcMain.handle('app:logs', () => logs)

  ipcMain.handle('token:refresh', async () => {
    log('info', '用户点击「重新获取 Token」')
    await refreshToken('manual')
    return snapshot()
  })

  ipcMain.handle('exam:toggle', async (event, enabled) => {
    if (enabled) startAuto()
    else stopAuto()
    return snapshot()
  })

  ipcMain.handle('exam:runNow', async () => {
    await runExam('manual')
    return snapshot()
  })

  ipcMain.handle('app:setDryRun', async (event, value) => {
    const cfg = store.loadConfig(userDir)
    cfg.app.dryRun = Boolean(value)
    store.saveConfig(userDir, cfg)
    log('info', `试运行模式：${value ? '已开启（只判定不建日程）' : '已关闭'}`)
    return snapshot()
  })

  ipcMain.handle('app:setCloseToTray', async (event, value) => {
    const cfg = store.loadConfig(userDir)
    cfg.app.closeToTray = Boolean(value)
    store.saveConfig(userDir, cfg)
    return snapshot()
  })

  ipcMain.handle('app:openLogs', async () => shell.openPath(store.logDir(userDir)))
  ipcMain.handle('app:openConfig', async () => shell.openPath(store.configPath(userDir)))
  ipcMain.handle('app:copy', async (event, text) => {
    clipboard.writeText(String(text == null ? '' : text))
    return true
  })

  // ---------------- 缺陷单总结助手 ----------------

  ipcMain.handle('defect:models', async () => defectAi.listModels(defectConfig()))

  ipcMain.handle('defect:saveSettings', async (event, patch) => {
    const cfg = store.loadConfig(userDir)
    const target = cfg.defect
    const source = patch && typeof patch === 'object' ? patch : {}
    for (const key of ['gitUser', 'gitName', 'defaultGitUrl', 'gitAuthUser', 'gitAuthPassword',
      'aiModel', 'aiBaseUrl', 'aiApiKey']) {
      if (typeof source[key] === 'string') {
        target[key] = key === 'gitAuthPassword' || key === 'aiApiKey'
          ? source[key]
          : source[key].trim()
      }
    }
    store.saveConfig(userDir, cfg)
    log('info', `缺陷单设置已保存：git 账号=${target.gitUser || '（空）'}`
      + `，仓库访问账号=${target.gitAuthUser || '（用本机凭据）'}，模型=${target.aiModel || '（空）'}`)
    return snapshot()
  })

  ipcMain.handle('defect:generate', async (event, payload) => {
    const input = payload && typeof payload === 'object' ? payload : {}
    const cfg = defectConfig()

    let info = state.token
    if (!info || !info.ok) info = findToken()
    if (!info || !info.ok) {
      throw new Error('未能获取 access-token，请先点「重新获取 Token」再试')
    }

    if (state.defect.running) throw new Error('正在生成中，请稍候')

    state.defect.running = true
    broadcast()
    log('info', `缺陷单总结开始：${input.transactNo || '（无单号）'}`)
    try {
      const result = await defect.generate({
        cfg,
        token: info.token,
        transactNo: String(input.transactNo || '').trim(),
        gitUrl: String(input.gitUrl || '').trim(),
        cacheRoot: path.join(userDir, 'git-cache'),
        log,
        onStage: (stage, stageState, detail) => sendDefectStage(stage, stageState, detail),
      })
      state.defect.lastResult = result
      if (result.errors && result.errors.length) {
        const first = result.errors[0]
        log('warn', `缺陷单总结部分完成：${first.message}`)
      }
      return result
    } finally {
      state.defect.running = false
      broadcast()
    }
  })

  ipcMain.handle('app:hide', async () => {
    if (mainWindow) mainWindow.hide()
  })
  ipcMain.handle('app:quit', async () => {
    isQuitting = true
    app.quit()
  })
}

/**
 * 缺陷单总结的界面端到端自检（--smoke-defect）：
 * 切页签 → 填单号与 git 地址 → 点生成 → 等待完成 → 读回四个字段。
 */
async function runDefectSmoke() {
  const cfg = defectConfig()
  const ticketNo = process.argv.find((item) => /^JETABLE\d+$/i.test(item)) || 'JETABLE2026101400071'
  const gitUrl = process.argv.find((item) => /^https?:\/\//i.test(item)) || cfg.defaultGitUrl

  await mainWindow.webContents.executeJavaScript(`(() => {
    document.querySelector('.menu-item[data-pane="defect"]').click()
    document.getElementById('defect-ticket').value = ${JSON.stringify(ticketNo)}
    document.getElementById('defect-giturl').value = ${JSON.stringify(gitUrl)}
    document.getElementById('btn-defect-generate').click()
    return true
  })()`)

  const deadline = Date.now() + 180000
  let busy = true
  while (busy && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000))
    busy = await mainWindow.webContents.executeJavaScript(
      "Boolean(document.getElementById('btn-defect-generate').disabled)")
  }

  const result = await mainWindow.webContents.executeJavaScript(`(() => ({
    paneVisible: document.getElementById('pane-defect').hidden === false,
    busy: Boolean(document.getElementById('btn-defect-generate').disabled),
    title: document.getElementById('out-title').value,
    description: (document.getElementById('out-description').value || '').slice(0, 60),
    analysisLength: (document.getElementById('out-analysis').value || '').length,
    measuresLength: (document.getElementById('out-measures').value || '').length,
    copyButtons: document.querySelectorAll('#defect-result .copy').length,
    errorShown: !document.getElementById('defect-error').hidden,
    errorText: document.getElementById('defect-error').innerText.slice(0, 200),
    meta: document.getElementById('defect-meta').textContent,
    stages: Array.from(document.querySelectorAll('.stage')).map((node) => node.className),
    layout: (() => {
      const rect = (selector) => {
        const node = document.querySelector(selector)
        if (!node) return null
        const box = node.getBoundingClientRect()
        return { w: Math.round(box.width), h: Math.round(box.height) }
      }
      const textareas = Array.from(document.querySelectorAll('#defect-result textarea'))
        .map((node) => Math.round(node.getBoundingClientRect().height))
      const visibleCopies = Array.from(document.querySelectorAll('#defect-result .copy'))
        .filter((node) => node.getBoundingClientRect().width > 0).length
      const ticket = document.getElementById('defect-ticket').getBoundingClientRect()
      const gitBox = document.getElementById('defect-giturl').getBoundingClientRect()
      const sidebar = document.querySelector('.sidebar')
      return {
        sidebarWidth: sidebar ? Math.round(sidebar.getBoundingClientRect().width) : 0,
        menu: rect('.menu'),
        generateButton: rect('#btn-defect-generate'),
        ticketInput: rect('#defect-ticket'),
        gitInput: rect('#defect-giturl'),
        inputsStacked: gitBox.top >= ticket.bottom - 1,
        inputsSameLeft: Math.abs(gitBox.left - ticket.left) < 2,
        resultBlock: rect('#defect-result'),
        textareas,
        visibleCopies,
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      }
    })(),
  }))()`)
  result.ticketNo = ticketNo
  result.gitUrl = gitUrl
  return result
}

// ============================================================================
// 启动
// ============================================================================

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())

  app.whenReady().then(async () => {
    userDir = app.getPath('userData')
    fs.mkdirSync(userDir, { recursive: true })
    // Windows 通知需要 AppUserModelId，否则气泡可能不显示
    app.setAppUserModelId('com.hanweb.vlinkto.assistant')

    // 首次运行：把旧 Python 版的 state.json 合并进来，避免重复建日程
    try {
      const migrated = store.migrateLegacyState(userDir, LEGACY_STATE)
      if (migrated > 0) log('info', `已从旧版本迁移 ${migrated} 条已处理记录`)
    } catch (error) {
      log('warn', `迁移旧 state 失败：${error.message}`)
    }

    log('info', '='.repeat(56))
    log('info', `${APP_NAME} v${app.getVersion()} 启动`)
    log('info', `数据目录：${userDir}`)

    registerIpc()
    createWindow()
    createTray()

    // 冒烟自检：渲染完成后把关键 DOM 打出来，然后退出（用于自动化验证，不影响日常使用）
    if (process.argv.includes('--smoke')) {
      const withRun = process.argv.includes('--smoke-run')
      const withDefect = process.argv.includes('--smoke-defect')
      const probe = `(() => ({
        title: document.title,
        version: (document.getElementById('version') || {}).textContent,
        examState: (document.getElementById('exam-state') || {}).textContent,
        tokenText: (document.getElementById('token-body') || {}).innerText,
        logLines: document.querySelectorAll('.log-line').length,
        switchChecked: Boolean(document.getElementById('exam-switch') && document.getElementById('exam-switch').checked),
        lastResult: (document.getElementById('exam-result') || {}).textContent,
        nextRun: (document.getElementById('exam-next') || {}).textContent,
        menuItems: document.querySelectorAll('.menu-item').length,
        sidebar: (() => {
          const node = document.querySelector('.sidebar')
          return node ? Math.round(node.getBoundingClientRect().width) : 0
        })(),
        formValues: ['defect-ticket', 'defect-giturl']
          .map((id) => (document.getElementById(id) || {}).value || ''),
        defectPaneHidden: Boolean(document.getElementById('pane-defect') && document.getElementById('pane-defect').hidden),
        defectInputs: document.querySelectorAll('#pane-defect input').length,
        defectCopyButtons: document.querySelectorAll('#defect-result .copy').length,
      }))()`

      mainWindow.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          try {
            const info = await mainWindow.webContents.executeJavaScript(probe)
            info.trayAlive = Boolean(tray && !tray.isDestroyed())
            console.log(`SMOKE ${JSON.stringify(info)}`)

            if (withDefect) {
              console.log(`SMOKE_DEFECT ${JSON.stringify(await runDefectSmoke())}`)
            }

            const capture = process.argv.find((item) => item.startsWith('--capture='))
            if (capture) {
              const file = capture.slice('--capture='.length)
              const image = await mainWindow.webContents.capturePage()
              fs.writeFileSync(file, image.toPNG())
              console.log(`CAPTURE ${file}`)
            }

            if (withRun) {
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('exam-switch').click()")
              await new Promise((resolve) => setTimeout(resolve, 9000))
              const after = await mainWindow.webContents.executeJavaScript(probe)
              after.timerAlive = Boolean(state.exam.timer)
              after.nextRunAt = state.exam.nextRunAt

              // 刷新 token 按钮
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('btn-refresh').click()")
              await new Promise((resolve) => setTimeout(resolve, 2500))
              const refreshed = await mainWindow.webContents.executeJavaScript(probe)
              after.refreshOk = refreshed.tokenText.includes('已获取')
              after.logLinesAfterRefresh = refreshed.logLines

              // 关窗隐藏到托盘
              mainWindow.close()
              await new Promise((resolve) => setTimeout(resolve, 1200))
              after.windowVisible = mainWindow.isVisible()
              after.windowAlive = !mainWindow.isDestroyed()
              after.trayAliveAfterClose = Boolean(tray && !tray.isDestroyed())

              console.log(`SMOKE_RUN ${JSON.stringify(after)}`)
            }
          } catch (error) {
            console.log(`SMOKE_ERROR ${error.message}`)
          }
          isQuitting = true
          app.quit()
        }, 3500)
      })
    }

    // 启动即自动获取当前 token
    await refreshToken('startup')

    const cfg = store.loadConfig(userDir)
    app.setLoginItemSettings({ openAtLogin: Boolean(cfg.app.autoLaunch), args: [] })

    if (cfg.exam.enabled) {
      log('info', '上次退出时开关处于开启状态，自动恢复定时任务')
      startAuto()
    } else {
      broadcast()
    }
  })

  app.on('window-all-closed', () => {
    // 关闭窗口不退出：应用常驻托盘
  })

  app.on('before-quit', () => {
    isQuitting = true
    if (state.exam.timer) clearInterval(state.exam.timer)
  })

  app.on('activate', () => showWindow())
}

process.on('uncaughtException', (error) => {
  try {
    log('error', `未捕获异常：${error && error.stack ? error.stack : error}`)
  } catch (innerError) {
    /* 忽略 */
  }
})

process.on('unhandledRejection', (reason) => {
  try {
    log('error', `未处理的 Promise 拒绝：${reason}`)
  } catch (error) {
    /* 忽略 */
  }
})
