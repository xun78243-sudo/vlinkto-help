'use strict'
/**
 * AI 模块：调用内网 OpenAI 兼容推理服务，把「工单信息 + 本人提交记录」
 * 变成工单里的「分析过程 / 处理措施」两段文字。
 *
 * 约定：git 相关内容（分支、提交地址）一律由程序拼接，不让模型自由发挥。
 */

const { DefectError } = require('./ticket')

function baseUrl(cfg) {
  const url = String(cfg.aiBaseUrl || '').trim().replace(/\/+$/, '')
  if (!url) throw new DefectError('未配置 AI 服务地址', '在「设置」里填写 inference 服务地址')
  return url
}

async function requestJson(url, { method = 'GET', body, apiKey = '', timeoutMs = 120000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs))
  const headers = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json;charset=UTF-8'
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) {
      throw new DefectError(`AI 服务返回 HTTP ${response.status}：${text.slice(0, 200)}`,
        '检查推理服务是否可用，或稍后重试')
    }
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new DefectError(`AI 服务返回的不是 JSON：${text.slice(0, 200)}`)
    }
  } catch (error) {
    if (error instanceof DefectError) throw error
    if (error.name === 'AbortError') {
      throw new DefectError(`调用 AI 服务超时（${timeoutMs}ms）`, '可在设置里换更快的模型，或稍后重试')
    }
    throw new DefectError(`调用 AI 服务失败：${error.message}`,
      '确认本机能访问内网推理服务地址')
  } finally {
    clearTimeout(timer)
  }
}

/** 取模型列表，失败返回空数组（界面降级为手填模型 ID）。 */
async function listModels(cfg) {
  try {
    const payload = await requestJson(`${baseUrl(cfg)}/models`, {
      timeoutMs: 15000,
      apiKey: cfg.aiApiKey,
    })
    const list = (payload && (payload.data || payload.models)) || []
    if (!Array.isArray(list)) return []
    // modelType === 0 是对话模型，其余是 embedding / rerank / 语音等
    const chatOnly = list.filter((item) => typeof item === 'string'
      || item.modelType === 0 || item.modelType === undefined)
    return (chatOnly.length ? chatOnly : list)
      .map((item) => (typeof item === 'string' ? item : item && item.id))
      .filter(Boolean)
  } catch (error) {
    return []
  }
}

function textOf(value) {
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n')
  return ''
}

async function chat(cfg, messages, { log = () => {}, timeoutMs, temperature = 0.3 } = {}) {
  const model = String(cfg.aiModel || '').trim()
  if (!model) throw new DefectError('未配置 AI 模型', '在「设置」里选择模型，如 Qwen3.6-27B')

  const started = Date.now()
  log('debug', `调用 AI：${model}`)
  const payload = await requestJson(`${baseUrl(cfg)}/chat/completions`, {
    method: 'POST',
    apiKey: cfg.aiApiKey,
    timeoutMs: timeoutMs || cfg.aiTimeoutMs || 120000,
    body: {
      model,
      messages,
      stream: false,
      temperature,
      maxTokens: Number(cfg.aiMaxTokens) || 2048,
    },
  })

  const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null
  const content = textOf(choice && choice.message && choice.message.content)
  if (!content) {
    throw new DefectError(`AI 服务没有返回内容：${JSON.stringify(payload).slice(0, 200)}`)
  }
  log('info', `AI 返回 ${content.length} 字（${Date.now() - started}ms）`)
  return { content, model, usage: payload.usage || null, finishReason: choice.finish_reason || null }
}

function describeCommits(commits, fileLimit = 5) {
  return (commits || []).map((commit, index) => {
    const files = Array.isArray(commit.files) ? commit.files.slice(0, fileLimit) : []
    const rest = Array.isArray(commit.files) ? commit.files.length - files.length : 0
    const fileLine = files.length
      ? `\n   涉及文件：${files.join('、')}${rest > 0 ? ` 等 ${commit.files.length} 个文件` : ''}`
      : ''
    return `${index + 1}. ${commit.short || commit.hash} ${commit.date || ''} ${commit.subject || ''}`.trimEnd() + fileLine
  }).join('\n')
}

/** 组装对话消息（纯函数，便于单测）。 */
function buildMessages(payload) {
  const {
    title = '', description = '', version = '', branch = '', commits = [], describeMaxChars = 4000,
  } = payload || {}

  const trimmedDescription = String(description || '').slice(0, describeMaxChars)
  const system = [
    '你是一名资深 Java 后端工程师，负责把缺陷修复过程整理成工单中可直接填写的说明。',
    '只依据给定的工单信息与 git 提交记录作答，不要编造提交记录里没有出现过的文件名、类名或功能。',
    '如果提交记录不足以支撑判断，就在对应句子中说明「需结合日志进一步定位」，不要虚构。',
    '输出必须是 JSON，形如 {"analysis":"...","measures":"..."}，不要输出 JSON 以外的任何内容，不要使用 markdown 代码块。',
  ].join('')

  const user = [
    '【工单标题】',
    title || '（无）',
    '',
    '【工单问题描述】',
    trimmedDescription || '（原工单未填写描述）',
    '',
    '【涉及版本】',
    version || '（工单未填写版本号）',
    '',
    '【代码分支】',
    branch || '（未提供）',
    '',
    `【本人在该分支的最近 ${(commits || []).length} 条提交】`,
    describeCommits(commits) || '（没有找到匹配的提交记录）',
    '',
    '【输出要求】',
    '1. analysis（工单分析过程）：结合提交记录说明问题根因与影响范围，3~6 条，用「1. 2. 3.」编号，**每条单独一行**。',
    '2. measures（工单处理措施）：写本次已经做的修复动作，3~6 条，动词开头（如「修正…」「补充…」「增加…」），**每条单独一行**。',
    '3. 两段都使用中文；不要写 git 分支名、提交号、提交地址（这些由程序另行拼接）。',
    '4. 只输出 JSON。',
  ].join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/** 从模型输出里抠出 JSON，容忍代码块围栏和前后多余文字。 */
function extractJson(text) {
  const source = String(text || '').trim()
  if (!source) return null

  const tryParse = (value) => {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch (error) {
      return null
    }
  }

  const direct = tryParse(source)
  if (direct) return direct

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(source)
  if (fenced) {
    const parsed = tryParse(fenced[1].trim())
    if (parsed) return parsed
  }

  const start = source.indexOf('{')
  const end = source.lastIndexOf('}')
  if (start >= 0 && end > start) {
    const parsed = tryParse(source.slice(start, end + 1))
    if (parsed) return parsed
  }
  return null
}

/**
 * 模型常把 1. 2. 3. 挤成一行，这里按中文标点后的编号断行，便于阅读和粘贴。
 * 只处理「没有换行」的文本，且要求编号后有中文标点，避免误伤 4.3.8.2 这类版本号。
 */
function formatNumbered(text) {
  const source = String(text || '').trim()
  if (!source || source.includes('\n')) return source
  return source.replace(/([。；;：:）)])\s*(?=\d{1,2}[.、]\s)/g, '$1\n').trim()
}

/**
 * @returns {Promise<{analysis:string, measures:string, model:string, usage:object|null, raw:string}>}
 */
async function summarize(cfg, payload, { log = () => {} } = {}) {
  const messages = buildMessages({ ...payload, describeMaxChars: cfg.describeMaxChars })
  const { content, model, usage } = await chat(cfg, messages, { log })

  const json = extractJson(content)
  if (!json) {
    log('warn', 'AI 输出不是合法 JSON，已整段作为「分析过程」')
    return { analysis: formatNumbered(content), measures: '', model, usage, raw: content }
  }

  const analysis = textOf(json.analysis || json.Analysis || json['工单分析过程'])
  const measures = textOf(json.measures || json.Measures || json['工单处理措施'])
  if (!analysis && !measures) {
    log('warn', 'AI 返回的 JSON 里没有 analysis / measures 字段，已整段作为「分析过程」')
    return { analysis: formatNumbered(content), measures: '', model, usage, raw: content }
  }
  return {
    analysis: formatNumbered(analysis),
    measures: formatNumbered(measures),
    model,
    usage,
    raw: content,
  }
}

module.exports = {
  listModels,
  chat,
  buildMessages,
  describeCommits,
  formatNumbered,
  extractJson,
  summarize,
}
