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
  const body = $('token-body')
  body.textContent = ''

  if (!token) {
    body.appendChild(el('span', 'dot dot-idle'))
    body.appendChild(el('span', 'token-text', '正在读取…'))
    return
  }

  if (!token.ok) {
    body.appendChild(el('span', 'dot dot-error'))
    const wrap = el('span', 'token-text')
    wrap.appendChild(el('div', '', '未能获取 access-token'))
    wrap.appendChild(el('div', 'meta', token.error || '请确认微联叮客户端已登录'))
    body.appendChild(wrap)
    return
  }

  const hours = Number(token.remainingHours || 0)
  const level = hours <= 24 ? 'warn' : 'ok'
  body.appendChild(el('span', `dot dot-${level}`))

  const wrap = el('span', 'token-text')
  wrap.appendChild(el('div', '',
    `已获取 ${token.username || '当前用户'} 的 access-token · 剩余 ${hours.toFixed(1)} 小时`))
  wrap.appendChild(el('div', 'meta',
    `到期 ${fmtFull(token.expiresAt)} · 来源 ${token.source || 'vlinkd 客户端'}`))
  body.appendChild(wrap)
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

  if (snapshotData.app) {
    $('version').textContent = `v${snapshotData.app.version}`
    $('dry-run').checked = Boolean(snapshotData.app.dryRun)
    $('footer-info').textContent = snapshotData.app.closeToTray
      ? '关闭窗口后会隐藏到系统托盘，托盘图标右键可重新打开或退出'
      : '关闭窗口将退出应用'
  }
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

async function init() {
  bind()
  api.onState((payload) => render(payload))
  api.onLog((entry) => appendLog(entry))

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
