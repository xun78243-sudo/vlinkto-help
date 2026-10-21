'use strict'
/** 渲染进程逻辑：只通过 preload 暴露的 API 与主进程交互。 */

const api = window.assistant
const $ = (id) => document.getElementById(id)

let snapshot = null
let busy = false

function pad2(value) {
  return String(value).padStart(2, '0')
}

function fmtDate(value) {
  if (!value) return '—'
  const date = typeof value === 'number' ? new Date(value) : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
    + `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

function fmtFull(value) {
  if (!value) return '—'
  const date = new Date(value)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
    + `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

// ---------------------------------------------------------------- 渲染

function renderToken(token) {
  const body = $('side-account-body')
  body.textContent = ''

  if (!token) {
    body.appendChild(el('div', 'side-account-sub', '正在读取…'))
    return
  }

  if (!token.ok) {
    body.appendChild(el('div', 'side-account-user side-account-error', '未获取到 token'))
    body.appendChild(el('div', 'side-account-sub', token.error || '请在微联叮客户端登录后重试'))
    return
  }

  const hours = Number(token.remainingHours || 0)
  const level = hours <= 24 ? 'warn' : 'ok'

  const head = el('div', 'side-account-user')
  head.appendChild(el('span', `dot dot-${level}`))
  head.appendChild(el('span', '', token.username || '当前用户'))
  body.appendChild(head)

  body.appendChild(el('div', 'side-account-sub', `剩余 ${hours.toFixed(1)} 小时`))
  body.appendChild(el('div', 'side-account-sub', `到期 ${fmtFull(token.expiresAt)}`))
  body.appendChild(el('div', 'side-account-sub', `来源 ${token.source || 'vlinkd 客户端'}`))
}

function renderExam(exam) {
  const toggle = $('exam-switch')
  toggle.checked = Boolean(exam.enabled)
  $('exam-hint').textContent = `打开开关后立即检测一次，之后每 ${exam.intervalHours || 3} 小时自动执行`

  const stateEl = $('exam-state')
  stateEl.textContent = exam.running ? '检测中…' : (exam.enabled ? '自动检测已开启' : '已关闭')
  stateEl.className = exam.running ? '' : (exam.enabled ? 'ok' : '')

  $('exam-last').textContent = fmtDate(exam.lastRunAt)
  $('exam-next').textContent = exam.enabled && exam.nextRunAt ? fmtDate(exam.nextRunAt) : '—'

  const resultEl = $('exam-result')
  const result = exam.lastResult
  if (!result) {
    resultEl.textContent = '—'
    resultEl.className = ''
  } else if (result.error) {
    resultEl.textContent = result.error
    resultEl.className = 'error'
    resultEl.title = result.error
  } else if (result.stats) {
    const stats = result.stats
    resultEl.textContent = `建日程 ${stats.created} 条 / 命中 ${stats.qualified} 条`
    resultEl.className = stats.failed > 0 ? 'error' : 'ok'
    resultEl.title = `共 ${stats.total} 条，本部门 ${stats.dept} 条，当天 ${stats.today} 条，`
      + `跳过 ${stats.skipped} 条，解密失败 ${stats.undecrypted} 条，建失败 ${stats.failed} 条`
  }

  $('btn-run').disabled = Boolean(exam.running) || busy
  $('exam-switch').disabled = busy
}

function render(snapshotData) {
  if (!snapshotData) return
  snapshot = snapshotData
  renderToken(snapshotData.token)
  renderExam(snapshotData.exam)
  if (snapshotData.reminder) renderReminder(snapshotData.reminder)

  if (snapshotData.app) {
    $('version').textContent = `v${snapshotData.app.version}`
    $('dry-run').checked = Boolean(snapshotData.app.dryRun)
    $('footer-info').textContent = snapshotData.app.closeToTray
      ? '关闭窗口后会隐藏到系统托盘，托盘图标右键可重新打开或退出'
      : '关闭窗口将退出应用'
  }

  // 缺陷单表单不预填任何默认值：工单号与 git 地址每次都由使用者输入
}

// ---------------------------------------------------------------- 到期提醒

function fmtClock(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

function reminderPlanOf(item) {
  if (item.status === 'sent') return { text: `已提醒 ${fmtClock(item.sentAt)}`, cls: 'ok' }
  if (item.status === 'waiting') return { text: `待提醒 ${fmtClock(item.notifyAt)}`, cls: 'wait' }
  if (item.isToday) return { text: '今天到期（时间未识别）', cls: 'warn' }
  return { text: '非今日', cls: 'muted' }
}

function renderReminder(view) {
  if (!view) return
  const toggle = $('reminder-switch')
  toggle.checked = Boolean(view.enabled)
  $('reminder-hint').textContent = `每 ${view.intervalMinutes || 30} 分钟查一次待办；今天 `
    + `${view.eveningText || '18:00'} 前到期的提前 ${view.advanceMinutes || 30} 分钟提醒，`
    + `${view.eveningText || '18:00'} 后到期的统一 ${view.eveningNotifyText || '17:30'} 提醒`

  const stateEl = $('reminder-state')
  stateEl.textContent = view.running
    ? '检查中…'
    : (view.enabled ? '自动检查已开启' : '已关闭')
  stateEl.className = view.running ? '' : (view.enabled ? 'ok' : '')

  $('reminder-last').textContent = fmtDate(view.lastRunAt)
  $('reminder-next').textContent = view.enabled && view.nextRunAt ? fmtDate(view.nextRunAt) : '—'
  $('reminder-today').textContent = view.refreshedAt
    ? `${view.today} 条 / 待办 ${view.total} 条`
    : '—'

  const meta = $('reminder-meta')
  if (view.lastError) {
    meta.textContent = view.lastError
    meta.className = 'reminder-meta error'
    meta.title = view.lastError
  } else if (view.refreshedAt) {
    meta.textContent = `待提醒 ${view.waiting} 条 · 已提醒 ${view.sent} 条`
    meta.className = 'reminder-meta'
    meta.title = ''
  } else {
    meta.textContent = '—'
    meta.className = 'reminder-meta'
    meta.title = ''
  }

  const list = $('reminder-list')
  const rows = $('reminder-rows')
  const empty = $('reminder-empty')
  rows.textContent = ''
  list.hidden = !view.items || view.items.length === 0
  empty.hidden = Boolean(view.items && view.items.length)

  for (const item of view.items || []) {
    const row = el('div', 'reminder-row')
    const name = el('span', 'reminder-col-name')
    name.appendChild(el('span', 'reminder-name', item.title || item.ticketNo || '（无标题）'))
    if (item.ticketNo) name.appendChild(el('span', 'reminder-ticket', item.ticketNo))
    row.appendChild(name)
    row.appendChild(el('span', 'reminder-col-time', item.deadlineText || '—'))
    const plan = reminderPlanOf(item)
    row.appendChild(el('span', `reminder-col-plan ${plan.cls}`, plan.text))
    rows.appendChild(row)
  }

  $('btn-reminder-run').disabled = Boolean(view.running)
  toggle.disabled = false
}

function appendLog(entry) {
  const view = $('log-view')
  const empty = view.querySelector('.log-empty')
  if (empty) empty.remove()

  const line = el('div', `log-line ${entry.level || 'info'}`)
  line.appendChild(el('span', 'ts', String(entry.time || '').split(' ').pop() || ''))
  line.appendChild(el('span', 'msg', entry.message || ''))
  view.appendChild(line)

  while (view.childElementCount > 400) view.removeChild(view.firstChild)
  view.scrollTop = view.scrollHeight
}

// ---------------------------------------------------------------- 交互

async function withBusy(action) {
  if (busy) return
  busy = true
  $('btn-run').disabled = true
  $('exam-switch').disabled = true
  try {
    await action()
  } finally {
    busy = false
    if (snapshot) renderExam(snapshot.exam)
  }
}

function bind() {
  $('btn-refresh').addEventListener('click', () => withBusy(async () => {
    $('btn-refresh').disabled = true
    $('btn-refresh').textContent = '获取中…'
    try {
      render(await api.refreshToken())
    } finally {
      $('btn-refresh').disabled = false
      $('btn-refresh').textContent = '重新获取 Token'
    }
  }))

  $('exam-switch').addEventListener('change', (event) => {
    // 立即取值：后面的重渲染会把 checked 覆盖回快照里的旧值
    const enabled = event.target.checked
    withBusy(async () => {
      render(await api.toggleExam(enabled))
    })
  })

  $('btn-run').addEventListener('click', () => withBusy(async () => {
    render(await api.runNow())
  }))

  $('reminder-switch').addEventListener('change', (event) => {
    const enabled = event.target.checked
    $('reminder-switch').disabled = true
    api.toggleReminder(enabled)
      .then(render)
      .catch(() => { $('reminder-switch').disabled = false })
  })

  $('btn-reminder-run').addEventListener('click', async () => {
    $('btn-reminder-run').disabled = true
    $('btn-reminder-run').textContent = '检查中…'
    try {
      render(await api.runReminder())
    } finally {
      $('btn-reminder-run').textContent = '立即检查'
      if (snapshot && snapshot.reminder) $('btn-reminder-run').disabled = Boolean(snapshot.reminder.running)
    }
  })

  $('btn-reminder-test').addEventListener('click', () => {
    api.testReminderNotify().then(render).catch(() => {})
  })

  $('dry-run').addEventListener('change', (event) => {
    api.setDryRun(event.target.checked).then(render)
  })

  $('btn-logs').addEventListener('click', () => api.openLogs())
  $('btn-config').addEventListener('click', () => api.openConfig())
  $('btn-clear').addEventListener('click', () => {
    $('log-view').textContent = ''
    $('log-view').appendChild(el('div', 'log-empty', '日志已清空（磁盘上的日志不受影响）'))
  })
}

// ---------------------------------------------------------------- 缺陷单总结

const STAGE_TEXT = { ticket: '查工单', git: '拉取提交', ai: 'AI 生成', submit: '提交信息' }

function switchPane(name) {
  for (const item of document.querySelectorAll('.menu-item')) {
    item.classList.toggle('is-active', item.dataset.pane === name)
  }
  $('pane-exam').hidden = name !== 'exam'
  $('pane-defect').hidden = name !== 'defect'
  $('pane-reminder').hidden = name !== 'reminder'
  $('pane-log').hidden = name !== 'log'
}

function resetStages() {
  const wrap = $('defect-stages')
  wrap.hidden = true
  for (const node of wrap.querySelectorAll('.stage')) {
    node.classList.remove('is-running', 'is-done', 'is-error')
  }
}

function setStage(stage, stageState) {
  const wrap = $('defect-stages')
  wrap.hidden = false
  const node = wrap.querySelector(`.stage[data-stage="${stage}"]`)
  if (!node) return
  node.classList.remove('is-running', 'is-done', 'is-error')
  if (stageState === 'running') node.classList.add('is-running')
  else if (stageState === 'done') node.classList.add('is-done')
  else if (stageState === 'error') node.classList.add('is-error')
}

function showDefectError(message, hint) {
  const box = $('defect-error')
  box.textContent = ''
  box.hidden = false
  box.appendChild(el('div', '', message || '生成失败'))
  if (hint) box.appendChild(el('span', 'hint', hint))
}

/** ipcRenderer.invoke 抛出的错误前面会带一长串前缀，这里剥掉。 */
function cleanError(error) {
  const text = error && error.message ? error.message : String(error)
  return text.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '')
}

function clearDefectError() {
  const box = $('defect-error')
  box.hidden = true
  box.textContent = ''
}


function renderDefectResult(result) {
  const meta = (result && result.meta) || {}
  const seconds = ((Number(meta.elapsedMs) || 0) / 1000).toFixed(1)
  const parts = []
  if (meta.branch) parts.push(`分支 ${meta.branch}`)
  parts.push(`提交 ${meta.commitCount || 0}/${meta.scannedCommits || 0} 条`)
  if (meta.infoUrl) parts.push('信息已发布')
  if (meta.model) parts.push(meta.model)
  parts.push(`${seconds}s`)
  $('defect-meta').textContent = parts.join(' · ')
  $('defect-meta').title = (meta.commitList || [])
    .map((item) => `${item.short} ${item.date} ${item.subject}`)
    .join('\n')

  renderInfo(result && result.info)
  renderLink((result && result.info && result.info.url) || '')

  for (const node of document.querySelectorAll('.copy')) {
    node.classList.remove('is-copied')
    node.textContent = '复制'
  }
}

/** 信息地址：有就显示可点击的链接 + 复制按钮，没有就整块收起来。 */
function renderLink(url) {
  const box = $('defect-link')
  const link = $('out-url')
  const text = String(url || '').trim()

  if (!text) {
    box.hidden = true
    link.textContent = ''
    link.removeAttribute('href')
    return
  }

  box.hidden = false
  link.textContent = text
  link.href = text
}

/** 确认提交结果条：成功蓝底、失败红底；地址还没刷出来时给个「重新获取地址」。 */
function renderInfo(info) {
  const box = $('defect-info')
  const text = $('defect-info-text')

  if (!info || !info.message) {
    box.hidden = true
    box.classList.remove('is-error', 'is-muted')
    text.textContent = ''
    $('btn-defect-url').hidden = true
    return
  }

  box.hidden = false
  const skipped = Boolean(info.skipped)
  box.classList.toggle('is-error', info.ok !== true && !skipped)
  box.classList.toggle('is-muted', info.ok !== true && skipped)
  $('btn-defect-url').hidden = !info.iid || Boolean(info.url)
  text.textContent = info.message
}

async function copyField(button) {
  const key = button.dataset.copy
  const node = $(`out-${key}`)
  const text = node ? (node.value || node.textContent || '') : ''
  await api.copy(text)
  button.textContent = '已复制'
  button.classList.add('is-copied')
  setTimeout(() => {
    button.textContent = '复制'
    button.classList.remove('is-copied')
  }, 1500)
}

async function loadDefectSettings() {
  const current = snapshot || await api.snapshot()
  const defectInfo = current.defect || {}

  $('set-git-user').value = defectInfo.gitUser || ''
  $('set-git-name').value = defectInfo.gitName || ''
  $('set-apikey').value = ''
  $('set-apikey').placeholder = defectInfo.hasApiKey ? '已保存（留空则不修改）' : '通常留空即可'
  $('set-git-auth-user').value = defectInfo.gitAuthUser || ''
  $('set-git-auth-pass').value = ''
  $('set-git-auth-pass').placeholder = defectInfo.hasGitPassword
    ? '已保存（留空则不修改）'
    : '留空则用本机 git 凭据'
  $('set-info-auto').checked = defectInfo.infoAutoSubmit !== false

  const select = $('set-model')
  select.textContent = ''
  let models = []
  try {
    models = await api.defectModels()
  } catch (error) {
    models = []
  }
  const options = models.length ? models : [defectInfo.aiModel].filter(Boolean)
  const seen = new Set()
  for (const id of options) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    const option = el('option', '', id)
    option.value = id
    select.appendChild(option)
  }
  if (defectInfo.aiModel && !seen.has(defectInfo.aiModel)) {
    const option = el('option', '', `${defectInfo.aiModel}（当前配置）`)
    option.value = defectInfo.aiModel
    select.appendChild(option)
  }
  select.value = defectInfo.aiModel || ''
}

async function submitDefectSettings() {
  const patch = {
    gitUser: $('set-git-user').value,
    gitName: $('set-git-name').value,
    gitAuthUser: $('set-git-auth-user').value,
    aiModel: $('set-model').value,
    infoAutoSubmit: $('set-info-auto').checked,
  }
  const key = $('set-apikey').value.trim()
  if (key) patch.aiApiKey = key
  const password = $('set-git-auth-pass').value
  if (password) patch.gitAuthPassword = password
  const next = await api.saveDefectSettings(patch)
  render(next)
  $('set-apikey').value = ''
  $('set-apikey').placeholder = '已保存（留空则不修改）'
  $('set-git-auth-pass').value = ''
  $('set-git-auth-pass').placeholder = '已保存（留空则不修改）'
  return next
}

async function generateDefect() {
  const transactNo = $('defect-ticket').value.trim()
  const gitUrl = $('defect-giturl').value.trim()

  clearDefectError()
  if (!transactNo) {
    showDefectError('请先输入工单编号', '例如 JETABLE2026101400071')
    $('defect-ticket').focus()
    return
  }
  if (!gitUrl) {
    showDefectError('请先输入 git 地址', '形如 http://host/group/project/tree/分支名')
    $('defect-giturl').focus()
    return
  }

  const button = $('btn-defect-generate')
  button.disabled = true
  button.textContent = '生成中…'
  $('defect-meta').textContent = '正在查询工单并拉取提交记录…'
  resetStages()

  try {
    const result = await api.generateDefect({ transactNo, gitUrl })
    renderDefectResult(result)
    if (result.errors && result.errors.length) {
      const first = result.errors[0]
      showDefectError(`${STAGE_TEXT[first.stage] || first.stage}失败：${first.message}`, first.hint)
    } else if (result.meta && result.meta.warnings && result.meta.warnings.length) {
      showDefectError('已生成，但有以下提示：', result.meta.warnings.join('；'))
    }
  } catch (error) {
    showDefectError(cleanError(error))
    $('defect-meta').textContent = '生成失败'
  } finally {
    button.disabled = false
    button.textContent = '生成总结'
  }
}

function bindDefect() {
  $('tabs').addEventListener('click', (event) => {
    const item = event.target.closest('.menu-item')
    if (!item) return
    switchPane(item.dataset.pane)
  })

  $('btn-defect-generate').addEventListener('click', generateDefect)

  // 列表里还没刷出地址时，用上一次的 iid 再查一次
  $('btn-defect-url').addEventListener('click', async () => {
    const button = $('btn-defect-url')
    button.disabled = true
    button.textContent = '查询中…'
    try {
      const info = await api.lookupDefectUrl()
      renderInfo(info)
      renderLink(info.url || '')
      if (info.url) {
        const current = $('defect-meta').textContent
        if (current && !current.includes('信息已发布')) {
          $('defect-meta').textContent = `${current} · 信息已发布`
        }
      }
    } catch (error) {
      showDefectError('查询信息地址失败', cleanError(error))
    } finally {
      button.disabled = false
      button.textContent = '重新获取地址'
    }
  })

  $('btn-defect-settings').addEventListener('click', async () => {
    const panel = $('defect-settings')
    const willShow = panel.hidden
    panel.hidden = !willShow
    if (willShow) {
      await loadDefectSettings()
      $('set-git-user').focus()
    }
  })

  $('btn-defect-save').addEventListener('click', async () => {
    const button = $('btn-defect-save')
    button.disabled = true
    try {
      await submitDefectSettings()
      $('defect-settings-hint').textContent = '已保存'
      setTimeout(() => {
        $('defect-settings-hint').textContent = '提交人按「账号 / 名称」匹配作者名或邮箱'
      }, 2000)
    } catch (error) {
      showDefectError(`保存设置失败：${error.message}`)
    } finally {
      button.disabled = false
    }
  })

  $('defect-link').addEventListener('click', (event) => {
    const copyButton = event.target.closest('.copy')
    if (copyButton) {
      copyField(copyButton)
      return
    }
    const link = event.target.closest('#out-url')
    if (!link) return
    // Electron 里 target=_blank 会另开窗口，统一交给系统浏览器打开
    event.preventDefault()
    const url = link.getAttribute('href')
    if (url) api.openUrl(url)
  })

  $('defect-ticket').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      $('defect-giturl').focus()
    }
  })
  $('defect-giturl').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      generateDefect()
    }
  })
}

async function init() {
  bind()
  bindDefect()
  api.onState((payload) => render(payload))
  api.onLog((entry) => appendLog(entry))
  api.onDefectStage((payload) => {
    if (payload && payload.stage) setStage(payload.stage, payload.state)
  })

  const [initial, history] = await Promise.all([api.snapshot(), api.logs()])
  render(initial)

  const view = $('log-view')
  view.textContent = ''
  if (!history || !history.length) {
    view.appendChild(el('div', 'log-empty', '暂无日志'))
  } else {
    for (const entry of history) appendLog(entry)
  }
}

document.addEventListener('DOMContentLoaded', init)
