'use strict'
/**
 * 工单到期提醒：按待办列表里的截止时间，算出什么时候该弹 Windows 通知。
 *
 * 规则（与需求一致）：
 *   - 截止时间是「今天」的才算；
 *   - 截止在今天 18:00 之前的 → 截止前 30 分钟提醒；
 *   - 截止在今天 18:00 及以后的 → 统一在今天 17:30 提醒（一条通知里列全部）。
 *
 * 截止时间有两个来源：`planEndTime`（毫秒时间戳，准）优先，
 * 其次解析 `deadlineTime`（"10月26日 (周一) 23:59 截止"，没有年份要按当前年补）。
 */

const { httpJson, AuthError } = require('../exam/api')

const DEFAULT_SOURCE = {
  apiHost: 'https://work.hanweb.com',
  listPath: '/api-gateway/jpaas-jtodo-server/manager/new-pending/list',
  sortRole: 1,
  applyState: 0,
  plan: 0,
  typeId: 'VDq5V3vBJSj1NHy14tUDi',
  pageSize: 10,
  maxPages: 20,
}

const MS_MINUTE = 60000

function pad2(value) {
  return String(value).padStart(2, '0')
}

/** 2026-10-26 这种按天比对的 key。 */
function dayKey(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function sameDay(a, b) {
  return Boolean(a && b) && dayKey(a) === dayKey(b) && dayKey(a) !== ''
}

/** "17:30" → { hour: 17, minute: 30 }，非法值退回 17:30。 */
function parseClock(text, fallbackHour = 17, fallbackMinute = 30) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim())
  if (!match) return { hour: fallbackHour, minute: fallbackMinute }
  const hour = Math.min(23, Math.max(0, Number(match[1])))
  const minute = Math.min(59, Math.max(0, Number(match[2])))
  return { hour, minute }
}

/**
 * 解析 "10月26日 (周一) 23:59 截止"（年份按当前年补，跨年时顺延一年）。
 * @returns {Date|null}
 */
function parseDeadlineText(text, now = new Date()) {
  const raw = String(text || '')
  if (!raw) return null
  const match = /(\d{1,2})\s*月\s*(\d{1,2})\s*日[^\d]*?(\d{1,2})\s*:\s*(\d{2})/.exec(raw)
  if (!match) return null

  const month = Number(match[1])
  const day = Number(match[2])
  const hour = Number(match[3])
  const minute = Number(match[4])
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null
  if (!(hour >= 0 && hour <= 23) || !(minute >= 0 && minute <= 59)) return null

  const base = now instanceof Date ? now : new Date()
  const build = (year) => {
    const date = new Date(year, month - 1, day, hour, minute, 0, 0)
    // 2 月 30 日之类会被自动进位，这里挡掉
    if (date.getMonth() !== month - 1 || date.getDate() !== day) return null
    return date
  }

  const current = build(base.getFullYear())
  if (!current) return null
  // 没有年份：如果算出来比现在早了半年以上，说明是明年的
  const halfYear = 183 * 24 * 60 * MS_MINUTE
  if (current.getTime() < base.getTime() - halfYear) {
    return build(base.getFullYear() + 1)
  }
  return current
}

/**
 * 取一条待办的截止时间。
 * @returns {{ at: Date|null, text: string, source: string }}
 */
function parseDeadline(item, now = new Date()) {
  const data = item && typeof item === 'object' ? item : {}
  const text = String(data.deadlineTime || '').trim()

  const rawMs = Number(data.planEndTime)
  if (Number.isFinite(rawMs) && rawMs > 1e12) {
    const at = new Date(rawMs)
    if (!Number.isNaN(at.getTime())) return { at, text, source: 'planEndTime' }
  }

  const parsed = parseDeadlineText(text, now)
  return { at: parsed, text, source: parsed ? 'deadlineTime' : '' }
}

/**
 * 判断这条截止时间今天要不要提醒、什么时候提醒。
 * @returns {{ isToday:boolean, window:string, notifyAt:Date|null }}
 */
function classifyDeadline(deadlineAt, now = new Date(), cfg = {}) {
  const nothing = { isToday: false, window: '', notifyAt: null }
  if (!(deadlineAt instanceof Date) || Number.isNaN(deadlineAt.getTime())) return nothing
  if (!sameDay(deadlineAt, now)) return nothing

  const eveningHour = Number(cfg.eveningHour)
  const hour = Number.isFinite(eveningHour) ? eveningHour : 18
  const advanceMinutes = Number(cfg.advanceMinutes)
  const advance = Number.isFinite(advanceMinutes) ? Math.max(0, advanceMinutes) : 30

  const minutesOfDay = deadlineAt.getHours() * 60 + deadlineAt.getMinutes()
  if (minutesOfDay >= hour * 60) {
    const clock = parseClock(cfg.eveningNotifyTime, 17, 30)
    const notifyAt = new Date(now)
    notifyAt.setHours(clock.hour, clock.minute, 0, 0)
    return { isToday: true, window: 'evening', notifyAt }
  }

  return {
    isToday: true,
    window: 'soon',
    notifyAt: new Date(deadlineAt.getTime() - advance * MS_MINUTE),
  }
}

/** 界面用：把一条待办整理成展示行。 */
function describeItem(item, now = new Date(), cfg = {}) {
  const data = item && typeof item === 'object' ? item : {}
  const { at, text, source } = parseDeadline(data, now)
  const cls = classifyDeadline(at, now, cfg)
  const ticketNo = String(data.transactNo || '')
  const key = cls.isToday && cls.window && at
    ? `${dayKey(at)}|${ticketNo}|${cls.window}`
    : ''
  return {
    ticketNo,
    key,
    title: String(data.applyName || '').trim(),
    iid: String(data.iid || ''),
    deadlineText: text || (at ? `${dayKey(at)} ${pad2(at.getHours())}:${pad2(at.getMinutes())}` : ''),
    deadlineAt: at ? at.getTime() : 0,
    deadlineSource: source,
    isToday: cls.isToday,
    window: cls.window,
    notifyAt: cls.notifyAt ? cls.notifyAt.getTime() : 0,
    url: String(data.thirdAppUrl || ''),
  }
}

/**
 * 当前这一轮真正要弹的通知。
 * @param {Array<object>} items  待办列表
 * @param {Date} now
 * @param {object} cfg           reminder 配置
 * @param {object} sent          { "<日期>|<单号>|<窗口>": 时间戳 }
 * @returns {Array<{key:string, ticketNo:string, title:string, deadlineText:string, window:string, deadlineAt:number}>}
 */
function dueNotifications(items, now = new Date(), cfg = {}, sent = {}) {
  const list = Array.isArray(items) ? items : []
  const done = sent && typeof sent === 'object' ? sent : {}
  const due = []

  for (const item of list) {
    const info = describeItem(item, now, cfg)
    if (!info.isToday || !info.window || !info.deadlineAt) continue
    if (!info.notifyAt) continue
    if (now.getTime() < info.notifyAt) continue
    // 已经过期的就不补发了，免得一开机弹一堆旧单
    if (now.getTime() > info.deadlineAt) continue

    const key = `${dayKey(new Date(info.deadlineAt))}|${info.ticketNo}|${info.window}`
    if (done[key]) continue
    due.push({
      key,
      ticketNo: info.ticketNo,
      title: info.title,
      deadlineText: info.deadlineText,
      window: info.window,
      deadlineAt: info.deadlineAt,
    })
  }

  return due
}

/**
 * 把待提醒的条目拼成通知：18:00 后到期的一条通知列全部，其余一条一个。
 * @returns {Array<{ title:string, body:string, keys:Array<string> }>}
 */
function buildNotifications(due) {
  const list = Array.isArray(due) ? due : []
  const out = []
  const evening = list.filter((item) => item.window === 'evening')
  const soon = list.filter((item) => item.window !== 'evening')

  for (const item of soon) {
    out.push({
      title: `工单还有不到 30 分钟到期：${item.title || item.ticketNo}`,
      body: `办件名：${item.title || item.ticketNo}\n截止时间：${item.deadlineText}`,
      keys: [item.key],
    })
  }

  if (evening.length) {
    const lines = evening.map((item) => `· ${item.title || item.ticketNo}（${item.deadlineText}）`)
    out.push({
      title: `今天下班前要交：${evening.length} 个工单 18:00 后到期`,
      body: lines.join('\n'),
      keys: evening.map((item) => item.key),
    })
  }

  return out
}

// ============================================================================
// 拉取待办（分页参数必须放 query，放 body 服务端会忽略）
// ============================================================================

function reminderConfig(cfg) {
  const source = cfg && typeof cfg === 'object' ? cfg : {}
  return {
    apiHost: String(source.apiHost || DEFAULT_SOURCE.apiHost).replace(/\/+$/, ''),
    listPath: source.listPath || DEFAULT_SOURCE.listPath,
    sortRole: source.sortRole == null ? DEFAULT_SOURCE.sortRole : source.sortRole,
    applyState: source.applyState == null ? DEFAULT_SOURCE.applyState : source.applyState,
    plan: source.plan == null ? DEFAULT_SOURCE.plan : source.plan,
    typeId: source.typeId || DEFAULT_SOURCE.typeId,
    pageSize: Math.max(1, Number(source.pageSize) || DEFAULT_SOURCE.pageSize),
    maxPages: Math.max(1, Number(source.maxPages) || DEFAULT_SOURCE.maxPages),
  }
}

async function fetchPage(cfg, token, pageNo, { log = () => {} } = {}) {
  let payload
  try {
    payload = await httpJson({
      url: `${cfg.apiHost}${cfg.listPath}`,
      method: 'POST',
      token,
      query: {
        pageNo,
        pageSize: cfg.pageSize,
        sortRole: cfg.sortRole,
        applyState: cfg.applyState,
        plan: cfg.plan,
        typeId: cfg.typeId,
      },
      body: {},
      timeout: 30000,
      retries: 1,
      log,
    })
  } catch (error) {
    if (error instanceof AuthError) {
      throw new Error('access-token 失效或无权查询待办列表')
    }
    throw error
  }

  const code = payload && payload.code
  if (code !== undefined && code !== null && code !== '' && String(code) !== '200' && String(code) !== '0') {
    throw new Error(`查询待办列表失败：${(payload && payload.message) || JSON.stringify(payload).slice(0, 160)}`)
  }

  const data = (payload && payload.data) || {}
  const list = Array.isArray(data.list) ? data.list : []
  return { list, totalPage: Number(data.totalPage) || 0, totalCount: Number(data.totalCount) || 0 }
}

/**
 * 拉全部待办（按 totalPage 翻页，最多 maxPages 页）。
 * @returns {Promise<{ items:Array<object>, pages:number, totalCount:number }>}
 */
async function fetchPending(cfg, token, { log = () => {} } = {}) {
  const conf = reminderConfig(cfg)
  const items = []
  const seen = new Set()
  let pages = 0
  let totalCount = 0

  for (let pageNo = 1; pageNo <= conf.maxPages; pageNo += 1) {
    const page = await fetchPage(conf, token, pageNo, { log })
    pages += 1
    totalCount = page.totalCount || totalCount
    if (!page.list.length) break

    for (const item of page.list) {
      const key = String((item && (item.transactNo || item.iid)) || '')
      if (key && seen.has(key)) continue
      if (key) seen.add(key)
      items.push(item)
    }

    if (page.totalPage && pageNo >= page.totalPage) break
    if (page.list.length < conf.pageSize) break
  }

  return { items, pages, totalCount }
}

module.exports = {
  dayKey,
  sameDay,
  parseClock,
  parseDeadlineText,
  parseDeadline,
  classifyDeadline,
  describeItem,
  dueNotifications,
  buildNotifications,
  reminderConfig,
  fetchPending,
}
