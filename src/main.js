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
const defectInfo = require('./defect/info')
const reminder = require('./reminder')
const { createCloudController } = require('./cloud')

const APP_NAME = '微联叮小助手'
const ASSETS = path.join(__dirname, '..', 'assets')
const LEGACY_STATE = path.join(__dirname, '..', 'legacy', 'state.json')
// 云手机依赖的 adb / scrcpy-server 随安装包一起发布（assets/cloud）。
// 打包后它们被 asarUnpack 到 app.asar.unpacked；adb.exe 不能从 asar 内直接执行，
// 内置 adb 也读不到 asar 里的 scrcpy-server，所以要用解包后的真实路径。
const CLOUD_RUNTIME = app.isPackaged
  ? path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'cloud')
  : path.join(ASSETS, 'cloud')

let mainWindow = null
let tray = null
let isQuitting = false
let userDir = ''
let cloud = null

const MAX_LOGS = 400
const SMOKE_MODE = process.argv.includes('--smoke')
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
    lastMeta: null,
    lastFingerprint: '',
  },
  reminder: {
    enabled: false,
    running: false,
    timer: null,
    lastRunAt: null,
    nextRunAt: null,
    lastResult: null,
    lastError: '',
    items: [],
    refreshedAt: null,
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
    infoAutoSubmit: cfg.infoAutoSubmit !== false,
  }
}

function reminderConfig() {
  try {
    return store.loadConfig(userDir).reminder || store.DEFAULTS.reminder
  } catch (error) {
    return store.DEFAULTS.reminder
  }
}

function reminderIntervalMs() {
  const minutes = Number(reminderConfig().intervalMinutes) || 30
  return Math.max(1, minutes) * 60000
}

/** 已经发过的提醒（存在 state.json 的 reminders 里），顺手清掉 7 天前的。 */
function loadSentMap() {
  let saved = {}
  try {
    saved = store.loadState(userDir)
  } catch (error) {
    saved = {}
  }
  const source = saved && saved.reminders && typeof saved.reminders === 'object' ? saved.reminders : {}
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000
  const fresh = {}
  for (const [key, at] of Object.entries(source)) {
    if (Number(at) >= cutoff) fresh[key] = Number(at)
  }
  return fresh
}

function saveSentMap(sent) {
  try {
    const saved = store.loadState(userDir)
    saved.reminders = sent && typeof sent === 'object' ? sent : {}
    store.saveState(userDir, saved)
  } catch (error) {
    log('warn', `保存提醒记录失败：${error.message}`)
  }
}

function reminderView() {
  const cfg = reminderConfig()
  const sent = loadSentMap()
  const items = state.reminder.items.map((item) => {
    const sentAt = item.key && sent[item.key] ? sent[item.key] : 0
    let status = 'other'
    if (sentAt) status = 'sent'
    else if (item.isToday && item.window) status = 'waiting'
    return {
      ticketNo: item.ticketNo,
      title: item.title,
      deadlineText: item.deadlineText,
      isToday: Boolean(item.isToday),
      window: item.window || '',
      notifyAt: item.notifyAt || 0,
      deadlineAt: item.deadlineAt || 0,
      sentAt,
      status,
      url: item.url || '',
    }
  })

  return {
    enabled: Boolean(state.reminder.enabled),
    running: Boolean(state.reminder.running),
    lastRunAt: state.reminder.lastRunAt,
    nextRunAt: state.reminder.nextRunAt,
    refreshedAt: state.reminder.refreshedAt,
    lastError: state.reminder.lastError || '',
    lastResult: state.reminder.lastResult,
    intervalMinutes: Number(cfg.intervalMinutes) || 30,
    advanceMinutes: Number(cfg.advanceMinutes) || 30,
    eveningText: `${String(Number(cfg.eveningHour) || 18).padStart(2, '0')}:00`,
    eveningNotifyText: String(cfg.eveningNotifyTime || '17:30'),
    typeId: String(cfg.typeId || ''),
    total: items.length,
    today: items.filter((item) => item.isToday).length,
    waiting: items.filter((item) => item.status === 'waiting').length,
    sent: items.filter((item) => item.status === 'sent').length,
    items,
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
    reminder: reminderView(),
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
// 工单到期提醒
// ============================================================================

/** token 还能用就复用，只剩不到 2 小时才重新取，免得每 30 分钟刷一次日志。 */
async function ensureToken() {
  if (state.token && state.token.ok && state.token.expiresAt
    && state.token.expiresAt.getTime() - Date.now() > 2 * 3600 * 1000) {
    return state.token
  }
  return refreshToken('run')
}

async function runReminder(trigger = 'manual', options = {}) {
  if (state.reminder.running) {
    log('warn', '上一轮到期检查还在执行，本次跳过')
    return { skipped: true }
  }

  const notifyEnabled = options.notify !== false
  const label = trigger === 'auto' ? '定时' : trigger === 'enable' ? '开启开关' : '手动'
  state.reminder.running = true
  broadcast()
  log('info', `—— 检查工单到期（${label}）——`)

  const startedAt = Date.now()
  let result
  try {
    const token = await ensureToken()
    if (!token || !token.ok) {
      throw new Error(token && token.error ? token.error : '没有可用的 access-token')
    }

    const cfg = reminderConfig()
    const now = new Date()
    const fetched = await reminder.fetchPending(cfg, token.token, { log })
    const items = fetched.items.map((item) => reminder.describeItem(item, now, cfg))
    state.reminder.items = items
    state.reminder.refreshedAt = Date.now()
    state.reminder.lastError = ''

    const sent = loadSentMap()
    const due = reminder.dueNotifications(fetched.items, now, cfg, sent)
    const messages = reminder.buildNotifications(due)

    let notified = 0
    for (const message of messages) {
      const flat = String(message.body || '').replace(/\n/g, ' ／ ')
      if (notifyEnabled) {
        notify(message.title, message.body)
        notified += 1
        log('info', `已发送到期提醒：${message.title}（${flat}）`)
      } else {
        log('info', `冒烟模式只记日志，不弹窗：${message.title}（${flat}）`)
      }
    }
    if (messages.length) {
      const at = Date.now()
      for (const key of messages.flatMap((item) => item.keys)) sent[key] = at
      saveSentMap(sent)
    }

    const today = items.filter((item) => item.isToday)
    const evening = today.filter((item) => item.window === 'evening')
    log('info', `到期汇总：待办 ${items.length} 条 / 今天到期 ${today.length} 条`
      + `（18:00 前 ${today.length - evening.length} 条、18:00 后 ${evening.length} 条）`
      + ` / 本轮提醒 ${messages.length} 条 / 翻页 ${fetched.pages} 次`)

    result = {
      ok: true,
      trigger,
      total: items.length,
      today: today.length,
      due: messages.length,
      notified,
      pages: fetched.pages,
      durationMs: Date.now() - startedAt,
    }
  } catch (error) {
    const message = error instanceof AuthError
      ? 'access-token 已失效，请点击「重新获取 Token」'
      : error.message
    log('error', `到期检查失败：${message}`)
    state.reminder.lastError = message
    result = { ok: false, error: message, trigger, durationMs: Date.now() - startedAt }
  } finally {
    state.reminder.running = false
    state.reminder.lastRunAt = Date.now()
    state.reminder.lastResult = result
    if (state.reminder.enabled) state.reminder.nextRunAt = Date.now() + reminderIntervalMs()
    broadcast()
  }

  return result
}

function startReminder(options = {}) {
  if (state.reminder.timer) {
    clearInterval(state.reminder.timer)
    state.reminder.timer = null
  }
  state.reminder.enabled = true
  const ms = reminderIntervalMs()
  const cfg = reminderConfig()
  state.reminder.timer = setInterval(() => {
    runReminder('auto')
  }, ms)
  state.reminder.nextRunAt = Date.now() + ms
  persistReminderSetting(true)
  log('info', `工单到期提醒已开启：每 ${Math.round(ms / 60000)} 分钟检查一次`
    + `；今天 ${Number(cfg.eveningHour) || 18}:00 前到期的提前 `
    + `${Number(cfg.advanceMinutes) || 30} 分钟提醒，${Number(cfg.eveningHour) || 18}:00 后到期的统一 `
    + `${cfg.eveningNotifyTime || '17:30'} 提醒`)
  if (options.runNow !== false) runReminder('enable', options)
  broadcast()
}

function stopReminder(options = {}) {
  const wasEnabled = state.reminder.enabled
  if (state.reminder.timer) {
    clearInterval(state.reminder.timer)
    state.reminder.timer = null
  }
  state.reminder.enabled = false
  state.reminder.nextRunAt = null
  if (wasEnabled) persistReminderSetting(false)
  if (!options.silent) log('info', '工单到期提醒已关闭')
  if (!options.silent) broadcast()
}

function persistReminderSetting(enabled) {
  try {
    const cfg = store.loadConfig(userDir)
    cfg.reminder.enabled = enabled
    store.saveConfig(userDir, cfg)
  } catch (error) {
    log('warn', `保存到期提醒开关失败：${error.message}`)
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
      {
        label: `工单到期提醒（每 ${Math.round(reminderIntervalMs() / 60000)} 分钟）`,
        type: 'checkbox',
        checked: Boolean(state.reminder.enabled),
        click: (item) => {
          if (item.checked) startReminder()
          else stopReminder()
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('state:update', snapshot())
        },
      },
      {
        label: '立即检查到期工单',
        click: () => runReminder('manual'),
        enabled: !state.reminder.running,
      },
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

  ipcMain.handle('reminder:toggle', async (event, enabled) => {
    if (enabled) startReminder()
    else stopReminder()
    return snapshot()
  })

  ipcMain.handle('reminder:runNow', async () => {
    await runReminder('manual')
    return snapshot()
  })

  ipcMain.handle('reminder:test', async () => {
    const now = new Date()
    notify('工单还有不到 30 分钟到期：示例工单（测试通知，可忽略）',
      '办件名：示例工单_演示用（测试）\n'
      + `截止时间：${now.getMonth() + 1}月${now.getDate()}日 `
      + `${pad2(now.getHours())}:${pad2(now.getMinutes())} 截止`)
    log('info', '已发送一条到期提醒测试通知')
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
  ipcMain.handle('app:openUrl', async (event, url) => {
    const target = String(url || '').trim()
    if (!/^https?:\/\//i.test(target)) return false
    await shell.openExternal(target)
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
    if (typeof source.infoAutoSubmit === 'boolean') target.infoAutoSubmit = source.infoAutoSubmit
    store.saveConfig(userDir, cfg)
    log('info', `缺陷单设置已保存：git 账号=${target.gitUser || '（空）'}`
      + `，仓库访问账号=${target.gitAuthUser || '（用本机凭据）'}，模型=${target.aiModel || '（空）'}`
      + `，自动提交信息数据=${target.infoAutoSubmit === false ? '关' : '开'}`)
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
        drySubmit: SMOKE_MODE || Boolean(input.drySubmit),
        lastFingerprint: state.defect.lastFingerprint,
        log,
        onStage: (stage, stageState, detail) => sendDefectStage(stage, stageState, detail),
      })
      state.defect.lastResult = result
      state.defect.lastMeta = {
        ticketNo: result.meta.ticketNo,
        iid: result.meta.iid,
        title: result.meta.title,
        gitUrl: result.meta.gitUrl,
      }
      if (result.info && result.info.ok && !result.info.skipped) {
        // 只有真的建了一条，才把这版内容记为「已提交」，避免下一轮重复建
        state.defect.lastFingerprint = result.meta.fingerprint || ''
      }
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

  /** 列表里还没刷出地址时，用上一次创建留下的 iid 再查一次 fullUrl。 */
  ipcMain.handle('defect:url', async () => {
    const cfg = defectConfig()
    const meta = state.defect.lastMeta || {}
    if (!meta.iid) throw new Error('还没有创建过信息数据，请先点「生成总结」')

    let tokenInfo = state.token
    if (!tokenInfo || !tokenInfo.ok) tokenInfo = findToken()
    if (!tokenInfo || !tokenInfo.ok) {
      throw new Error('未能获取 access-token，请先点「重新获取 Token」再试')
    }

    const found = await defectInfo.fetchInfoUrl(cfg, tokenInfo.token, meta.iid, { log })
    const info = {
      ok: Boolean(found.url),
      skipped: false,
      iid: meta.iid,
      url: found.url,
      message: found.url
        ? '信息地址已获取，可一键复制'
        : '信息列表里还没查到这个地址，可能还在审核或未发布，稍后再试',
    }

    if (state.defect.lastResult) {
      state.defect.lastResult.info = Object.assign({}, state.defect.lastResult.info, info)
      if (state.defect.lastResult.meta) state.defect.lastResult.meta.infoUrl = found.url || ''
    }
    log(found.url ? 'info' : 'warn', `重新获取信息地址：${found.url || '未查到'}`)
    return info
  })

  ipcMain.handle('app:hide', async () => {
    if (mainWindow) mainWindow.hide()
  })
  ipcMain.handle('app:quit', async () => {
    isQuitting = true
    app.quit()
  })

  registerCloudIpc()
}

/**
 * 云手机：投屏 + 操控手机的 IPC。
 * 每个处理函数都返回最新的云手机状态，渲染端直接拿去重绘。
 */
function registerCloudIpc() {
  cloud = createCloudController({
    binaryDir: CLOUD_RUNTIME,
    log: (first, second) => {
      if (second === undefined) log('info', first)
      else log(first, second)
    },
    send: (channel, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, payload)
      }
    },
  })
  global.__cloudShotDir = userDir

  ipcMain.handle('cloud:state', async () => cloud.info())

  ipcMain.handle('cloud:devices', async () => cloud.devices())

  ipcMain.handle('cloud:start', async (event, serial) => {
    log('info', '云手机：连接 ' + serial)
    await cloud.start(serial)
    return cloud.info()
  })
  ipcMain.handle('cloud:stop', async () => {
    log('info', '云手机：断开连接')
    await cloud.stop()
    return cloud.info()
  })

  ipcMain.handle('cloud:pause', async (event, paused) => cloud.pause(Boolean(paused)))

  ipcMain.handle('cloud:input', async (event, payload) => cloud.input(payload || {}))

  ipcMain.handle('cloud:screenshot', async () => {
    const result = await cloud.screenshot()
    if (result.ok) log('info', '云手机：截图已保存 ' + result.file)
    else log('warn', '云手机：截图失败 ' + result.error)
    return result
  })

  /** 选本地图片 → adb push 到手机相册目录 → 触发媒体扫描 */
  ipcMain.handle('cloud:sendImages', async (event) => {
    if (!cloud || !cloud.isConnected()) {
      return { ok: false, error: '手机未连接，请先连接云手机' }
    }
    const parent = BrowserWindow.fromWebContents(event.sender) || mainWindow
    const options = {
      title: '选择要发送到手机的图片',
      buttonLabel: '发送',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
    }
    const picked = parent && !parent.isDestroyed()
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    if (picked.canceled || !picked.filePaths.length) {
      return { ok: false, canceled: true }
    }

    const result = await cloud.sendImages(picked.filePaths)
    if (result.sent) {
      log('info', `云手机：已发送 ${result.sent} 张图片到 ${result.dir}`)
    }
    if (result.failed) {
      const firstError = result.errors && result.errors[0] ? result.errors[0].error : ''
      log('warn', `云手机：${result.failed} 张图片发送失败${firstError ? `（${firstError}）` : ''}`)
    }
    if (!result.sent && !result.failed) {
      log('warn', `云手机：发送图片失败 ${result.error || '未知错误'}`)
    }
    return result
  })

  ipcMain.handle('cloud:wireless', async (event, serial) => {
    const address = await cloud.enableWireless(serial)
    if (address) log('info', '云手机：已切换到无线连接 ' + address)
    else log('warn', '云手机：转无线失败（取不到手机 IP 或连接失败）')
    return address
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
    linkShown: !document.getElementById('defect-link').hidden,
    linkText: document.getElementById('out-url').textContent,
    linkHref: document.getElementById('out-url').getAttribute('href'),
    copyButtons: document.querySelectorAll('#defect-link .copy').length,
    resultBlocks: document.querySelectorAll('.result-block').length,
    errorShown: !document.getElementById('defect-error').hidden,
    errorText: document.getElementById('defect-error').innerText.slice(0, 200),
    infoShown: !document.getElementById('defect-info').hidden,
    infoText: document.getElementById('defect-info-text').textContent,
    urlButtonVisible: Boolean(document.getElementById('btn-defect-url').hidden === false),
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
      const visibleCopies = Array.from(document.querySelectorAll('#defect-link .copy'))
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
        linkBlock: rect('#defect-link'),
        textareas,
        visibleCopies,
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      }
    })(),
  }))()`)
  result.ticketNo = ticketNo
  result.gitUrl = gitUrl

  // 用一段假地址把「信息地址」块渲染出来，验证布局与复制按钮（不发请求）
  result.linkDemo = await mainWindow.webContents.executeJavaScript(`(() => {
    const url = 'https://work.hanweb.com/wd/gdzsk/art/2026/art_0123456789abcdef0123456789abcdef.html'
    renderInfo({ ok: true, iid: 'demo', url, message: '信息已创建并发布，地址已生成，可一键复制' })
    renderLink(url)
    const box = document.getElementById('defect-link')
    const link = document.getElementById('out-url')
    const copy = document.querySelector('#defect-link .copy')
    const rect = box.getBoundingClientRect()
    return {
      shown: !box.hidden,
      text: link.textContent,
      href: link.getAttribute('href'),
      blockWidth: Math.round(rect.width),
      linkWidth: Math.round(link.getBoundingClientRect().width),
      copyWidth: copy ? Math.round(copy.getBoundingClientRect().width) : 0,
      urlButtonHidden: document.getElementById('btn-defect-url').hidden,
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    }
  })()`)

  // 顺带验证左侧四个菜单项与各自独立面板
  result.panes = await mainWindow.webContents.executeJavaScript(`(() => {
    const click = (name) => document.querySelector('.menu-item[data-pane="' + name + '"]').click()
    const hidden = (name) => document.getElementById('pane-' + name).hidden
    const only = (name) => !hidden(name) && ['exam', 'defect', 'reminder', 'log']
      .filter((other) => other !== name).every(hidden)
    click('log')
    const logLines = document.querySelectorAll('#log-view .log-line').length
    const logViewHeight = Math.round(
      document.querySelector('#pane-log .log-view').getBoundingClientRect().height)
    const logOnly = only('log')
    click('exam')
    const examOnly = only('exam')
    click('defect')
    const defectOnly = only('defect')
    click('reminder')
    const reminderOnly = only('reminder')
    return { logOnly, examOnly, defectOnly, reminderOnly, logLines, logViewHeight }
  })()`)

  // 到期提醒：真查一次待办（只写日志不弹窗），再看界面渲染
  result.reminderRun = await runReminder('manual', { notify: false })
  result.reminderDom = await mainWindow.webContents.executeJavaScript(`(() => {
    document.querySelector('.menu-item[data-pane="reminder"]').click()
    const rows = Array.from(document.querySelectorAll('#reminder-rows .reminder-row'))
    const first = rows[0] || null
    const nameCell = first ? first.querySelector('.reminder-col-name') : null
    return {
      paneShown: !document.getElementById('pane-reminder').hidden,
      switchOn: document.getElementById('reminder-switch').checked,
      rows: rows.length,
      listShown: !document.getElementById('reminder-list').hidden,
      emptyShown: !document.getElementById('reminder-empty').hidden,
      stateText: document.getElementById('reminder-state').textContent,
      todayText: document.getElementById('reminder-today').textContent,
      metaText: document.getElementById('reminder-meta').textContent,
      hintText: document.getElementById('reminder-hint').textContent,
      firstRow: first ? first.textContent.replace(/\\s+/g, ' ').trim() : '',
      nameWidth: nameCell ? Math.round(nameCell.getBoundingClientRect().width) : 0,
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    }
  })()`)
  // 用两条假数据把提醒列表渲染出来，验证布局（不写状态、不发通知）
  result.reminderDemo = await mainWindow.webContents.executeJavaScript(`(() => {
    const now = Date.now()
    renderReminder({
      enabled: true, running: false, lastRunAt: now, nextRunAt: now + 1800000,
      refreshedAt: now, lastError: '', intervalMinutes: 30, advanceMinutes: 30,
      eveningText: '18:00', eveningNotifyText: '17:30',
      total: 2, today: 2, waiting: 1, sent: 1,
      items: [
        {
          ticketNo: 'JETABLE2026102100001',
          title: '示例：今天 17:00 截止的工单（标题很长很长用来试省略号）',
          deadlineText: '10月21日 (周三) 17:00 截止',
          isToday: true, window: 'soon', notifyAt: now + 600000, sentAt: 0, status: 'waiting',
        },
        {
          ticketNo: 'JETABLE2026102100002',
          title: '示例：今晚 23:59 截止的工单',
          deadlineText: '10月21日 (周三) 23:59 截止',
          isToday: true, window: 'evening', notifyAt: now, sentAt: now, status: 'sent',
        },
      ],
    })
    const rows = Array.from(document.querySelectorAll('#reminder-rows .reminder-row'))
    const first = rows[0]
    const nameCell = first.querySelector('.reminder-col-name')
    const nameEl = first.querySelector('.reminder-name')
    return {
      rows: rows.length,
      listShown: !document.getElementById('reminder-list').hidden,
      emptyShown: !document.getElementById('reminder-empty').hidden,
      metaText: document.getElementById('reminder-meta').textContent,
      todayText: document.getElementById('reminder-today').textContent,
      firstRow: first.textContent.replace(/\\s+/g, ' ').trim(),
      nameWidth: Math.round(nameCell.getBoundingClientRect().width),
      nameEllipsis: nameEl.scrollWidth > nameEl.clientWidth + 1,
      rowWidth: Math.round(first.getBoundingClientRect().width),
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    }
  })()`)
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
      const withCloud = process.argv.includes('--smoke-cloud')
      const probe = `(() => ({
        title: document.title,
        version: (document.getElementById('version') || {}).textContent,
        examState: (document.getElementById('exam-state') || {}).textContent,
        tokenText: (document.getElementById('side-account-body') || {}).innerText,
        logLines: document.querySelectorAll('.log-line').length,
        switchChecked: Boolean(document.getElementById('exam-switch') && document.getElementById('exam-switch').checked),
        lastResult: (document.getElementById('exam-result') || {}).textContent,
        nextRun: (document.getElementById('exam-next') || {}).textContent,
        menuItems: document.querySelectorAll('.menu-item').length,
        sideAccount: Boolean(document.querySelector('.side-account')),
        panes: ['exam', 'defect', 'log'].map(function (name) {
          var node = document.getElementById('pane-' + name)
          return Boolean(node && !node.hidden)
        }),
        sidebar: (() => {
          const node = document.querySelector('.sidebar')
          return node ? Math.round(node.getBoundingClientRect().width) : 0
        })(),
        formValues: ['defect-ticket', 'defect-giturl']
          .map((id) => (document.getElementById(id) || {}).value || ''),
        defectPaneHidden: Boolean(document.getElementById('pane-defect') && document.getElementById('pane-defect').hidden),
        defectInputs: document.querySelectorAll('#pane-defect input').length,
        defectCopyButtons: document.querySelectorAll('#defect-result .copy').length,
        cloudSendButton: Boolean(document.getElementById('btn-cloud-send-image')),
        cloudSendDisabled: Boolean(document.getElementById('btn-cloud-send-image')
          && document.getElementById('btn-cloud-send-image').disabled),
        cloudTransferHidden: Boolean(document.getElementById('cloud-transfer')
          && document.getElementById('cloud-transfer').hidden),
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

            if (withCloud) {
              const cloudInfo = await mainWindow.webContents.executeJavaScript(`(async () => {
                document.querySelector('.menu-item[data-pane="cloud"]').click()
                await new Promise((resolve) => setTimeout(resolve, 400))
                const button = document.getElementById('btn-cloud-send-image')
                const status = document.getElementById('cloud-transfer')
                const pane = document.getElementById('pane-cloud')
                const firstOption = document.querySelector('#cloud-device-select option')
                const rect = button.getBoundingClientRect()
                // 未连接时调用一次 IPC：不会弹文件框，用来验证 preload → 主进程的通路
                const ipcResult = button.disabled ? await window.assistant.cloudSendImages() : null
                return {
                  paneVisible: Boolean(pane && !pane.hidden),
                  buttonVisible: rect.width > 0 && rect.height > 0,
                  buttonText: button.textContent,
                  buttonDisabled: Boolean(button.disabled),
                  deviceText: firstOption ? firstOption.textContent : '',
                  transferHidden: Boolean(status && status.hidden),
                  horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
                  ipcResult,
                }
              })()`)
              console.log(`SMOKE_CLOUD ${JSON.stringify(cloudInfo)}`)
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
              after.refreshOk = refreshed.tokenText.includes('剩余')
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

    // 工单到期提醒：默认开（config.json 里 reminder.enabled），启动就先查一轮
    if (!SMOKE_MODE && cfg.reminder && cfg.reminder.enabled !== false) {
      startReminder()
    } else if (SMOKE_MODE) {
      log('info', '冒烟模式：不启动工单到期提醒定时器')
    }
  })

  app.on('window-all-closed', () => {
    // 关闭窗口不退出：应用常驻托盘
  })

  app.on('before-quit', () => {
    isQuitting = true
    if (state.exam.timer) clearInterval(state.exam.timer)
    if (state.reminder.timer) clearInterval(state.reminder.timer)
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
