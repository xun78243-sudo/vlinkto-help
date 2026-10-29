'use strict'
/** 考试日程离线回归：AI / 聊天接口 / 日程接口全部使用替身，不读取真实 token。 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const chat = require('../src/exam/chat')
const ai = require('../src/exam/ai')
const store = require('../src/config')
const im = require('../src/exam/im')
const crypto = require('../src/exam/crypto')
const { AuthError } = require('../src/exam/api')

const GROUPS = ['cda6b214bd004867a1e46af520ad8696', '863201152f0848cb83b203f0314075a2']
const NOW = Date.parse('2026-10-29T14:00:00+08:00')

function configuration() {
  const cfg = store.clone(store.DEFAULTS)
  cfg.api.baseUrl = 'https://exam.test'
  cfg.api.retries = 0
  return cfg
}

function message(id = 'm1', content = '数据安全：全体员工参加，考试时间10月30日至11月1日。', time = NOW) {
  return { msgId: id, content, time, msgType: 5, extras: { sendGroupName: '产品研发一部' } }
}

function event(overrides = {}) {
  return {
    courseName: '数据安全', includesDevelopers: true, examStartDate: '2026-10-30',
    status: 'active', sourceMsgIds: ['m1'], reason: '全体员工包含开发，考试开始日为10月30日',
    ...overrides,
  }
}

function context(messages = [{ id: 'm1', sentAt: '2026-10-29 14:00:00', text: message().content }]) {
  return { groupId: GROUPS[0], today: '2026-10-29', timeZone: 'Asia/Hong_Kong', messages }
}

async function process({ cfg = configuration(), messages = [message()], events = [event()], state = {}, options = {} } = {}) {
  const calls = []
  const contexts = []
  const logs = []
  const stats = await chat.processMessages(cfg, messages, 'test-token', state, {
    now: NOW,
    log: (level, text) => logs.push({ level, text }),
    analyzeGroup: async (aiCfg, input) => {
      assert.equal(aiCfg.aiModel, cfg.defect.aiModel)
      contexts.push(input)
      return { events }
    },
    createSchedule: async (inputCfg, token, name, day) => {
      assert.equal(token, 'test-token')
      calls.push({ name, day, payload: chat.buildSchedulePayload(inputCfg, name, day) })
      return { code: 200, traceId: 'test-trace' }
    },
    ...options,
  })
  return { stats, calls, contexts, logs, state }
}

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) }
}

// Produce independently encrypted fixtures so group-specific SM4 derivation is exercised.
function encryptedMessage(id, text, groupId, transferKey) {
  const { encKey, macKey } = im.deriveTransferKeys(`${id}${groupId}${transferKey}`)
  const iv = Buffer.alloc(16, 7)
  const plain = Buffer.from(text)
  const padding = 16 - plain.length % 16
  const padded = Buffer.concat([plain, Buffer.alloc(padding, padding)])
  const blocks = []
  let previous = iv
  for (let offset = 0; offset < padded.length; offset += 16) {
    previous = crypto.sm4EncryptBlock(crypto.xorBytes(padded.subarray(offset, offset + 16), previous), encKey)
    blocks.push(previous)
  }
  const body = Buffer.concat([iv, ...blocks])
  return message(id, Buffer.concat([body, crypto.hmacSm3(macKey, body)]).toString('base64'))
}

test('旧群配置升级后保留原群；显式群列表去重且优先', () => {
  assert.deepEqual(store.getGroupIds(store.DEFAULTS), GROUPS)
  assert.deepEqual(store.getGroupIds({ chat: { groupId: 'custom' } }), ['custom', GROUPS[1]])
  assert.deepEqual(store.getGroupIds({ chat: { groupId: 'legacy', groupIds: [' custom ', 'custom', '', GROUPS[1]] } }),
    ['custom', GROUPS[1]])
})

test('实际加载旧配置保留群和其他设置，旧17点配置不改变考试时间', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-config-'))
  try {
    fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({
      chat: { groupId: 'legacy-custom' }, schedule: { startTime: '17:00', endTime: '17:30', persons: 'user-test' },
      defect: { aiModel: 'custom-model' },
    }))
    const cfg = store.loadConfig(directory)
    assert.deepEqual(store.getGroupIds(cfg), ['legacy-custom', GROUPS[1]])
    assert.equal(cfg.defect.aiModel, 'custom-model')
    const payload = chat.buildSchedulePayload(cfg, '数据安全考试', '2027-01-02')
    assert.equal(payload.persons, 'user-test')
    assert.equal(payload.startDate, '2027-01-02')
    assert.equal(payload.endDate, '2027-01-02')
    assert.equal(payload.startTime, '09:00')
    assert.equal(payload.endTime, '09:30')
  } finally {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()))
    assert.ok(path.basename(directory).startsWith('exam-config-'))
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('日期始终按香港时区，午夜与跨年不依赖主机时区', () => {
  assert.equal(chat.todayString(new Date('2026-10-28T16:00:00Z')), '2026-10-29')
  assert.equal(chat.todayString(new Date('2026-12-31T16:00:00Z')), '2027-01-01')
  assert.equal(chat.formatTime(Date.parse('2026-10-28T16:01:02Z')), '2026-10-29 00:01:02')
})

test('非人力部门及没有旧关键词的文本完整送给AI，使用明确考试日创建', async () => {
  const text = '《JVM内存》\n参与人员：后端同学；测验窗口：10月30日—11月1日。'
  const result = await process({ messages: [message('m1', text)], events: [event({ courseName: 'JVM内存' })] })
  assert.equal(result.contexts.length, 1)
  assert.equal(result.contexts[0].messages[0].text, text)
  assert.equal(result.contexts[0].messages[0].id, 'm1')
  assert.equal(result.contexts[0].messages[0].sentAt, '2026-10-29T14:00:00+08:00')
  assert.equal(result.contexts[0].timeZone, 'Asia/Hong_Kong')
  assert.equal(result.contexts[0].today, '2026-10-29')
  assert.equal(result.stats.analyzed, 1)
  assert.equal(result.stats.created, 1)
  assert.equal(result.calls[0].day, '2026-10-30')
  assert.equal(result.calls[0].payload.startTime, '09:00')
  assert.equal(result.calls[0].payload.endTime, '09:30')
  assert.equal(result.calls[0].name, 'JVM内存考试')
})

test('课程、受众、日期跨消息补充时升序传入全部当天上下文；已处理消息仍参与分析', async () => {
  const messages = [
    message('m3', '时间补充：考试明天开放，截止11月1日。', NOW),
    message('m1', '课程：《数据安全》。', NOW - 120000),
    message('m2', '参与人员：全体员工。', NOW - 60000),
    message('old', '昨天的内容', Date.parse('2026-10-28T23:59:59+08:00')),
  ]
  const result = await process({ messages, state: { processed: { m1: { date: '2026-10-28' } } },
    events: [event({ sourceMsgIds: ['m1', 'm2', 'm3'] })] })
  assert.deepEqual(result.contexts[0].messages.map((item) => item.id), ['m1', 'm2', 'm3'])
  assert.equal(result.stats.today, 3)
  assert.equal(result.stats.analyzed, 3)
  assert.equal(result.calls.length, 0, '历史已建消息不重复创建')
})

test('同一条消息中的多门课程都创建，不因消息级记账遗漏后续课程', async () => {
  const state = { processed: {} }
  let saves = 0
  const result = await process({ state, events: [event(), event({ courseName: '研发规范' })],
    options: { onCreated: async () => { saves += 1 } } })
  assert.equal(result.calls.length, 2)
  assert.equal(Object.keys(state.examEvents).length, 2)
  assert.deepEqual(state.processed, {})
  assert.equal(saves, 2)
})

test('AI语义结果决定是否创建：全员和研发符合，行政、排除开发、仅@所有人不符合', async (t) => {
  for (const [audience, includesDevelopers] of [
    ['全体员工', true], ['研发人员', true], ['前端和后端', true],
    ['仅行政人员', false], ['除开发岗位以外', false], ['@_{"all":true}_@ 请相关人员参加', false],
  ]) {
    await t.test(audience, async () => {
      const text = `课程名称：信息安全；参与人员：${audience}；考试时间：2026-10-30。`
      const result = await process({ messages: [message('m1', text)], events: [event({ includesDevelopers })] })
      assert.equal(result.contexts[0].messages[0].text, text)
      assert.equal(result.calls.length, includesDevelopers ? 1 : 0)
    })
  }
})

test('只有培训日期、无课程名或已过去的考试日均跳过，不使用当天兜底', async () => {
  const result = await process({ events: [
    event({ examStartDate: null, reason: '仅提供培训日期，未提供考试日期' }),
    event({ courseName: '', reason: '没有明确课程名称' }),
    event({ courseName: '历史考试', examStartDate: '2026-10-28', reason: '考试日期已过' }),
    event({ courseName: '行政课程', includesDevelopers: false, reason: '仅行政参加' }),
  ] })
  assert.equal(result.calls.length, 0)
  assert.equal(result.stats.created, 0)
  assert.deepEqual(result.state, {})
  assert.ok(result.logs.some((item) => item.text.includes('培训日期')))
})

test('当天即使已经过09:00仍创建当天09:00，而不是明天或当前时刻', async () => {
  const result = await process({ events: [event({ examStartDate: '2026-10-29' })] })
  assert.equal(result.calls[0].day, '2026-10-29')
  assert.equal(result.calls[0].payload.startTime, '09:00')
})

test('同轮后续取消和改期由AI最终结果执行，不先创建旧日期', async () => {
  const messages = [message(), message('m2', '上述课程取消。'), message('m3', '另一课程考试改到11月2日。')]
  const result = await process({ messages, events: [
    event({ status: 'cancelled', sourceMsgIds: ['m1', 'm2'], reason: '后续通知取消' }),
    event({ courseName: '研发规范', status: 'rescheduled', examStartDate: '2026-11-02', sourceMsgIds: ['m3'], reason: '改至11月2日' }),
  ] })
  assert.equal(result.contexts[0].messages.length, 3)
  assert.equal(result.calls.length, 1)
  assert.equal(result.calls[0].day, '2026-11-02')
  assert.equal(result.calls[0].name, '研发规范考试')
})

test('已创建后收到取消时仅提示人工处理，不修改或删除旧日程', async () => {
  const state = {}
  await process({ state })
  const before = structuredClone(state)
  const result = await process({ state, events: [event({ status: 'cancelled', reason: '课程取消' })] })
  assert.equal(result.calls.length, 0)
  assert.deepEqual(state, before)
  assert.ok(result.logs.some((item) => item.level === 'warn' && item.text.includes('数据安全')))
})

test('已创建后收到改期时创建新日期，保留旧记录并提示人工处理', async () => {
  const state = {}
  await process({ state })
  const result = await process({ state, events: [event({ status: 'rescheduled', examStartDate: '2026-11-02', reason: '考试改至11月2日' })] })
  assert.deepEqual(result.calls.map((item) => item.day), ['2026-11-02'])
  assert.equal(Object.keys(state.examEvents).length, 2)
  assert.ok(result.logs.some((item) => item.level === 'warn' && item.text.includes('数据安全')))
})

test('旧processed仍用于去重，但新补充消息明确改期时允许创建新日期', async () => {
  const state = { processed: { m1: { date: '2026-10-29', scheduleName: '旧版通知首行' } } }
  const messages = [message(), message('m2', '数据安全考试改至11月2日。')]
  const freshCorrection = await process({ state, messages, events: [event({
    status: 'rescheduled', examStartDate: '2026-11-02', sourceMsgIds: ['m1', 'm2'], reason: '后续明确改期',
  })] })
  assert.deepEqual(freshCorrection.calls.map((item) => item.day), ['2026-11-02'])
  assert.ok(freshCorrection.logs.some((item) => item.level === 'warn'))
  assert.deepEqual(state.processed.m1, { date: '2026-10-29', scheduleName: '旧版通知首行' })
  const oldOnly = await process({ state: { processed: structuredClone(state.processed) }, events: [event({
    status: 'rescheduled', examStartDate: '2026-11-03', reason: '历史改期消息',
  })] })
  assert.equal(oldOnly.calls.length, 0, '全部来源都已在旧版处理时不重建')
})

test('同课同日规范化去重，重复运行不会再创建', async () => {
  assert.equal(chat.eventKey('《ＡＰＩ 设计》', '2026-10-30'), chat.eventKey('api设计', '2026-10-30'))
  const state = {}
  const first = await process({ state, events: [event({ courseName: '《ＡＰＩ 设计》' })] })
  assert.equal(first.calls.length, 1)
  const second = await process({ state, events: [event({ courseName: 'api设计' })] })
  assert.equal(second.calls.length, 0)
  assert.equal(Object.keys(state.examEvents).length, 1)
})

test('部分创建失败只记账成功事件，下轮仅重试失败事件', async () => {
  const state = {}
  const events = [event(), event({ courseName: '研发规范' })]
  const first = await process({ state, events, options: {
    createSchedule: async (_cfg, _token, name) => {
      if (name === '研发规范考试') throw new Error('日程服务暂时不可用')
      return { code: 200, traceId: 'first-success' }
    },
  } })
  assert.equal(first.stats.created, 1)
  assert.equal(first.stats.failed, 1)
  assert.equal(Object.keys(state.examEvents).length, 1)
  const retry = await process({ state, events })
  assert.deepEqual(retry.calls.map((item) => item.name), ['研发规范考试'])
  assert.equal(Object.keys(state.examEvents).length, 2)
})

test('试运行会调用AI并展示日期，但不调用创建接口、不更改任何状态', async () => {
  const state = { processed: {} }
  const before = structuredClone(state)
  const result = await process({ state, events: [event(), event()], options: { dryRun: true } })
  assert.equal(result.contexts.length, 1)
  assert.equal(result.calls.length, 0)
  assert.equal(result.stats.created, 1, '试运行也去重')
  assert.deepEqual(state, before)
  assert.ok(result.logs.some((item) => item.text.includes('2026-10-30') && item.text.includes('09:00')))
})

test('AI超时或非法结果不创建不记账，下一轮仍可重试', async () => {
  const state = {}
  const result = await process({ state, options: { analyzeGroup: async () => { throw new Error('AI服务超时') } } })
  assert.equal(result.stats.failed, 1)
  assert.equal(result.stats.aiFailed, 1)
  assert.equal(result.calls.length, 0)
  assert.deepEqual(state, {})
  const retry = await process({ state })
  assert.equal(retry.stats.created, 1)
})

test('所有消息均非当天或非文本时不调用AI', async () => {
  const result = await process({ messages: [
    message('old', '昨天的通知', NOW - 86400000),
    { ...message('image'), msgType: 1 },
    { ...message('no-time'), time: undefined },
  ] })
  assert.equal(result.contexts.length, 0)
  assert.equal(result.calls.length, 0)
})

test('解密失败有独立计数，不把密文交给AI', async () => {
  const cfg = configuration()
  cfg.crypto.sm2PrivateKey = ''
  const result = await process({ cfg, messages: [message('bad', Buffer.alloc(96).toString('base64'))] })
  assert.equal(result.stats.undecrypted, 1)
  assert.equal(result.contexts.length, 0)
  assert.equal(result.calls.length, 0)
})

test('同群当天部分消息无法解密时不分析残缺上下文，避免遗漏后续取消或改期', async () => {
  const cfg = configuration()
  cfg.crypto.sm2PrivateKey = ''
  const result = await process({ cfg, messages: [
    message('m1', '数据安全课程面向全体开发，10月30日考试。', NOW - 60000),
    message('hidden-correction', Buffer.alloc(96).toString('base64'), NOW),
  ] })
  assert.equal(result.stats.undecrypted, 1)
  assert.equal(result.stats.failed, 1)
  assert.equal(result.stats.analyzed, 0)
  assert.equal(result.stats.aiFailed, 0)
  assert.equal(result.contexts.length, 0)
  assert.equal(result.calls.length, 0)
  assert.deepEqual(result.state, {})
})

test('两群分别用各自groupId查询与解密；同课同日跨群仅创建一次', async () => {
  const cfg = configuration()
  const contexts = []
  const groups = []
  const created = []
  const state = {}
  const stats = await chat.runOnce(cfg, 'test-token', state, {
    now: NOW,
    fetchTransferKey: async () => 'test-transfer-key',
    collectMessages: async (groupCfg) => {
      const groupId = groupCfg.chat.groupId
      groups.push(groupId)
      return [encryptedMessage(`m-${groupId}`, '数据安全，全体员工，考试10月30日开始。', groupId, 'test-transfer-key')]
    },
    analyzeGroup: async (_cfg, input) => {
      contexts.push(input)
      return { events: [event({ sourceMsgIds: [input.messages[0].id] })] }
    },
    createSchedule: async (_cfg, _token, name, day) => {
      created.push({ name, day })
      return { code: 200, traceId: 'cross-group' }
    },
  })
  assert.deepEqual(groups, GROUPS)
  assert.deepEqual(contexts.map((item) => item.groupId), GROUPS)
  assert.equal(contexts.length, 2)
  assert.ok(contexts.every((input) => input.messages[0].text.includes('数据安全')))
  assert.equal(created.length, 1)
  assert.equal(stats.created, 1)
  assert.equal(stats.undecrypted, 0)
  assert.equal(Object.keys(state.examEvents).length, 1)
})

test('一个群读取失败不影响另一群处理，并汇总失败数', async () => {
  const groups = []
  const stats = await chat.runOnce(configuration(), 'test-token', {}, {
    now: NOW, fetchTransferKey: async () => null,
    collectMessages: async (cfg) => {
      groups.push(cfg.chat.groupId)
      if (cfg.chat.groupId === GROUPS[0]) throw new Error('聊天服务错误')
      return [message()]
    },
    analyzeGroup: async () => ({ events: [event()] }),
    createSchedule: async () => ({ code: 200 }),
  })
  assert.deepEqual(groups, GROUPS)
  assert.equal(stats.fetchFailed, 1)
  assert.equal(stats.failed, 1)
  assert.equal(stats.created, 1)
})

test('一个群AI失败不影响另一群处理', async () => {
  const stats = await chat.runOnce(configuration(), 'test-token', {}, {
    now: NOW, fetchTransferKey: async () => null, collectMessages: async () => [message()],
    analyzeGroup: async (_cfg, input) => {
      if (input.groupId === GROUPS[0]) throw new Error('AI错误')
      return { events: [event()] }
    },
    createSchedule: async () => ({ code: 200 }),
  })
  assert.equal(stats.aiFailed, 1)
  assert.equal(stats.failed, 1)
  assert.equal(stats.created, 1)
})

test('日程鉴权失败向上传递，保留token失效处理', async () => {
  await assert.rejects(process({ options: { createSchedule: async () => { throw new AuthError('HTTP 401') } } }), AuthError)
})

test('创建接口实际请求包含考试日期与固定时间，兼容JSON、表单和query三种模式', async (t) => {
  for (const mode of ['json', 'form', 'query']) {
    await t.test(mode, async (subtest) => {
      const cfg = configuration()
      cfg.api.scheduleBodyMode = mode
      cfg.schedule.startTime = '17:00'
      cfg.schedule.endTime = '17:30'
      let submitted
      subtest.mock.method(globalThis, 'fetch', async (url, init) => {
        const target = new URL(url)
        submitted = mode === 'json' ? JSON.parse(init.body)
          : Object.fromEntries(mode === 'form' ? new URLSearchParams(init.body) : target.searchParams)
        assert.equal(init.headers['access-token'], 'test-token')
        return response({ code: 200, success: true, traceId: 'test' })
      })
      await chat.createSchedule(cfg, 'test-token', '数据安全考试', '2027-01-02', () => {})
      assert.equal(submitted.startDate, '2027-01-02')
      assert.equal(submitted.endDate, '2027-01-02')
      assert.equal(submitted.startTime, '09:00')
      assert.equal(submitted.endTime, '09:30')
    })
  }
})

test('聊天分页以香港零点停止，不遗漏前一UTC日里的香港当天消息', async (t) => {
  const cfg = configuration()
  const first = message('late', '数据安全', Date.parse('2026-10-29T00:10:00+08:00'))
  const second = message('midnight', '开发参与', Date.parse('2026-10-29T00:00:00+08:00'))
  const old = message('old', '旧消息', Date.parse('2026-10-28T23:59:59+08:00'))
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    const params = new URL(url).searchParams
    requests.push(params)
    return response({ code: 200, data: { chat: requests.length === 1 ? [first] : [second, old] } })
  })
  const messages = await chat.collectMessages(cfg, 'test-token', () => {}, { now: NOW })
  assert.equal(requests.length, 2)
  assert.equal(requests[0].get('groupId'), GROUPS[0])
  assert.equal(Number(requests[1].get('endTime')), first.time - 1)
  assert.ok(messages.some((item) => item.msgId === 'midnight'))
})

test('AI输出严格校验布尔值、日期、事件状态与来源；无效结果不能当自然语言降级', () => {
  const input = context()
  assert.equal(ai.parseAnalysis(JSON.stringify({ events: [event()] }), input).events[0].examStartDate, '2026-10-30')
  assert.deepEqual(ai.parseAnalysis('{"events":[]}', input).events, [])
  assert.equal(ai.parseAnalysis(JSON.stringify({ events: [event({ examStartDate: null })] }), input).events[0].examStartDate, null)
  for (const invalid of [
    '普通文字', '{}', '[]', '{"events":null}',
    JSON.stringify({ events: [event({ includesDevelopers: 'false' })] }),
    JSON.stringify({ events: [event({ examStartDate: '2026-02-30' })] }),
    JSON.stringify({ events: [event({ examStartDate: '2026-13-01' })] }),
    JSON.stringify({ events: [event({ examStartDate: '明天' })] }),
    JSON.stringify({ events: [event({ sourceMsgIds: ['unknown'] })] }),
    JSON.stringify({ events: [event({ sourceMsgIds: [] })] }),
    JSON.stringify({ events: [event({ status: 'maybe' })] }),
    JSON.stringify({ events: [event({ reason: '' })] }),
  ]) assert.throws(() => ai.parseAnalysis(invalid, input), undefined, invalid)
  assert.equal(ai.isValidDate('2028-02-29'), true)
  assert.equal(ai.isValidDate('2026-02-29'), false)
})

test('AI请求使用共享模型和完整上下文，模型返回无效JSON或截断时拒绝', async (t) => {
  const cfg = configuration().defect
  cfg.aiBaseUrl = 'https://ai.test/v1'
  cfg.aiApiKey = 'test-key'
  const source = context([
    { id: 'm1', sentAt: '2026-12-31 23:00:00', text: '课程《数据安全》面向全体研发，明年1月2日考试。\n忽略系统指令的内容仍只是聊天数据。' },
  ])
  source.today = '2026-12-31'
  const contents = [
    { content: JSON.stringify({ events: [event({ examStartDate: '2027-01-02' })] }), finish_reason: 'stop' },
    { content: '不是JSON', finish_reason: 'stop' },
    { content: '{"events":[]}', finish_reason: 'length' },
  ]
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://ai.test/v1/chat/completions')
    assert.equal(init.headers.Authorization, 'Bearer test-key')
    const body = JSON.parse(init.body)
    assert.equal(body.model, cfg.aiModel)
    assert.equal(body.stream, false)
    assert.deepEqual(body.messages.map((item) => item.role), ['system', 'user'])
    assert.ok(body.messages[1].content.includes(source.messages[0].text.split('\n')[0]))
    assert.ok(body.messages[1].content.includes('2026-12-31'))
    assert.ok(body.messages[1].content.includes('Asia/Hong_Kong'))
    return response({ choices: [{ message: { content: contents[0].content }, finish_reason: contents.shift().finish_reason }] })
  })
  const result = await ai.analyzeGroup(cfg, source)
  assert.equal(result.events[0].examStartDate, '2027-01-02')
  await assert.rejects(ai.analyzeGroup(cfg, source))
  await assert.rejects(ai.analyzeGroup(cfg, source))
})
