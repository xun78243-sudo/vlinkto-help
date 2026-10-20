'use strict'
/**
 * 考试日程核心业务：拉聊天记录 -> 解密 -> 规则判定 -> 建日程。
 * 与 exam_schedule.py 的判定完全一致。
 */

const { sm3 } = require('./crypto')
const { resolveContent, classifyCipher } = require('./im')
const { httpJson, AuthError, ApiError } = require('./api')

const AT_ALL_PATTERNS = ['{"all":true}', '{"all":"true"}']
const RE_AT_MENTION = /@_(?:\{[^}]*\}|[^@]{1,40})_@/g
const RE_WHITESPACE = /\s+/g

function pad2(value) {
  return String(value).padStart(2, '0')
}

function todayString(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function formatTime(stamp) {
  const d = new Date(stamp)
  return `${todayString(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
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

/** 部门匹配：先精确、再包含（兼容「人力资源部（总部）」这类写法） */
function matchDepartment(sendGroup, deptNames) {
  if (!sendGroup) return ''
  for (const name of deptNames) if (name && sendGroup === name) return name
  for (const name of deptNames) if (name && sendGroup.includes(name)) return name
  return ''
}

/** @returns {{ ok: boolean, detail: string }} */
function isQualified(text, rules) {
  const excludeHits = (rules.excludeKeywords || []).filter((w) => w && text.includes(w))
  if (excludeHits.length) return { ok: false, detail: `命中排除词 ${excludeHits.join('/')}` }

  const eventHits = (rules.eventKeywords || []).filter((w) => w && text.includes(w))
  if (!eventHits.length) return { ok: false, detail: '无考试/培训类关键词' }

  const audienceHits = (rules.audienceKeywords || []).filter((w) => w && text.includes(w))
  if (AT_ALL_PATTERNS.some((pattern) => text.includes(pattern))) audienceHits.push('@所有人')
  if (!audienceHits.length && rules.requireAudienceKeyword !== false) {
    return { ok: false, detail: `命中关键词 ${eventHits.join('/')}，但未要求所有人/所有开发参与` }
  }

  let detail = `关键词 ${eventHits.join('/')}`
  if (audienceHits.length) detail += `；受众 ${audienceHits.join('/')}`
  return { ok: true, detail }
}

/** 标题：先剥 @提醒标记，再取第一行，截断到 maxLength */
function buildScheduleName(text, maxLength) {
  let value = String(text || '').replace(RE_AT_MENTION, ' ')
  for (const pattern of AT_ALL_PATTERNS) value = value.split(pattern).join('所有人')

  let title = ''
  for (const line of value.split(/\r?\n/)) {
    const normalized = line.replace(RE_WHITESPACE, ' ').trim()
    if (normalized) {
      title = normalized
      break
    }
  }
  if (!title) title = value.replace(RE_WHITESPACE, ' ').trim()
  return title.slice(0, maxLength)
}

function buildSchedulePayload(cfg, name, day) {
  const schedule = cfg.schedule || {}
  return {
    scheduleName: name,
    address: schedule.address || '',
    persons: schedule.persons || '',
    organizerId: schedule.organizerId || '',
    endDate: day,
    startDate: day,
    startTime: schedule.startTime || '17:00',
    endTime: schedule.endTime || '17:30',
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
async function collectMessages(cfg, token, log) {
  const chat = cfg.chat
  const maxPages = Math.max(1, Number(chat.maxPages) || 10)
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const startMs = todayStart.getTime()

  let cursor = Date.now() + 60000
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

async function createSchedule(cfg, token, name, log) {
  const { api } = cfg
  const day = todayString()
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

/**
 * 处理消息：判定 + 建日程。
 * @returns {Promise<object>} stats
 */
async function processMessages(cfg, messages, token, state, options = {}) {
  const { log = () => {}, dryRun = false, force = false, onCreated } = options
  const rules = cfg.rules || {}
  const chat = cfg.chat || {}
  const schedule = cfg.schedule || {}
  const deptNames = (chat.senderGroupNames || []).filter(Boolean)
  const skipTypes = new Set(chat.skipMsgTypes || [])
  const today = todayString()
  const processed = state.processed || (state.processed = {})

  const stats = {
    total: messages.length, dept: 0, today: 0, qualified: 0,
    created: 0, skipped: 0, failed: 0, undecrypted: 0, names: [],
  }

  const cipherCtx = {
    sm2PrivateKey: String((cfg.crypto && cfg.crypto.sm2PrivateKey) || '').trim(),
    transferKey: cfg.crypto && cfg.crypto._transferKey,
    groupId: chat.groupId,
  }

  for (const msg of messages) {
    const msgId = messageKey(msg)
    const stamp = msgTimeMs(msg)
    const when = stamp ? formatTime(stamp) : '未知时间'

    // 1) 只看指定部门的发言
    const extras = parseExtras(msg)
    const sendGroup = String(extras.sendGroupName || '').trim()
    if (!matchDepartment(sendGroup, deptNames)) continue
    stats.dept += 1

    // 2) 只看当天发布的消息
    if (!stamp) {
      log('warn', `跳过（无时间戳）msgId=${msgId}`)
      stats.skipped += 1
      continue
    }
    if (todayString(new Date(stamp)) !== today) {
      log('debug', `跳过（非当天 ${when}）msgId=${msgId}`)
      stats.skipped += 1
      continue
    }
    stats.today += 1

    // 3) 非文本消息跳过
    const msgType = msg.msgType === undefined || msg.msgType === null ? null : Number(msg.msgType)
    if (msgType !== null && Number.isFinite(msgType) && skipTypes.has(msgType)) {
      log('debug', `跳过（非文本消息 type=${msg.msgType}）msgId=${msgId}`)
      stats.skipped += 1
      continue
    }

    // 4) 解密正文
    const { text, how } = resolveContent(msg, cipherCtx)
    if (!text) {
      log('debug', `跳过（正文为空）msgId=${msgId}`)
      stats.skipped += 1
      continue
    }
    if (how === 'failed') {
      stats.undecrypted += 1
      stats.skipped += 1
      log('warn', `跳过（密文无法解密，检查 sm2PrivateKey / transferKey）msgId=${msgId}`)
      continue
    }

    // 5) 关键词与受众
    const verdict = isQualified(text, rules)
    if (!verdict.ok) {
      log('debug', `跳过（${verdict.detail}）msgId=${msgId}`)
      stats.skipped += 1
      continue
    }
    stats.qualified += 1

    const name = buildScheduleName(text, Number(schedule.nameMaxLength) || 50)
    if (!name) {
      log('warn', `跳过（标题为空）msgId=${msgId}`)
      stats.skipped += 1
      continue
    }

    log('info', `命中消息 msgId=${msgId} 发布=${when} 解密=${how} | ${verdict.detail}`)
    log('info', `  └ 标题：${name}`)

    // 6) 幂等
    if (msgId && processed[msgId] && !force) {
      log('info', '  └ 已处理过，跳过')
      stats.skipped += 1
      continue
    }

    if (dryRun) {
      log('info', `  └ [试运行] 将创建日程 ${today} ${schedule.startTime || '17:00'}-${schedule.endTime || '17:30'}`)
      stats.created += 1
      stats.names.push(name)
      continue
    }

    // 7) 建日程
    let response
    try {
      response = await createSchedule(cfg, token, name, log)
    } catch (error) {
      if (error instanceof AuthError) throw error
      log('error', `  └ 创建失败：${error.message}`)
      stats.failed += 1
      continue
    }

    stats.created += 1
    stats.names.push(name)
    log('info', `  └ 创建成功 traceId=${response.traceId || '-'}`)
    if (msgId) {
      processed[msgId] = {
        date: today,
        scheduleName: name,
        traceId: response.traceId || '',
        at: formatTime(Date.now()),
      }
      if (onCreated) await onCreated(state)
    }
  }

  return stats
}

/** 完整跑一轮：取 transferKey -> 拉消息 -> 判定 -> 建日程 */
async function runOnce(cfg, token, state, options = {}) {
  const { log = () => {}, onCreated } = options
  cfg.crypto = cfg.crypto || {}
  cfg.crypto._transferKey = await fetchTransferKey(cfg, token, log)
  const messages = await collectMessages(cfg, token, log)
  return processMessages(cfg, messages, token, state, { ...options, onCreated })
}

module.exports = {
  todayString,
  formatTime,
  msgTimeMs,
  parseExtras,
  messageKey,
  matchDepartment,
  isQualified,
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
