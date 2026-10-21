'use strict'
/**
 * Git 模块：把「仓库地址 + 分支」解析出来，用本机 git 凭据浅拉取提交记录，
 * 按提交人过滤后交给上层拼装成「更新包提交路径」。
 *
 * 这里不调用 GitLab REST API（需要额外 token），直接复用本机已保存的凭据。
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFile } = require('child_process')

const { DefectError } = require('./ticket')

const FIELD_SEP = '\u001f'

/**
 * 生成 HTTP Basic 认证参数。
 * 账号密码都填了才启用；启用时同时清掉 credential.helper，避免凭据助手弹窗/挂起。
 * 密码只在内存里编码成头部，不写日志、不进 URL（URL 会出现在进程命令行里）。
 */
function authArgs(auth) {
  const user = String((auth && auth.user) || '').trim()
  const password = String((auth && auth.password) || '')
  if (!user || !password) return []
  const token = Buffer.from(`${user}:${password}`, 'utf8').toString('base64')
  return ['-c', 'credential.helper=', '-c', `http.extraheader=AUTHORIZATION: Basic ${token}`]
}

function run(args, options = {}) {
  const { cwd, timeoutMs = 60000, auth = null } = options
  const fullArgs = [...authArgs(auth), ...args]
  return new Promise((resolve) => {
    execFile('git', fullArgs, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0', // 不要卡在交互输入上
        GCM_INTERACTIVE: 'never',
        GIT_ASKPASS: 'echo',      // 凭据缺失时立刻失败，而不是弹窗/挂起
        GIT_PAGER: 'cat',
      },
    }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || ''), error })
    })
  })
}

/** 把 git 的英文报错翻译成能直接照做的提示。 */
function explainGitFailure(stderr, context) {
  const text = String(stderr || '')
  if (/could not read Username|Authentication failed|terminal prompts disabled|fatal: Authentication/i.test(text)) {
    return new DefectError('拉取 git 仓库失败：本机没有该仓库的访问凭据',
      '先在命令行对该仓库执行一次 git clone（或 git fetch）并输入账号密码，凭据会被记住，之后再点生成')
  }
  if (/couldn't find remote ref|not our ref|unknown revision/i.test(text)) {
    return new DefectError(`拉取 git 仓库失败：分支 ${context && context.branch ? context.branch : ''} 不存在`,
      '请检查地址里的 /tree/<分支名> 是否正确')
  }
  if (/Could not resolve host|unable to access|Connection refused|timed out|Failed to connect/i.test(text)) {
    return new DefectError('拉取 git 仓库失败：网络不可达或地址有误',
      '确认能访问该 GitLab 地址，且地址形如 http://host/group/project/tree/分支名')
  }
  return new DefectError(`拉取 git 仓库失败：${text.trim().split('\n').slice(0, 3).join(' ').slice(0, 240)}`)
}

/**
 * 解析 git 地址。
 * 支持：
 *   http://host/group/project/tree/branch
 *   http://host/group/project/-/tree/branch
 *   http://host/group/project/tree/release/4.3   （分支名带斜杠）
 * @returns {{webBase:string, projectPath:string, branch:string, cloneUrl:string,
 *            commitUrlBase:string, branchUrl:string}}
 */
function parseGitUrl(rawUrl) {
  const input = String(rawUrl || '').trim()
  if (!input) throw new DefectError('请先输入 git 地址')

  const cleaned = input.replace(/\/+$/, '')
  const match = /^(https?):\/\/([^/]+)\/(.+?)\/(?:-\/)?tree\/(.+)$/i.exec(cleaned)
  if (!match) {
    throw new DefectError('git 地址格式不正确',
      '期望形如 http://192.168.5.15/jpaas/jagent/be/jagent-web/tree/release-4.3.5.17')
  }

  const [, protocol, host, rawPath, rawBranch] = match
  const projectPath = rawPath.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '')
  const branch = decodeURIComponent(rawBranch).replace(/^\/+|\/+$/g, '')

  if (!projectPath || !branch) {
    throw new DefectError('git 地址里缺少仓库路径或分支名',
      '期望形如 http://host/group/project/tree/分支名')
  }

  const webBase = `${protocol.toLowerCase()}://${host}`
  const repoBase = `${webBase}/${projectPath}`
  return {
    webBase,
    projectPath,
    branch,
    cloneUrl: `${repoBase}.git`,
    commitUrlBase: `${repoBase}/-/commit/`,
    branchUrl: `${repoBase}/-/tree/${branch}`,
  }
}

/** 列出远端分支，用于「分支不存在」时给出候选。 */
async function listRemoteBranches(cloneUrl, { timeoutMs = 20000, auth = null } = {}) {
  const result = await run(['ls-remote', '--heads', cloneUrl], { timeoutMs, auth })
  if (!result.ok) return []
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[0-9a-f]+\trefs\/heads\//i, ''))
    .filter(Boolean)
}

function cacheDirFor(rootDir, cloneUrl, branch) {
  const digest = crypto.createHash('sha1').update(`${cloneUrl}#${branch}`).digest('hex').slice(0, 16)
  return path.join(rootDir, digest)
}

/** 解析 `git log --format=… --name-only` 的输出。 */
function parseLogOutput(text) {
  const commits = []
  let current = null
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (!line) continue
    if (line.includes(FIELD_SEP)) {
      const [hash, short, author, email, date, subject] = line.split(FIELD_SEP)
      current = {
        hash: (hash || '').trim(),
        short: (short || '').trim(),
        author: (author || '').trim(),
        email: (email || '').trim(),
        date: (date || '').trim(),
        subject: (subject || '').trim(),
        files: [],
      }
      commits.push(current)
      continue
    }
    if (current) current.files.push(line.trim())
  }
  return commits
}

/** 账号/中文名命中作者名或邮箱即算本人提交。 */
function matchesAuthor(commit, tokens) {
  if (!tokens.length) return true
  const author = String(commit.author || '').toLowerCase()
  const email = String(commit.email || '').toLowerCase()
  const local = email.split('@')[0] || ''
  return tokens.some((token) => author.includes(token) || email.includes(token) || local === token)
}

function filterCommits(commits, { gitUser = '', gitName = '', limit = 20 } = {}) {
  const tokens = [gitUser, gitName]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
  const matched = (commits || []).filter((commit) => matchesAuthor(commit, tokens))
  return matched.slice(0, Math.max(1, Number(limit) || 20))
}

/**
 * 浅拉取分支并返回提交列表（最新在前）。
 * @returns {Promise<Array<{hash,short,author,email,date,subject,files:string[]}>>}
 */
async function fetchCommits(options) {
  const {
    cloneUrl, branch, cacheRoot, fetchDepth = 200, timeoutMs = 60000, auth = null,
    log = () => {},
  } = options

  if (!cloneUrl || !branch) throw new DefectError('缺少仓库地址或分支')
  if (!cacheRoot) throw new DefectError('缺少 git 缓存目录')

  const dir = cacheDirFor(cacheRoot, cloneUrl, branch)
  fs.mkdirSync(dir, { recursive: true })

  if (!fs.existsSync(path.join(dir, '.git'))) {
    log('debug', `初始化 git 缓存目录：${dir}`)
    const init = await run(['init', '-q'], { cwd: dir, timeoutMs })
    if (!init.ok) throw explainGitFailure(init.stderr, { branch })
  }

  const hasOrigin = await run(['remote', 'get-url', 'origin'], { cwd: dir, timeoutMs })
  const remoteArgs = hasOrigin.ok
    ? ['remote', 'set-url', 'origin', cloneUrl]
    : ['remote', 'add', 'origin', cloneUrl]
  const remoteResult = await run(remoteArgs, { cwd: dir, timeoutMs })
  if (!remoteResult.ok) throw explainGitFailure(remoteResult.stderr, { branch })

  log('info', `拉取 git 提交：${branch}（depth=${fetchDepth}${auth && auth.user ? `，账号 ${auth.user}` : '，本机凭据'}）`)
  const fetchResult = await run(
    ['fetch', '--no-tags', `--depth=${Math.max(1, Number(fetchDepth) || 200)}`, 'origin', branch],
    { cwd: dir, timeoutMs, auth },
  )
  if (!fetchResult.ok) {
    const failure = explainGitFailure(fetchResult.stderr, { branch })
    if (auth && auth.user) {
      failure.hint = `当前用配置的 git 账号 ${auth.user} 访问，请确认密码正确、该账号有仓库读权限`
    }
    const branches = await listRemoteBranches(cloneUrl, { timeoutMs: 15000, auth })
    const similar = branches.filter((name) => name.includes(branch.slice(0, 8)))
      .slice(0, 5)
    if (similar.length) failure.hint = `${failure.hint}；相近分支：${similar.join('、')}`
    throw failure
  }

  const logResult = await run([
    'log', 'FETCH_HEAD', '-n', String(Math.max(1, Number(fetchDepth) || 200)),
    `--format=%H${FIELD_SEP}%h${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%ad${FIELD_SEP}%s`,
    '--date=short', '--name-only',
  ], { cwd: dir, timeoutMs })
  if (!logResult.ok) throw explainGitFailure(logResult.stderr, { branch })

  return parseLogOutput(logResult.stdout)
}

/**
 * 程序侧拼装「更新包提交路径」，不交给模型自由发挥。
 */
function formatGitSection({
  branch, commits, commitUrlBase = '', fileLimitPerCommit = 8, limit = 0,
} = {}) {
  const all = Array.isArray(commits) ? commits : []
  if (!all.length) {
    return `更新包提交路径：分支 ${branch || '（未知）'}（未找到匹配的提交记录）`
  }

  const list = limit > 0 ? all.slice(0, limit) : all
  const suffix = list.length < all.length ? `，此处仅列最近 ${list.length} 个` : ''
  const lines = [`更新包提交路径：分支 ${branch}（共 ${all.length} 个提交${suffix}）`]
  list.forEach((commit, index) => {
    const date = commit.date ? ` ${commit.date}` : ''
    lines.push(`${index + 1}. ${commit.short || commit.hash}${date} ${commit.subject || ''}`.trimEnd())
    if (commitUrlBase && commit.hash) lines.push(`   提交地址：${commitUrlBase}${commit.hash}`)
    const files = Array.isArray(commit.files) ? commit.files : []
    if (files.length) {
      const shown = files.slice(0, fileLimitPerCommit)
      const rest = files.length - shown.length
      lines.push(`   涉及文件：${shown.join('、')}${rest > 0 ? ` 等 ${files.length} 个文件` : ''}`)
    }
  })
  return lines.join('\n')
}

module.exports = {
  authArgs,
  parseGitUrl,
  parseLogOutput,
  filterCommits,
  matchesAuthor,
  fetchCommits,
  listRemoteBranches,
  formatGitSection,
  cacheDirFor,
}
