'use strict'
/**
 * 自动获取微联叮（vlinkto）客户端当前使用的 access-token。
 * 移植自 get-vlinkto-token.ps1：
 *   1. %APPDATA%\vlinkto\config.json 的 mdltoken 字段（最可靠）
 *   2. %APPDATA%\vlinkto 下 Electron Local Storage 的 *.ldb / *.log（内嵌页面 work.hanweb.com）
 * 两个来源都解析 iat/exp，只返回仍在有效期内的最新一枚。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const JWT_RE = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g
const JWT_FULL_RE = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/
const CONFIG_FIELDS = ['mdltoken', 'token', 'accessToken', 'access_token']
const MAX_SQLITE_FILE = 32 * 1024 * 1024

function appDataDir() {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** 解析 JWT payload（不验签），失败返回 null */
function decodeJwt(token) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) return null
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    if (!payload || !payload.exp) return null
    return payload
  } catch (error) {
    return null
  }
}

function jwtInfo(token) {
  const claims = decodeJwt(token)
  if (!claims) return null
  const exp = Number(claims.exp)
  const iat = Number(claims.iat)
  if (!Number.isFinite(exp)) return null
  return {
    token,
    username: claims.username || '',
    issuedAt: Number.isFinite(iat) ? new Date(iat * 1000) : null,
    expiresAt: new Date(exp * 1000),
  }
}

/** 来源 1：vlinkto 主配置 */
function readConfigSource(root) {
  const file = path.join(root, 'config.json')
  if (!fs.existsSync(file)) return []
  let json
  try {
    json = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')))
  } catch (error) {
    return []
  }
  const found = []
  for (const name of CONFIG_FIELDS) {
    const value = json[name]
    if (typeof value === 'string' && JWT_FULL_RE.test(value)) {
      const info = jwtInfo(value)
      if (info) found.push({ source: `vlinkto config.json · ${name}`, info })
    }
  }
  return found
}

function walkFiles(dir, filter, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    try {
      if (entry.isDirectory()) walkFiles(full, filter, out)
      else if (entry.isFile() && filter(entry.name)) out.push(full)
    } catch (error) {
      /* 跳过无权限的目录 */
    }
  }
  return out
}

/** 来源 2：Local Storage（leveldb 的 .ldb / .log） */
function readLocalStorageSources(root) {
  const files = walkFiles(
    root,
    (name) => name.endsWith('.ldb') || name.endsWith('.log'),
  )
  const found = []
  const seen = new Set()
  for (const file of files) {
    let stat
    try {
      stat = fs.statSync(file)
    } catch (error) {
      continue
    }
    if (stat.size === 0 || stat.size > MAX_SQLITE_FILE) continue

    let text
    try {
      // latin1 逐字节映射，保证 base64url 字符不被破坏
      text = fs.readFileSync(file).toString('latin1')
    } catch (error) {
      continue
    }
    const matches = text.match(JWT_RE)
    if (!matches) continue
    for (const token of matches) {
      if (seen.has(token)) continue
      seen.add(token)
      const info = jwtInfo(token)
      if (info) {
        found.push({ source: `vlinkto localstorage · ${path.basename(file)}`, info })
      }
    }
  }
  return found
}

/**
 * 查找当前可用的 token。
 * @returns {{ok: boolean, token?: string, username?: string, source?: string,
 *   issuedAt?: Date, expiresAt?: Date, remainingHours?: number, validCount?: number,
 *   error?: string}}
 */
function findToken(options = {}) {
  const root = options.root || path.join(appDataDir(), 'vlinkto')
  const includeExpired = Boolean(options.includeExpired)

  if (!fs.existsSync(root)) {
    return { ok: false, error: `未找到微联叮客户端数据目录：${root}（请先登录微联叮客户端）` }
  }

  const candidates = [...readConfigSource(root), ...readLocalStorageSources(root)]
  const now = Date.now()
  const valid = candidates
    .filter((item) => item.info.expiresAt.getTime() > now)
    .sort((a, b) => b.info.expiresAt - a.info.expiresAt)
  const expired = candidates
    .filter((item) => item.info.expiresAt.getTime() <= now)
    .sort((a, b) => b.info.expiresAt - a.info.expiresAt)

  const current = valid[0]
  if (!current) {
    const hint = expired.length
      ? `最近一枚已于 ${expired[0].info.expiresAt.toLocaleString('zh-CN')} 过期，请在微联叮客户端重新登录`
      : '客户端里没有找到 access-token，请在微联叮客户端重新登录'
    return {
      ok: false,
      error: hint,
      expiredToken: includeExpired && expired.length ? expired[0].info.token : undefined,
      expiredAt: includeExpired && expired.length ? expired[0].info.expiresAt : undefined,
    }
  }

  const remainingHours = (current.info.expiresAt.getTime() - now) / 3600000
  return {
    ok: true,
    token: current.info.token,
    username: current.info.username,
    source: current.source,
    issuedAt: current.info.issuedAt,
    expiresAt: current.info.expiresAt,
    remainingHours,
    validCount: valid.length,
    expiredCount: expired.length,
  }
}

module.exports = { findToken, decodeJwt, jwtInfo, appDataDir, JWT_FULL_RE }
