'use strict'
/** 统一 HTTP 封装：POST + query，可选 JSON body / 表单 body，失败退避重试。 */

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

class AuthError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AuthError'
  }
}

class ApiError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ApiError'
  }
}

function buildUrl(url, query) {
  if (!query) return url
  const entries = Object.entries(query).filter(([, v]) => v !== undefined && v !== null)
  if (!entries.length) return url
  const search = new URLSearchParams()
  for (const [key, value] of entries) search.append(key, String(value))
  return url + (url.includes('?') ? '&' : '?') + search.toString()
}

/**
 * @param {object} options
 * @param {string} options.url
 * @param {string} [options.method]
 * @param {string} [options.token]  会放到 access-token 头
 * @param {object} [options.query]  拼到 URL 上
 * @param {object} [options.body]   JSON body
 * @param {object} [options.form]   表单 body
 * @param {number} [options.timeout]
 * @param {number} [options.retries]
 * @param {Function} [options.log]
 */
async function httpJson(options) {
  const {
    url, method = 'POST', token = '', query, body, form,
    timeout = 30000, retries = 2, log = () => {},
  } = options

  const target = buildUrl(url, query)
  const headers = { Accept: 'application/json', 'User-Agent': USER_AGENT }
  if (token) headers['access-token'] = token

  let payload
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8'
    payload = new URLSearchParams(form).toString()
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json;charset=UTF-8'
    payload = JSON.stringify(body)
  }

  const attempts = Math.max(0, Number(retries) || 0) + 1
  let lastError = null

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const response = await fetch(target, {
        method, headers, body: payload, signal: controller.signal,
      })
      const text = await response.text()

      if (response.status === 401 || response.status === 403) {
        throw new AuthError(`HTTP ${response.status}: ${text.slice(0, 300)}`)
      }
      if (!response.ok) {
        throw new ApiError(`HTTP ${response.status}: ${text.slice(0, 300)}`)
      }
      if (!text) return {}
      try {
        return JSON.parse(text)
      } catch (error) {
        throw new ApiError(`响应不是 JSON：${text.slice(0, 200)}`)
      }
    } catch (error) {
      if (error instanceof AuthError) throw error

      const isAbort = error.name === 'AbortError'
      const isNetwork = error.name === 'TypeError' || /fetch failed/i.test(error.message || '')
      const isServerError = error instanceof ApiError && /^HTTP 5\d\d/.test(error.message)
      lastError = error instanceof ApiError ? error : new ApiError(isAbort
        ? `请求超时（${timeout}ms）` : `网络请求失败：${error.message}`)

      if (attempt >= attempts - 1 || !(isAbort || isNetwork || isServerError)) throw lastError

      const delay = 1500 * (attempt + 1)
      log('debug', `第 ${attempt + 1} 次请求失败（${lastError.message}），${delay}ms 后重试`)
      await new Promise((resolve) => setTimeout(resolve, delay))
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError || new ApiError('请求失败')
}

module.exports = { httpJson, AuthError, ApiError, USER_AGENT }
