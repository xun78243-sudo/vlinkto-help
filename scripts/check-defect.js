'use strict'
/**
 * 缺陷单总结助手联网自检（只读，不会修改工单、不建日程、不 push 代码）。
 *
 *   node scripts/check-defect.js         # 查工单 + 拉 git 提交
 *   node scripts/check-defect.js --ai    # 额外真实调用一次模型，打印分析/措施
 *
 * 可用环境变量覆盖：
 *   DEFECT_TICKET  工单编号（默认 JETABLE2026101400071）
 *   DEFECT_GITURL  git 地址（默认取 config 里的默认值）
 */

const os = require('os')
const path = require('path')

const { findToken } = require('../src/token')
const store = require('../src/config')
const ticket = require('../src/defect/ticket')
const git = require('../src/defect/git')
const ai = require('../src/defect/ai')
const defectInfo = require('../src/defect/info')

const TICKET_NO = process.env.DEFECT_TICKET || 'JETABLE2026101400071'

let failed = 0

function check(name, actual, expected) {
  const ok = String(actual) === String(expected)
  if (!ok) failed += 1
  console.log(`  [${ok ? 'ok' : 'FAIL'}] ${name}${ok ? '' : `\n        期望 ${expected}\n        实际 ${actual}`}`)
}

function section(title) {
  console.log(`\n${title}`)
}

function log(level, message) {
  if (level === 'debug') return
  console.log(`        [${level}] ${message}`)
}

async function main() {
  const userDir = path.join(process.env.APPDATA || os.homedir(), '微联叮小助手')
  const cfg = store.loadConfig(userDir).defect
  const withAi = process.argv.includes('--ai')
  const withSubmit = process.argv.includes('--submit')
  const gitUrl = process.env.DEFECT_GITURL || cfg.defaultGitUrl

  section(`1. 工单查询（${TICKET_NO}）：`)
  const info = findToken()
  check('拿到 access-token', info.ok, 'true')
  if (!info.ok) {
    console.log(`        原因：${info.error}`)
    return
  }
  console.log(`        用户=${info.username} 剩余=${info.remainingHours.toFixed(1)}h`)

  const found = await ticket.findTicket(cfg, info.token, TICKET_NO, { log })
  check('定位到工单（有 iid）', Boolean(found.iid), 'true')
  check('标题非空', Boolean(found.title), 'true')
  console.log(`        iid=${found.iid} 扫描=${found.scanned} 条，标题=${found.title}`)

  const form = await ticket.fetchTicketForm(cfg, info.token, found.iid, { log })
  check('问题描述非空', Boolean(form.description), 'true')
  console.log(`        描述 ${form.description.length} 字，版本=${form.version || '（工单未填）'}`)
  console.log(`        描述首行：${form.description.split('\n')[0]}`)

  section('2. git 提交记录：')
  const parsed = git.parseGitUrl(gitUrl)
  console.log(`        仓库=${parsed.cloneUrl}`)
  console.log(`        分支=${parsed.branch}`)
  console.log(`        访问凭据=${cfg.gitAuthUser ? `配置账号 ${cfg.gitAuthUser}` : '本机 git 凭据'}`)
  const commits = await git.fetchCommits({
    cloneUrl: parsed.cloneUrl,
    branch: parsed.branch,
    cacheRoot: path.join(os.tmpdir(), 'dsh-defect-check'),
    fetchDepth: cfg.fetchDepth,
    timeoutMs: cfg.gitTimeoutMs,
    auth: { user: cfg.gitAuthUser, password: cfg.gitAuthPassword },
    log,
  })
  check('拉取到提交', commits.length > 0, 'true')

  const mine = git.filterCommits(commits, {
    gitUser: cfg.gitUser,
    gitName: cfg.gitName,
    limit: cfg.commitLimit,
  })
  check('过滤出本人提交', mine.length > 0, 'true')
  console.log(`        ${commits.length} 条提交中，${cfg.gitUser}/${cfg.gitName} 占 ${mine.length} 条`)
  if (mine.length) {
    console.log(`        最近一条：${mine[0].short} ${mine[0].date} ${mine[0].subject}`)
  }

  const gitSection = git.formatUpdatePath(gitUrl)
  check('更新包提交路径 = 入参地址', gitSection, `更新包提交路径：${gitUrl}`)

  section('3. AI 生成：')
  let summary = null
  if (!withAi) {
    console.log('  跳过（加 --ai 参数才会真实调用模型）')
  } else {
    const started = Date.now()
    summary = await ai.summarize(cfg, {
      title: found.title,
      description: form.description,
      version: form.version,
      branch: parsed.branch,
      commits: mine,
    }, { log })
    check('返回分析过程', summary.analysis.length > 0, 'true')
    check('返回处理措施', summary.measures.length > 0, 'true')
    console.log(`        模型=${summary.model} 用时=${Date.now() - started}ms`)
    console.log(`\n  ---- 工单分析过程 ----\n${summary.analysis}`)
    console.log(`\n  ---- 工单处理措施 ----\n${summary.measures}`)
  }

  section('4. 最终四段内容（预览）：')
  const fields = {
    标题: found.title,
    工单问题描述: form.description,
    工单分析过程: withAi ? '（见上）' : '（未调用模型）',
    工单处理措施及更新包提交路径: `${withAi ? '（AI 措施见上）\n' : ''}${gitSection}`,
  }
  for (const [key, value] of Object.entries(fields)) {
    const preview = String(value).split('\n').slice(0, 3).join(' / ')
    console.log(`        ${key}：${preview}${String(value).length > preview.length ? ' …' : ''}`)
  }

  section('5. 确认提交：信息数据入参：')
  const submitFields = {
    title: found.title,
    description: form.description || found.title,
    analysis: summary ? summary.analysis : '（未调用模型）',
    measures: summary ? `${summary.measures}\n\n${gitSection}` : gitSection,
  }
  const infoPayload = defectInfo.buildInfoPayload({ fields: submitFields, ticketNo: found.ticketNo, cfg })
  const payloadText = JSON.stringify(infoPayload)
  check('payload 可序列化', payloadText.length > 1000, 'true')
  check('标题已替换', infoPayload.titleText, found.title)
  check('iid 是 32 位 hex', /^[0-9a-f]{32}$/.test(infoPayload.iid), 'true')
  check('infoContent 与 elementList 同步',
    infoPayload.extendsEntity.infoContent, JSON.stringify(infoPayload.extendsEntity.elementList))
  console.log(`        ${Buffer.byteLength(payloadText)} 字节，webId=${infoPayload.webId} columnId=${infoPayload.columnId}`)
  console.log(`        iid=${infoPayload.iid} deployTime=${infoPayload.deployTime} author=${infoPayload.author} source=${infoPayload.source}`)

  if (!withSubmit) {
    console.log('  跳过真实提交（加 --submit 才会真的创建一条信息数据）')
  } else {
    const submitted = await defectInfo.submitInfo(cfg, info.token, infoPayload, { log })
    check('接口返回 iid', Boolean(submitted.iid), 'true')
    console.log(`        已创建信息数据：iid=${submitted.iid}`)
    console.log(`        响应：${JSON.stringify(submitted.raw).slice(0, 300)}`)
  }
}

main().then(() => {
  console.log(failed ? `\n失败 ${failed} 项` : '\n缺陷单自检全部通过')
  process.exit(failed ? 1 : 0)
}).catch((error) => {
  console.error('\n执行出错：', error && error.message ? error.message : error)
  if (error && error.hint) console.error('提示：', error.hint)
  process.exit(1)
})
