'use strict'
/**
 * 缺陷单总结助手主流程：
 *   工单号 + git 地址 → 工单标题/问题描述 → 本人在该分支的提交 → AI 生成分析过程与处理措施
 *   → 程序拼装「处理措施 + 更新包提交路径」→ 返回 4 个字段。
 */

const crypto = require('node:crypto')
const ticket = require('./ticket')
const git = require('./git')
const ai = require('./ai')
const infoApi = require('./info')

const { DefectError } = ticket

const PLACEHOLDER = '（未能生成，请根据提交记录手工补充）'

/**
 * @param {object} options
 * @param {object} options.cfg       config.defect
 * @param {string} options.token     access-token
 * @param {string} options.transactNo 工单编号
 * @param {string} options.gitUrl    git 地址（含分支）
 * @param {string} options.cacheRoot git 缓存根目录
 * @param {Function} [options.log]
 * @param {Function} [options.onStage] (stage, state, detail) => void
 */
async function generate(options) {
  const {
    cfg, token, transactNo, gitUrl, cacheRoot,
    log = () => {}, onStage = () => {},
  } = options

  const started = Date.now()
  const errors = []
  const warnings = []
  const stage = (name, state, detail) => {
    try {
      onStage(name, state, detail || null)
    } catch (error) {
      /* 进度回调不应影响主流程 */
    }
  }

  // ---------- 1. 工单 ----------
  stage('ticket', 'running')
  const found = await ticket.findTicket(cfg, token, transactNo, { log })
  const form = await ticket.fetchTicketForm(cfg, token, found.iid, { log })
  stage('ticket', 'done', { title: found.title })

  if (!form.description) {
    warnings.push('工单详情里的「内容详情」（nrxq）为空，已用标题代替问题描述')
  }

  // ---------- 2. git 提交 ----------
  stage('git', 'running')
  const parsed = git.parseGitUrl(gitUrl)
  let commits = []
  let totalCommits = 0
  // 更新包提交路径直接用入参的 git 地址，与提交能不能拉到无关
  const gitSection = git.formatUpdatePath(gitUrl)

  try {
    const all = await git.fetchCommits({
      cloneUrl: parsed.cloneUrl,
      branch: parsed.branch,
      cacheRoot,
      fetchDepth: cfg.fetchDepth,
      timeoutMs: cfg.gitTimeoutMs,
      auth: { user: cfg.gitAuthUser, password: cfg.gitAuthPassword },
      log,
    })
    totalCommits = all.length
    commits = git.filterCommits(all, {
      gitUser: cfg.gitUser,
      gitName: cfg.gitName,
      limit: cfg.commitLimit,
    })
    log('info', `分支 ${parsed.branch} 共 ${all.length} 条提交，匹配「${cfg.gitUser || cfg.gitName || '未配置'}」的 ${commits.length} 条`)
    if (!commits.length) {
      warnings.push(`分支 ${parsed.branch} 最近 ${all.length} 条提交里没有匹配「${cfg.gitUser || cfg.gitName}」的记录，请检查设置里的 git 账号/名称`)
    }
    stage('git', 'done', { commits: commits.length, scanned: all.length })
  } catch (error) {
    const failure = error instanceof DefectError
      ? error
      : new DefectError(`拉取 git 提交失败：${error.message}`)
    log('error', failure.message + (failure.hint ? `（${failure.hint}）` : ''))
    errors.push({ stage: 'git', message: failure.message, hint: failure.hint || '' })
    stage('git', 'error', { message: failure.message })
  }

  // ---------- 3. AI 生成 ----------
  stage('ai', 'running')
  let analysis = ''
  let measures = ''
  let model = cfg.aiModel || ''

  try {
    const result = await ai.summarize(cfg, {
      title: found.title,
      description: form.description || found.title,
      version: form.version,
      branch: parsed.branch,
      commits,
    }, { log })
    analysis = result.analysis
    measures = result.measures
    model = result.model || model
    if (!measures) {
      warnings.push('AI 只返回了分析过程，处理措施需要人工补充')
    }
    stage('ai', 'done', { model })
  } catch (error) {
    const failure = error instanceof DefectError
      ? error
      : new DefectError(`生成分析失败：${error.message}`)
    log('error', failure.message + (failure.hint ? `（${failure.hint}）` : ''))
    errors.push({ stage: 'ai', message: failure.message, hint: failure.hint || '' })
    stage('ai', 'error', { message: failure.message })
  }

  // ---------- 4. 组装 4 个字段 ----------
  const description = form.description
    || `（原工单未填写问题描述）\n${found.title}`
  const measureText = [measures, gitSection].filter(Boolean).join('\n\n')

  const fields = {
    title: found.title,
    description,
    analysis: analysis || `${PLACEHOLDER}${errors.some((item) => item.stage === 'ai') ? `（${errors.find((item) => item.stage === 'ai').message}）` : ''}`,
    measures: measureText || PLACEHOLDER,
  }
  const fingerprint = fingerprintOf(fields, found.ticketNo, gitUrl)

  // ---------- 5. 确认提交：生成信息数据 ----------
  stage('submit', 'running')
  const info = await submitStage({
    cfg, token, fields, ticketNo: found.ticketNo, fingerprint, options, log, stage, errors,
  })

  const elapsedMs = Date.now() - started
  log('info', `缺陷单总结完成：${fields.title}（${elapsedMs}ms，${commits.length} 条提交）`)

  return {
    ok: errors.length ? 'partial' : 'full',
    fields,
    info,
    meta: {
      ticketNo: found.ticketNo,
      iid: found.iid,
      title: found.title,
      version: form.version || '',
      branch: parsed.branch,
      commitCount: commits.length,
      scannedCommits: totalCommits,
      commitList: commits.map((commit) => ({
        short: commit.short,
        date: commit.date,
        subject: commit.subject,
        url: parsed.commitUrlBase + commit.hash,
      })),
      model,
      elapsedMs,
      warnings,
      gitUrl: parsed.branchUrl,
      fingerprint,
      infoIid: (info && info.iid) || '',
      infoUrl: (info && info.url) || '',
    },
    errors,
  }
}

/** 四个字段 + 单号 + git 地址的指纹，用来避免同一条内容重复自动提交。 */
function fingerprintOf(fields, ticketNo, gitUrl) {
  const text = JSON.stringify({
    ticketNo: String(ticketNo || ''),
    gitUrl: String(gitUrl || ''),
    fields,
  })
  return crypto.createHash('sha1').update(text).digest('hex')
}

/**
 * 第 5 步：按「冒烟 / 开关 / 指纹」决定是否真的创建信息数据。
 * 任何失败都只记录到 errors，不影响已经生成的四段文本。
 */
async function submitStage({ cfg, token, fields, ticketNo, fingerprint, options, log, stage, errors }) {
  if (options.drySubmit) {
    const payload = infoApi.buildInfoPayload({ fields, ticketNo, cfg })
    const size = JSON.stringify(payload).length
    log('info', `冒烟模式：已组装信息数据（${size} 字节），未真实提交`)
    stage('submit', 'done', { skipped: true })
    return {
      ok: true, skipped: true, iid: '', message: `冒烟模式：已组装信息数据（${size} 字节），未真实提交`,
    }
  }

  if (cfg.infoAutoSubmit === false) {
    log('info', '已关闭「生成后自动提交」，未创建信息数据')
    stage('submit', 'done', { skipped: true })
    return {
      ok: false, skipped: true, iid: '', message: '未自动提交（设置里关闭了「生成后自动提交」）',
    }
  }

  if (errors.some((item) => item.stage === 'ai')) {
    log('warn', '分析过程未生成成功，跳过自动提交')
    stage('submit', 'done', { skipped: true })
    return {
      ok: false, skipped: true, iid: '', message: '分析过程未生成成功，未自动提交',
    }
  }

  if (options.lastFingerprint && options.lastFingerprint === fingerprint) {
    log('info', '内容与上次提交完全一致，跳过重复提交')
    stage('submit', 'done', { skipped: true })
    return {
      ok: false, skipped: true, iid: '', message: '内容与上次一致，已跳过重复提交',
    }
  }

  try {
    const payload = infoApi.buildInfoPayload({ fields, ticketNo, cfg })
    const result = await infoApi.submitInfo(cfg, token, payload, { log })

    // 建好之后再查一次列表，把这条信息的 fullUrl 取回来给界面复制。
    let url = ''
    let urlError = ''
    try {
      const found = await infoApi.fetchInfoUrl(cfg, token, result.iid, { log })
      url = found.url
      if (!url) {
        urlError = '信息已创建，但列表里还没刷出它的地址（多半是还没发布），可稍后点「重新获取地址」'
        log('warn', urlError)
      }
    } catch (error) {
      urlError = error.message || '查询信息地址失败'
      log('warn', `查询信息地址失败：${urlError}`)
    }

    const message = url
      ? '信息已创建并发布，地址已生成，可一键复制'
      : urlError || '信息已创建'
    stage('submit', 'done', { iid: result.iid, url })
    return { ok: true, skipped: false, iid: result.iid, url, message }
  } catch (error) {
    const failure = error instanceof DefectError
      ? error
      : new DefectError(`提交信息数据失败：${error.message}`)
    log('error', failure.message + (failure.hint ? `（${failure.hint}）` : ''))
    errors.push({ stage: 'submit', message: failure.message, hint: failure.hint || '' })
    stage('submit', 'error', { message: failure.message })
    return { ok: false, skipped: false, iid: '', message: failure.message }
  }
}

module.exports = { generate, fingerprintOf }
