'use strict'
/**
 * 工单查询：先在待办列表里按单号定位（取出 iid 与标题），
 * 再取详情表单里的「内容详情」（nrxq）作为问题描述。
 */

const { httpJson, AuthError } = require('../exam/api')

class DefectError extends Error {
  constructor(message, hint = '') {
    super(message)
    this.name = 'DefectError'
    this.hint = hint
  }
}

/** 单号统一大写并去掉空白，避免输入时多敲空格。 */
function normalizeTicketNo(value) {
  return String(value == null ? '' : value).replace(/\s+/g, '').toUpperCase()
}

/** 从 thirdAppUrl（相对或绝对都行）里取 ?iid= 的值。 */
function extractIid(thirdAppUrl) {
  const text = String(thirdAppUrl || '')
  if (!text) return ''
  const match = /[?&]iid=([^&#]+)/i.exec(text)
  return match ? decodeURIComponent(match[1]).trim() : ''
}

function okCode(payload) {
  if (!payload || typeof payload !== 'object') return false
  const code = payload.code
  if (code === undefined || code === null || code === '') return true
  const text = String(code)
  return text === '200' || text === '0'
}

function describeFailure(payload) {
  if (!payload || typeof payload !== 'object') return '响应不是对象'
  const message = payload.message || payload.msg || ''
  if (message) return String(message)
  return JSON.stringify(payload).slice(0, 200)
}

async function requestJson(options) {
  try {
    return await httpJson(options)
  } catch (error) {
    if (error instanceof AuthError) {
      throw new DefectError('access-token 失效或无权访问工单接口',
        '请在微联叮客户端重新登录后，点「重新获取 Token」再试')
    }
    throw error
  }
}

/** 取一页待办。注意：pageNo / pageSize 必须放 query，放 body 会被服务端忽略。 */
async function fetchPendingPage(cfg, token, pageNo, log) {
  const payload = await requestJson({
    url: `${cfg.apiHost}${cfg.listPath}`,
    method: 'POST',
    token,
    query: {
      pageNo,
      pageSize: cfg.pageSize,
      sortRole: cfg.sortRole,
      applyState: cfg.applyState,
    },
    body: {},
    timeout: 30000,
    retries: 1,
    log,
  })
  if (!okCode(payload)) throw new DefectError(`查询工单列表失败：${describeFailure(payload)}`)
  const list = payload.data && payload.data.list
  return Array.isArray(list) ? list : []
}

/**
 * 在待办列表里找工单。
 * @returns {Promise<{ticketNo:string, iid:string, title:string, scanned:number}>}
 */
async function findTicket(cfg, token, ticketNo, { log = () => {} } = {}) {
  const target = normalizeTicketNo(ticketNo)
  if (!target) throw new DefectError('请先输入工单编号')

  const pageSize = Math.max(1, Number(cfg.pageSize) || 100)
  const maxTickets = Math.max(pageSize, Number(cfg.maxTickets) || pageSize)
  const maxPages = Math.max(1, Math.ceil(maxTickets / pageSize))

  let scanned = 0
  const seen = new Set()

  for (let pageNo = 1; pageNo <= maxPages; pageNo += 1) {
    const list = await fetchPendingPage(cfg, token, pageNo, log)
    if (!list.length) break

    let fresh = 0
    for (const item of list) {
      const itemNo = normalizeTicketNo(item && item.transactNo)
      const key = itemNo || String((item && item.thirdAppUrl) || '')
      if (key && seen.has(key)) continue
      if (key) seen.add(key)
      fresh += 1
      scanned += 1

      if (itemNo !== target) continue

      const iid = extractIid(item.thirdAppUrl)
      if (!iid) {
        throw new DefectError(`工单 ${target} 没有返回跳转地址，无法定位详情`,
          '该工单的 thirdAppUrl 为空，可能还没进入流程节点')
      }
      const title = String(item.applyName || '').trim()
      log('info', `工单已定位：${target}（${title || '无标题'}）`)
      return { ticketNo: target, iid, title, scanned }
    }

    // 返回不足一页、或整页都是见过的数据 → 已经没有更多
    if (list.length < pageSize || fresh === 0) break
    if (scanned >= maxTickets) break
  }

  throw new DefectError(`前 ${scanned} 条待办中没有找到工单 ${target}`,
    '该工单可能已办结、不在「待办」列表里，或编号输入有误')
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (value && typeof value === 'object' && typeof value.text === 'string' && value.text.trim()) {
      return value.text.trim()
    }
  }
  return ''
}

/**
 * 详情里的 prepareData.formData 是对象，其 model 是一段 JSON **字符串**，需要二次解析。
 * @returns {Array<object>|null}
 */
function parseModelFields(payload) {
  const formData = payload && payload.data && payload.data.prepareData
    && payload.data.prepareData.formData
  if (!formData || typeof formData !== 'object') return null

  const model = formData.model
  if (Array.isArray(model)) return model
  if (typeof model !== 'string' || !model.trim()) return null

  try {
    const parsed = JSON.parse(model)
    if (Array.isArray(parsed)) return parsed
    if (parsed && Array.isArray(parsed.model)) return parsed.model
  } catch (error) {
    return null
  }
  return null
}

/** 按 fieldName 取展示值：优先 fieldValueTwo，其次 fieldValue / fieldValueTitle。 */
function pickField(fields, fieldName) {
  if (!Array.isArray(fields)) return ''
  const hit = fields.find((item) => item && item.fieldName === fieldName)
  if (!hit) return ''
  return firstText(hit.fieldValueTwo, hit.fieldValue, hit.fieldValueTitle)
}

/** 取工单详情：问题描述（nrxq）+ 版本号（banbenhao）。 */
async function fetchTicketForm(cfg, token, iid, { log = () => {} } = {}) {
  const payload = await requestJson({
    url: `${cfg.apiHost}${cfg.detailPath}`,
    method: 'GET',
    token,
    query: { applyId: iid },
    timeout: 30000,
    retries: 1,
    log,
  })
  if (!okCode(payload)) throw new DefectError(`查询工单详情失败：${describeFailure(payload)}`)

  const fields = parseModelFields(payload)
  if (!fields) {
    log('warn', '工单详情里的 formData.model 无法解析，问题描述将为空')
  }
  const description = pickField(fields, 'nrxq')
  const version = pickField(fields, 'banbenhao')
  if (!description) log('warn', '工单详情里 nrxq（内容详情）为空')

  return { description, version, fieldCount: Array.isArray(fields) ? fields.length : 0 }
}

module.exports = {
  DefectError,
  okCode,
  describeFailure,
  normalizeTicketNo,
  extractIid,
  fetchPendingPage,
  findTicket,
  parseModelFields,
  pickField,
  fetchTicketForm,
}
