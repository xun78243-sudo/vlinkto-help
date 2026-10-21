'use strict'
/** 配置与幂等状态持久化（放在 app.getPath('userData') 下）。 */

const fs = require('fs')
const path = require('path')

const DEFAULTS = {
  api: {
    baseUrl: 'https://work.hanweb.com',
    chatRecordPath: '/api-gateway/jpaas-jim-web-server/manager/chatRecord/getChatRecord',
    transferKeyPath: '/api-gateway/jpaas-jim-web-server/front/app/common/find-busy-status',
    scheduleAddPath: '/api-gateway/jpaas-jcs-server/interface/permission/schedule/add',
    scheduleBodyMode: 'json',
    timeout: 30000,
    retries: 2,
  },
  chat: {
    userId: 'a5a9854995ee43d5a10f0e3c52d4e21b',
    groupId: 'cda6b214bd004867a1e46af520ad8696',
    chatType: 1,
    senderGroupNames: ['人力资源部'],
    maxPages: 10,
    skipMsgTypes: [1, 2, 3, 10, 11, 24, 25, 40, 44],
  },
  rules: {
    eventKeywords: ['考试', '考核', '培训', '学习', '讲座', '答题', '认证', '测评', '笔试', '实操'],
    audienceKeywords: ['所有人', '全体', '全员', '各位同事', '所有开发', '全体开发',
      '开发人员', '开发同学', '各部门', '全体员工'],
    excludeKeywords: ['取消', '改期', '作废'],
    requireAudienceKeyword: true,
  },
  schedule: {
    address: '',
    persons: 'a5a9854995ee43d5a10f0e3c52d4e21b',
    organizerId: 'a5a9854995ee43d5a10f0e3c52d4e21b',
    startTime: '17:00',
    endTime: '17:30',
    meetingId: '',
    meetingName: '',
    chatNotice: 1,
    remindNotice: 1,
    smsNotice: 0,
    emailNotice: 0,
    videoPower: 0,
    nameMaxLength: 50,
  },
  crypto: {
    sm2PrivateKey: 'cd763e25079384d25d3793251c3616742eba5b9f46be0675dedec6b1c64525e7',
    enableSm4: true,
    transferKey: '',
  },
  exam: {
    enabled: false,
    intervalHours: 3,
  },
  defect: {
    // 工单接口（与聊天记录接口同一个网关，共用自动获取的 access-token）
    apiHost: 'https://work.hanweb.com',
    listPath: '/api-gateway/jpaas-jtodo-server/manager/new-pending/list',
    detailPath: '/api-gateway/common-workflow-server/manager/business/pending/detail/formData',
    sortRole: 3,
    applyState: 0,
    pageSize: 100,
    maxTickets: 100,
    // 提交人过滤：账号 / 中文名，任意一项命中作者名或邮箱即算
    gitUser: 'xuning',
    gitName: '徐宁',
    // 仓库访问用的 GitLab 账号密码（留空则复用本机 git 凭据）。
    // 只存在本机 config.json 里，默认值保持空串，不进仓库。
    gitAuthUser: '',
    gitAuthPassword: '',
    defaultGitUrl: 'http://192.168.5.15/jpaas/jagent/be/jagent-web/tree/release-4.3.5.17',
    commitLimit: 20,
    fetchDepth: 200,
    gitTimeoutMs: 60000,
    // 内网 OpenAI 兼容推理服务
    aiBaseUrl: 'http://192.168.10.51:31587/common-inference-server/interface/v1',
    aiModel: 'Qwen3.6-27B',
    aiApiKey: '',
    aiTimeoutMs: 120000,
    aiMaxTokens: 2048,
    describeMaxChars: 4000,
    // 确认提交：AI 生成完成后自动创建一条 CMS 信息数据
    infoAddPath: '/api-gateway/jpaas-cms-server/manager/info/add',
    infoListPath: '/api-gateway/jpaas-cms-server/manager/info/list',
    infoWebId: '2bdebd6aee3f40668668dbddbee2e15f',
    infoColumnId: 'EQdL5HW2wo07vWzVjsxYr',
    infoSource: '产品研发一部',
    infoAuthor: '', // 留空 = 用 gitName（徐宁）
    infoAutoSubmit: true,
    infoPublish: true,
    infoTimeoutMs: 30000,
  },
  app: {
    closeToTray: true,
    autoLaunch: false,
    runOnStart: true,
    dryRun: false,
  },
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function deepMerge(base, override) {
  const result = Array.isArray(base) ? [...base] : { ...base }
  if (!isPlainObject(override)) return result
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(result[key])) result[key] = deepMerge(result[key], value)
    else result[key] = value
  }
  return result
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback
    return JSON.parse(stripBom(fs.readFileSync(file, 'utf8')))
  } catch (error) {
    return fallback
  }
}

function writeJsonAtomic(file, data) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

function configPath(dir) {
  return path.join(dir, 'config.json')
}

function statePath(dir) {
  return path.join(dir, 'state.json')
}

function logDir(dir) {
  return path.join(dir, 'logs')
}

function loadConfig(dir) {
  const merged = deepMerge(clone(DEFAULTS), readJson(configPath(dir), {}))
  // 兼容旧版本可能存在的 api.accessToken：只在需要手工兜底时使用
  return merged
}

function saveConfig(dir, cfg) {
  writeJsonAtomic(configPath(dir), cfg)
  return cfg
}

function resetConfig(dir) {
  const cfg = clone(DEFAULTS)
  writeJsonAtomic(configPath(dir), cfg)
  return cfg
}

function loadState(dir) {
  const state = readJson(statePath(dir), { processed: {} })
  if (!isPlainObject(state)) return { processed: {} }
  if (!isPlainObject(state.processed)) state.processed = {}
  return state
}

function saveState(dir, state) {
  writeJsonAtomic(statePath(dir), state)
}

/**
 * 首次启动时把旧 Python 版遗留的 state.json 合并进来，避免重复建日程。
 * @returns {number} 合并进来的条数
 */
function migrateLegacyState(dir, legacyFile) {
  if (fs.existsSync(statePath(dir))) return 0
  const legacy = readJson(legacyFile, null)
  if (!legacy || !isPlainObject(legacy.processed)) return 0
  const state = { processed: { ...legacy.processed } }
  saveState(dir, state)
  return Object.keys(state.processed).length
}

module.exports = {
  DEFAULTS,
  deepMerge,
  clone,
  readJson,
  writeJsonAtomic,
  configPath,
  statePath,
  logDir,
  loadConfig,
  saveConfig,
  resetConfig,
  loadState,
  saveState,
  migrateLegacyState,
}
