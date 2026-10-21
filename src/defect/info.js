'use strict'
/**
 * 确认提交：把工单总结的四个字段填进 CMS 的「新建信息数据」入参并提交。
 *
 * 模板来自 RPA 抓到的 info/add 请求，除下列位置外一律保持原样：
 *   title / jsonTitle / titleText、elementList 的 biaoti / gdwtmx / gdfxgc / gdclcsjlj、
 *   extendsEntity.infoContent（必须跟着 elementList 重新序列化），
 *   以及 iid（客户端生成的 uuid4）、deployTime（当前时间）、author / source / webId / columnId。
 */

const crypto = require('node:crypto')
const { httpJson, AuthError } = require('../exam/api')
const { DefectError, okCode, describeFailure } = require('./ticket')

/** 示例里富文本 <span> 的内联样式，保持与 CMS 编辑器产出一致。 */
const SPAN_STYLE = 'color: rgba(0, 0, 0, 0.85); '
  + 'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", '
  + '"Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif, '
  + '"Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol"; font-size: 14px; '
  + 'text-wrap-mode: wrap; background-color: rgb(255, 255, 255);'

const DEFAULT_WEB_ID = '2bdebd6aee3f40668668dbddbee2e15f'
const DEFAULT_COLUMN_ID = 'EQdL5HW2wo07vWzVjsxYr'
const DEFAULT_SOURCE = '产品研发一部'

function wrap(text) {
  return `<p><span style="${SPAN_STYLE}">${escapeHtml(text)}</span></p>`
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 纯文本 → CMS 富文本：一行一个 <p><span>，空行丢弃。 */
function toRichText(text) {
  const lines = String(text == null ? '' : text)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
  if (!lines.length) return ''
  return lines.map(wrap).join('')
}

/** 32 位小写 hex 的 uuid4，与示例 iid 同构（前端生成主键）。 */
function newIid() {
  try {
    return crypto.randomUUID().replace(/-/g, '')
  } catch (error) {
    return crypto.randomBytes(16).toString('hex')
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)))
}

function element(fieldTitle, fieldName, fieldType, fieldValue) {
  return { fieldTitle, fieldName, fieldType, fieldValue, isEncrypt: 0 }
}

/**
 * 生成一份全新的入参模板（每次调用都是新对象，避免互相污染）。
 * @param {object} cfg config.defect
 */
function buildTemplate(cfg = {}) {
  const webId = cfg.infoWebId || DEFAULT_WEB_ID
  const columnId = cfg.infoColumnId || DEFAULT_COLUMN_ID

  const elementList = [
    element('标题', 'biaoti', 'Input', '标题'),
    element('工单类型', 'gongdlx', 'Select', 'pSrHI3jbsOVgimdLIA9pj'),
    element('工单涉及产品', 'gdsjcp3', 'SelectTree', 'bRiqpzeRXTLHQosPhut1u'),
    element('工单问题类型', 'gdwtlx', 'Select', 'TTqxopCq35Ngw61qTGlRj'),
    element('工单问题描述', 'gdwtmx', 'Textarea', '工单问题描述'),
    element('工单分析过程', 'gdfxgc', 'Text', wrap('工单分析过程')),
    element('工单处理措施及更新包提交路径', 'gdclcsjlj', 'Text', wrap('工单处理措施及更新包提交路径')),
  ]

  return {
    beQuoteMss: 0,
    thirdTitle: '',
    secTitle: '',
    originTitle: '',
    linkUrl: '',
    webId,
    columnId,
    beLink: 0,
    beComment: 1,
    beXxgk: 0,
    title: JSON.stringify({ text: '大标题', style: {} }),
    titleStyle: {},
    titleText: '大标题',
    contentAttributeEntity: {
      webId,
      columnId,
      graphic: 0,
      video: 0,
      audio: 0,
      atlas: 0,
      file: 0,
      videos: 0,
    },
    iid: newIid(),
    dimensionTagList: [],
    extendsEntity: {
      elementList,
      infoContent: JSON.stringify(elementList),
      weixinCon: JSON.stringify({ content: '', pic: '', describe: '' }),
      weiboCon: JSON.stringify({ content: '', pic: '' }),
    },
    author: '',
    source: DEFAULT_SOURCE,
    keyWord: '',
    xxgkAttributeEntity: {},
    picPath: '',
    releaseTime: 0,
    revokeTime: 0,
    deployTime: Date.now(),
    msgRemindWay: '',
    infoScore: 0,
    picScore: 0,
    checkPic: true,
    checkWord: true,
    firstPublishTime: 0,
    beOriginal: null,
    contentDescribe: '',
    beMsgRemind: 0,
    deployTimeType: 0,
    jsonTitle: JSON.stringify({ text: '大标题', style: {} }),
    picPathBig: '',
    picPathSmall: '',
    relativeForAdd: '[]',
    oprType: '',
    wxCheckWord: 0,
  }
}

function setFieldValue(elementList, fieldName, value) {
  const target = elementList.find((item) => item && item.fieldName === fieldName)
  if (target) target.fieldValue = value
  return target
}

/**
 * 用四个字段生成实际提交的入参。纯函数，便于自检。
 * @param {object} options
 * @param {{title?:string, description?:string, analysis?:string, measures?:string}} options.fields
 * @param {string} [options.ticketNo]  标题为空时的兜底
 * @param {object} [options.cfg]       config.defect
 * @param {number} [options.now]       便于测试的当前时间
 */
function buildInfoPayload({ fields = {}, ticketNo = '', cfg = {}, now = Date.now() } = {}) {
  const payload = buildTemplate(cfg)
  const title = String(fields.title || '').trim() || String(ticketNo || '').trim()
  const titleJson = JSON.stringify({ text: title, style: {} })

  payload.title = titleJson
  payload.jsonTitle = titleJson
  payload.titleText = title
  payload.deployTime = Number(now) || Date.now()
  payload.author = String(cfg.infoAuthor || cfg.gitName || '')
  payload.source = String(cfg.infoSource || DEFAULT_SOURCE)

  // 不带 state 建出来的是「待发布草稿」，信息列表里查不到、文章地址也打不开；
  // 示例请求体正是草稿保存时的入参，所以这里补上发布状态与三个时间戳。
  if (cfg.infoPublish !== false) {
    payload.state = 'published'
    payload.releaseTime = payload.deployTime
    payload.publishTime = payload.deployTime
    payload.firstPublishTime = payload.deployTime
  }

  const elementList = payload.extendsEntity.elementList
  setFieldValue(elementList, 'biaoti', title)
  setFieldValue(elementList, 'gdwtmx', String(fields.description == null ? '' : fields.description))
  setFieldValue(elementList, 'gdfxgc', toRichText(fields.analysis))
  setFieldValue(elementList, 'gdclcsjlj', toRichText(fields.measures))
  payload.extendsEntity.infoContent = JSON.stringify(elementList)

  return payload
}

/**
 * 从信息列表的响应里按 iid 找这一条，取它的 fullUrl。
 * @param {object} response  info/list 的响应体
 * @param {string} iid
 * @returns {{url:string, state:string, title:string, found:boolean}}
 */
function parseInfoList(response, iid) {
  const target = String(iid || '')
  const list = (response && response.data && response.data.list) || []
  const empty = { url: '', state: '', title: '', found: false }
  if (!target || !Array.isArray(list) || !list.length) return empty

  for (const item of list) {
    if (!item || String(item.iid || '') !== target) continue
    return {
      url: String(item.fullUrl || item.url || ''),
      state: String(item.state || ''),
      title: String(item.titleText || ''),
      found: true,
    }
  }
  return empty
}

/**
 * 查信息列表，拿到刚创建那条的 fullUrl（发布后才有值）。
 * 刚发布时列表可能还没刷出来，所以默认小幅重试几次。
 * @returns {Promise<{url:string, state:string, title:string, found:boolean}>}
 */
async function fetchInfoUrl(cfg = {}, token, iid, { log = () => {}, attempts = 3, delayMs = 900 } = {}) {
  const host = String(cfg.apiHost || '').replace(/\/+$/, '')
  const listPath = cfg.infoListPath || '/api-gateway/jpaas-cms-server/manager/info/list'
  const url = `${host}${listPath}`
  const query = {
    pageSize: 10,
    pageNo: 1,
    webId: cfg.infoWebId || DEFAULT_WEB_ID,
    columnId: cfg.infoColumnId || DEFAULT_COLUMN_ID,
  }

  const total = Math.max(1, Number(attempts) || 1)
  let last = { url: '', state: '', title: '', found: false }

  for (let index = 1; index <= total; index += 1) {
    let response
    try {
      // 分页参数必须放 query，放 body 服务端会直接 500「系统错误」
      response = await httpJson({
        url, method: 'POST', token, query, body: {},
        timeout: Number(cfg.infoTimeoutMs) || 30000, retries: 0,
      })
    } catch (error) {
      if (error instanceof AuthError) {
        throw new DefectError('access-token 失效或无权查询信息列表',
          '请在微联叮客户端重新登录，点「重新获取 Token」后再试')
      }
      log('warn', `查询信息地址失败（第 ${index} 次）：${error.message}`)
      if (index === total) {
        throw new DefectError(`查询信息地址失败：${error.message}`, '接口超时或网络异常，可稍后点「重新获取地址」')
      }
      await sleep(delayMs)
      continue
    }

    last = parseInfoList(response, iid)
    if (last.url) {
      log('info', `信息地址已获取：${last.url}`)
      return last
    }
    if (index < total) await sleep(delayMs)
  }

  return last
}

/**
 * 真正调用新建信息数据接口。
 * @returns {Promise<{ok:boolean, iid:string, raw:object}>}
 */
async function submitInfo(cfg = {}, token, payload, { log = () => {} } = {}) {
  const host = String(cfg.apiHost || '').replace(/\/+$/, '')
  const addPath = cfg.infoAddPath || '/api-gateway/jpaas-cms-server/manager/info/add'
  const url = `${host}${addPath}`

  log('info', `提交信息数据：${url}（标题「${String(payload.titleText || '').slice(0, 40)}」，iid ${payload.iid}）`)

  let response
  try {
    response = await httpJson({
      url,
      method: 'POST',
      token,
      body: payload,
      timeout: Number(cfg.infoTimeoutMs) || 30000,
      retries: 1,
      log,
    })
  } catch (error) {
    if (error instanceof AuthError) {
      throw new DefectError('access-token 失效或无权创建信息数据',
        '请在微联叮客户端重新登录，点「重新获取 Token」后再点「生成总结」')
    }
    throw new DefectError(`提交信息数据失败：${error.message}`,
      '接口超时或网络异常，可稍后点「重新获取地址」确认是否已创建')
  }

  if (!okCode(response)) {
    throw new DefectError(`提交信息数据失败：${describeFailure(response)}`,
      '接口返回非成功状态，可核对日志里的响应后再试')
  }

  const data = (response && response.data) || {}
  const iid = String(data.iid || data.id || data.infoId || payload.iid || '')
  log('info', `信息数据已生成：${iid}`)

  return { ok: true, iid, raw: response }
}

module.exports = {
  SPAN_STYLE,
  DEFAULT_WEB_ID,
  DEFAULT_COLUMN_ID,
  escapeHtml,
  toRichText,
  newIid,
  buildTemplate,
  buildInfoPayload,
  parseInfoList,
  fetchInfoUrl,
  submitInfo,
}
