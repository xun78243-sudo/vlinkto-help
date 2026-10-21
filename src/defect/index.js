'use strict'
/**
 * 缺陷单总结助手主流程：
 *   工单号 + git 地址 → 工单标题/问题描述 → 本人在该分支的提交 → AI 生成分析过程与处理措施
 *   → 程序拼装「处理措施 + 更新包提交路径」→ 返回 4 个字段。
 */

const ticket = require('./ticket')
const git = require('./git')
const ai = require('./ai')

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
  let gitSection = ''

  try {
    const all = await git.fetchCommits({
      cloneUrl: parsed.cloneUrl,
      branch: parsed.branch,
      cacheRoot,
      fetchDepth: cfg.fetchDepth,
      timeoutMs: cfg.gitTimeoutMs,
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
    gitSection = git.formatGitSection({
      branch: parsed.branch,
      commits,
      commitUrlBase: parsed.commitUrlBase,
      limit: Number(cfg.gitSectionLimit) || 0,
    })
    stage('git', 'done', { commits: commits.length, scanned: all.length })
  } catch (error) {
    const failure = error instanceof DefectError
      ? error
      : new DefectError(`拉取 git 提交失败：${error.message}`)
    log('error', failure.message + (failure.hint ? `（${failure.hint}）` : ''))
    errors.push({ stage: 'git', message: failure.message, hint: failure.hint || '' })
    gitSection = `更新包提交路径：分支 ${parsed.branch}（未取到提交记录：${failure.message}）`
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

  const elapsedMs = Date.now() - started
  log('info', `缺陷单总结完成：${fields.title}（${elapsedMs}ms，${commits.length} 条提交）`)

  return {
    ok: errors.length ? 'partial' : 'full',
    fields,
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
    },
    errors,
  }
}

module.exports = { generate }
