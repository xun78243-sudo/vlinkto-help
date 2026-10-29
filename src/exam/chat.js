'use strict'
/**
 * 考试日程核心业务：按群拉当天聊天记录 -> 解密 -> AI 分析上下文 -> 建日程。
 */

const { sm3 } = require('./crypto')
const { resolveContent, classifyCipher } = require('./im')
const { httpJson, AuthError, ApiError } = require('./api')
const { analyzeGroup, isValidDate } = require('./ai')
const { getGroupIds } = require('../config')

const TIME_ZONE = 'Asia/Hong_Kong'
const hkFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})

function dateParts(date) {
  return Object.fromEntries(hkFormatter.formatToParts(date).map((part) => [part.type, part.value]))
}

function todayString(date = new Date()) {
  const d = dateParts(date)
  return `${d.year}-${d.month}-${d.day}`
}

function formatTime(stamp) {
  const d = dateParts(new Date(stamp))
  return `${d.year}-${d.month}-${d.day} ${d.hour}:${d.minute}:${d.second}`
}

/** 取消息毫秒时间戳，兼容 time/createTime/sendTime */
function msgTimeMs(msg) {
  for (const key of ['time', 'createTime', 'sendTime', 'timestamp']) {
    const value = msg[key]
    if (value === undefined || value === null || value === '') continue
    const number = Number(value)
    if (!Number.isFinite(number)) continue
    return number >= 1e11 ? Math.trunc(number) : Math.trunc(number * 1000)
  }
  return null
}

function parseExtras(msg) {
  let extras = msg.extras
  if (typeof extras === 'string') {
    try {
      extras = JSON.parse(extras)
    } catch (error) {
      extras = {}
    }
  }
  return extras && typeof extras === 'object' && !Array.isArray(extras) ? extras : {}
}

/**
 * 消息唯一键：优先 msgId/id，缺失时用「发送者 + 时间 + 正文摘要」兜底，
 * 否则同一条消息每轮都会被当成新消息、反复建日程。
 */
function messageKey(msg) {
  for (const field of ['msgId', 'id']) {
    const value = msg[field]
    if (value !== undefined && value !== null && value !== '') return String(value)
  }
  const stamp = msgTimeMs(msg) || 0
  const content = String(msg.content || '')
  return `gen-${msg.userid || ''}-${stamp}-${sm3(Buffer.from(content, 'utf8')).toString('hex').slice(0, 6)}`
}

/** 仅做名称格式规范化，不承担课程/受众的语义判断。 */
function courseKey(name) {
  return String(name || '').normalize('NFKC').replace(/\s+/g, '')
    .replace(/[《》〈〉「」『』“”‘’]/g, '').toLowerCase()
}

function eventKey(courseName, day) {
  return sm3(Buffer.from(`${courseKey(courseName)}\u0000${day}`, 'utf8')).toString('hex')
}

function buildScheduleName(courseName, maxLength = 50) {
  const name = String(courseName || '').replace(/\s+/g, ' ').trim()
  if (!name) return ''
  const limit = Math.max(3, Math.trunc(Number(maxLength) || 50))
  return `${name.slice(0, limit - 2)}考试`
}

function buildSchedulePayload(cfg, name, day) {
  if (!isValidDate(day)) throw new ApiError('创建日程需要有效的考试开始日期')
  const schedule = cfg.schedule || {}
  return {
    scheduleName: name,
    address: schedule.address || '',
    persons: schedule.persons || '',
    organizerId: schedule.organizerId || '',
    endDate: day,
    startDate: day,
    startTime: '09:00',
    endTime: '09:30',
    meetingId: schedule.meetingId || '',
    meetingName: schedule.meetingName || '',
    chatNotice: schedule.chatNotice ?? 1,
    remindNotice: schedule.remindNotice ?? 1,
    smsNotice: schedule.smsNotice ?? 0,
    emailNotice: schedule.emailNotice ?? 0,
    videoPower: schedule.videoPower ?? 0,
  }
}

function baseUrl(cfg) {
  return String(cfg.api.baseUrl || '').replace(/\/+$/, '')
}

/** 拉一页聊天记录（从 cursorMs 往回） */
async function fetchChatPage(cfg, token, cursorMs, log) {
  const { api, chat } = cfg
  const url = baseUrl(cfg) + api.chatRecordPath
  const payload = await httpJson({
    url,
    token,
    query: {
      from: chat.userId,
      endTime: Math.trunc(cursorMs),
      chatType: chat.chatType,
      isFirstScreen: 0,
      loadType: 0,
      groupId: chat.groupId,
    },
    timeout: Number(api.timeout) || 30000,
    retries: Number(api.retries) ?? 2,
    log,
  })

  if (String(payload.code) !== '200') {
    throw new ApiError(`聊天记录接口返回异常：code=${payload.code} message=${payload.message} traceId=${payload.traceId}`)
  }
  const data = payload.data
  if (!data || typeof data !== 'object') throw new ApiError('聊天记录接口 data 结构异常')
  const list = data.chat
  return Array.isArray(list) ? list : []
}

/** 从最新往回翻页，收集到今天零点的消息（按时间升序返回） */
async function collectMessages(cfg, token, log, { now = Date.now() } = {}) {
  const chat = cfg.chat
  const maxPages = Math.max(1, Number(chat.maxPages) || 10)
  const startMs = Date.parse(`${todayString(new Date(now))}T00:00:00+08:00`)

  let cursor = now + 60000
  const seen = new Map()
  let page = 0

  while (page < maxPages) {
    const batch = await fetchChatPage(cfg, token, cursor, log)
    page += 1
    if (!batch.length) {
      log('debug', `第 ${page} 页无数据，结束翻页`)
      break
    }

    let added = 0
    let oldest = null
    for (const msg of batch) {
      if (!msg || typeof msg !== 'object') continue
      const stamp = msgTimeMs(msg)
      if (stamp && (oldest === null || stamp < oldest)) oldest = stamp
      const key = messageKey(msg)
      if (seen.has(key)) continue
      seen.set(key, msg)
      added += 1
    }

    log('debug', `第 ${page} 页：返回 ${batch.length} 条，新增 ${added} 条`)
    if (added === 0 || oldest === null) break
    if (oldest < startMs) break
    cursor = oldest - 1
  }

  const messages = [...seen.values()].sort((a, b) => (msgTimeMs(a) || 0) - (msgTimeMs(b) || 0))
  log('info', `共获取 ${messages.length} 条不重复消息（翻页 ${page} 次）`)
  return messages
}

/** 取新版 SM4 传输密钥；失败返回 null，不阻断主流程 */
async function fetchTransferKey(cfg, token, log) {
  if (cfg.crypto && cfg.crypto.enableSm4 === false) return null
  const preset = String((cfg.crypto && cfg.crypto.transferKey) || '').trim()
  if (preset) {
    log('debug', '使用配置中的 transferKey')
    return preset
  }

  const { api } = cfg
  const url = baseUrl(cfg) + api.transferKeyPath
  let seed = ''
  for (let i = 0; i < 32; i += 1) seed += String(Math.floor(Math.random() * 10))
  const params = { busyId: seed, busyType: 2 }

  for (const mode of ['query', 'body']) {
    try {
      const response = await httpJson({
        url,
        token,
        query: mode === 'query' ? params : undefined,
        body: mode === 'body' ? params : undefined,
        timeout: Number(api.timeout) || 30000,
        retries: 0,
        log,
      })
      const data = response && response.data
      if (data && data.signal) return String(data.signal)
      log('debug', `transferKey（${mode}）未返回 signal`)
    } catch (error) {
      if (error instanceof AuthError) {
        log('warn', `获取 transferKey 失败（鉴权），将只走 SM2/明文解析：${error.message}`)
        return null
      }
      log('debug', `获取 transferKey（${mode}）失败：${error.message}`)
    }
  }
  log('warn', '获取 transferKey 失败，新版 SM4 消息可能无法解密')
  return null
}

async function createSchedule(cfg, token, name, day, log = () => {}) {
  const { api } = cfg
  const url = baseUrl(cfg) + api.scheduleAddPath
  const payload = buildSchedulePayload(cfg, name, day)
  log('info', `创建日程：${name} | ${day} ${payload.startTime}-${payload.endTime}`)

  const mode = String(api.scheduleBodyMode || 'json').toLowerCase()
  const common = {
    url, token, timeout: Number(api.timeout) || 30000, retries: 0, log,
  }
  let response
  if (mode === 'query') response = await httpJson({ ...common, query: payload })
  else if (mode === 'form') response = await httpJson({ ...common, form: payload })
  else response = await httpJson({ ...common, body: payload })

  const success = String(response.code) === '200' && response.success !== false
  if (!success) {
    throw new ApiError(`创建日程失败：code=${response.code} message=${response.message} traceId=${response.traceId}`)
  }
  return response
}

function emptyStats(total = 0) {
  return {
    total, today: 0, analyzed: 0, qualified: 0, created: 0, skipped: 0,
    failed: 0, aiFailed: 0, fetchFailed: 0, undecrypted: 0, names: [], events: [],
  }
}

/** 按群整理完整上下文；已创建消息仍须参与后续补充、取消和改期的判断。 */
async function processMessages(cfg, messages, token, state, options = {}) {
  const { log = () => {}, dryRun = false, onCreated, now = Date.now() } = options
  const chat = cfg.chat || {}
  const groupId = chat.groupId
  const today = todayString(new Date(now))
  const processed = state.processed || {}
  const examEvents = state.examEvents || {}
  const seenEvents = options.seenEvents || new Set()
  const skipTypes = new Set(chat.skipMsgTypes || [])
  const stats = emptyStats(messages.length)
  const context = { groupId, today, timeZone: TIME_ZONE, messages: [] }
  const cipherCtx = {
    sm2PrivateKey: String((cfg.crypto && cfg.crypto.sm2PrivateKey) || '').trim(),
    transferKey: cfg.crypto && cfg.crypto._transferKey,
    groupId,
  }
  const seenMessages = new Set()
  for (const msg of [...messages].sort((a, b) => (msgTimeMs(a) || 0) - (msgTimeMs(b) || 0))) {
    const id = messageKey(msg)
    if (seenMessages.has(id)) continue
    seenMessages.add(id)
    const stamp = msgTimeMs(msg)
    if (!stamp || !Number.isFinite(new Date(stamp).getTime())) {
      log('warn', `跳过（无有效时间戳）群=${groupId} msgId=${id}`)
      stats.skipped += 1
      continue
    }
    if (todayString(new Date(stamp)) !== today) {
      stats.skipped += 1
      continue
    }
    stats.today += 1
    if (skipTypes.has(Number(msg.msgType))) {
      stats.skipped += 1
      continue
    }
    const { text, how } = resolveContent(msg, cipherCtx)
    if (how === 'failed') {
      stats.undecrypted += 1
      stats.skipped += 1
      const reason = `密文无法解密，检查 sm2PrivateKey / transferKey（msgId=${id}）`
      log('warn', `群=${groupId} ${reason}`)
      stats.events.push({ groupId, status: 'failed', reason })
      continue
    }
    if (!text) {
      stats.skipped += 1
      continue
    }
    context.messages.push({ id, sentAt: `${formatTime(stamp).replace(' ', 'T')}+08:00`, text })
  }
  // 缺失的正文可能正是后续取消/改期，不能依据不完整上下文创建旧安排。
  if (stats.undecrypted > 0) {
    stats.failed += 1
    log('error', `群=${groupId} 当天消息存在解密失败，上下文不完整，本群本轮不创建日程`)
    return stats
  }
  if (!context.messages.length) {
    log('info', `群=${groupId} 当天无可分析的文本消息`)
    return stats
  }

  let analysis
  try {
    stats.analyzed = context.messages.length
    analysis = await (options.analyzeGroup || analyzeGroup)(cfg.defect || {}, context, { log })
    if (!analysis || !Array.isArray(analysis.events)) throw new Error('AI 未返回有效的课程判断数组')
  } catch (error) {
    const reason = `AI 分析失败：${error.message}`
    log('error', `群=${groupId} ${reason}`)
    stats.failed += 1
    stats.aiFailed += 1
    stats.events.push({ groupId, status: 'failed', reason })
    return stats
  }
  if (!analysis.events.length) log('info', `群=${groupId} AI 判断：当天没有可识别的课程考试通知`)

  for (const event of analysis.events) {
    const name = buildScheduleName(event.courseName, cfg.schedule && cfg.schedule.nameMaxLength)
    const report = { groupId, courseName: event.courseName, examStartDate: event.examStartDate,
      scheduleName: name, status: 'skipped', reason: event.reason }
    stats.events.push(report)
    log('info', `AI 判断 群=${groupId} 课程=${event.courseName || '未确定'} `
      + `开发参与=${event.includesDevelopers} 考试首日=${event.examStartDate || '未确定'} `
      + `状态=${event.status} 来源=${event.sourceMsgIds.join(',')} | ${event.reason}`)

    const prior = Object.values(examEvents).filter((entry) => entry && courseKey(entry.courseName) === courseKey(event.courseName))
    const legacySources = event.sourceMsgIds.filter((id) => Object.hasOwn(processed, id))
    if ((prior.length || legacySources.length) && ['cancelled', 'rescheduled'].includes(event.status)) {
      const priorDates = prior.length ? prior.map((entry) => entry.examStartDate).join('、') : '旧版本创建的日程'
      const note = `已建日程需人工处理：${priorDates}；不会自动修改或删除`
      report.reason += `；${note}`
      log('warn', `${name} ${note}`)
    }
    let skipReason = ''
    if (event.status === 'cancelled') {
      report.status = 'cancelled'
      skipReason = '课程考试已取消'
    } else if (!name) skipReason = '缺少课程名称'
    else if (event.includesDevelopers !== true) skipReason = '参与对象未确认包含开发'
    else if (!isValidDate(event.examStartDate)) skipReason = '缺少可确定的考试开始日期'
    else if (event.examStartDate < today) skipReason = '考试开始日期已过去'
    if (skipReason) {
      report.reason += `；${skipReason}`
      stats.skipped += 1
      log('info', `跳过 ${name || '未命名课程'}：${skipReason}`)
      continue
    }
    stats.qualified += 1
    const key = eventKey(event.courseName, event.examStartDate)
    // 新消息明确改期时可建新日期；不能因引用旧通知作上下文而一并拦截。
    const legacyDuplicate = legacySources.length > 0 && !(event.status === 'rescheduled'
      && event.sourceMsgIds.some((id) => !Object.hasOwn(processed, id)))
    if (Object.hasOwn(examEvents, key) || seenEvents.has(key) || legacyDuplicate) {
      report.status = 'duplicate'
      report.reason += '；该课程考试已创建，或来源消息已在旧版本处理'
      stats.skipped += 1
      log('info', `跳过 ${name} ${event.examStartDate}：已处理，避免重复创建`)
      continue
    }

    if (dryRun) {
      report.status = 'planned'
      seenEvents.add(key)
      stats.created += 1
      stats.names.push(name)
      log('info', `[试运行] 将创建 ${name} | ${event.examStartDate} 09:00-09:30`)
      continue
    }

    let response
    try {
      response = await (options.createSchedule || createSchedule)(cfg, token, name, event.examStartDate, log)
    } catch (error) {
      if (error instanceof AuthError) throw error
      report.status = 'failed'
      report.reason += `；创建日程失败：${error.message}`
      stats.failed += 1
      log('error', `${name} ${event.examStartDate} 创建失败：${error.message}`)
      continue
    }
    report.status = 'created'
    seenEvents.add(key)
    stats.created += 1
    stats.names.push(name)
    examEvents[key] = {
      courseName: event.courseName, examStartDate: event.examStartDate, scheduleName: name,
      groupId, sourceMsgIds: event.sourceMsgIds, traceId: response.traceId || '',
      date: today, at: formatTime(now),
    }
    state.examEvents = examEvents
    log('info', `创建成功：${name} | ${event.examStartDate} 09:00-09:30 traceId=${response.traceId || '-'}`)
    if (onCreated) await onCreated(state)
  }
  return stats
}

/** 每群独立获取、解密、分析，课程/考试日期跨群去重；单群失败不阻塞另一群。 */
async function runOnce(cfg, token, state, options = {}) {
  const { log = () => {}, now = Date.now() } = options
  const transferKey = await (options.fetchTransferKey || fetchTransferKey)(cfg, token, log)
  const stats = emptyStats()
  const seenEvents = new Set()
  for (const groupId of getGroupIds(cfg)) {
    const groupCfg = { ...cfg, chat: { ...cfg.chat, groupId },
      crypto: { ...cfg.crypto, _transferKey: transferKey } }
    let messages
    try {
      log('info', `获取当天聊天记录：群=${groupId}`)
      messages = await (options.collectMessages || collectMessages)(groupCfg, token, log, { now })
    } catch (error) {
      if (error instanceof AuthError) throw error
      const reason = `群消息获取失败：${error.message}`
      stats.failed += 1
      stats.fetchFailed += 1
      stats.events.push({ groupId, status: 'failed', reason })
      log('error', `群=${groupId} ${reason}`)
      continue
    }
    const result = await processMessages(groupCfg, messages, token, state, { ...options, log, now, seenEvents })
    for (const key of Object.keys(stats)) {
      if (Array.isArray(stats[key])) stats[key].push(...result[key])
      else stats[key] += result[key]
    }
  }
  return stats
}

module.exports = {
  todayString,
  formatTime,
  msgTimeMs,
  parseExtras,
  messageKey,
  getGroupIds,
  courseKey,
  eventKey,
  buildScheduleName,
  buildSchedulePayload,
  fetchChatPage,
  collectMessages,
  fetchTransferKey,
  createSchedule,
  processMessages,
  runOnce,
  classifyCipher,
}
