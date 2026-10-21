'use strict'
/**
 * 无 GUI 的核心自检：不启动 Electron，直接验证加密、规则、token 与真实接口。
 *
 *   node scripts/check-core.js          # 纯离线自检
 *   node scripts/check-core.js --live   # 额外跑一次真实接口（只判定，不建日程）
 */

const path = require('path')

const examDir = path.join(__dirname, '..', 'src', 'exam')
const cryptoMod = require(path.join(examDir, 'crypto.js'))
const im = require(path.join(examDir, 'im.js'))
const chat = require(path.join(examDir, 'chat.js'))
const store = require(path.join(__dirname, '..', 'src', 'config.js'))
const { findToken } = require(path.join(__dirname, '..', 'src', 'token.js'))

let failed = 0

function check(name, actual, expected) {
  const ok = String(actual) === String(expected)
  if (!ok) failed += 1
  console.log(`  [${ok ? 'ok' : 'FAIL'}] ${name}${ok ? '' : `\n        期望 ${expected}\n        实际 ${actual}`}`)
}

function section(title) {
  console.log(`\n${title}`)
}

// ============================================================================
// 一、国密算法
// ============================================================================

section('SM3 标准向量：')
check("sm3('abc')", cryptoMod.sm3(Buffer.from('abc')).toString('hex'),
  '66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0')
check("sm3('')", cryptoMod.sm3(Buffer.alloc(0)).toString('hex'),
  '1ab21d8355cfa17f8e61194831e81a8f22bec8c728fefb747ed035eb5082aa2b')
check("sm3('abcd'*16)", cryptoMod.sm3(Buffer.from('abcd'.repeat(16))).toString('hex'),
  'debe9ff92275b8a138604889c18e5a4d6fdb70e5387e5765293dcba39c0c5732')

section('HMAC-SM3 / SM4 标准向量：')
check('HMAC-SM3', cryptoMod.hmacSm3(Buffer.from('key'),
  Buffer.from('The quick brown fox jumps over the lazy dog')).toString('hex'),
'bd4a34077888162b210645b8ebf74b9af357303789357a27c7fc457244ebd398')
check('SM4 单分组', cryptoMod.sm4EncryptBlock(
  Buffer.from('0123456789abcdeffedcba9876543210', 'hex'),
  Buffer.from('0123456789abcdeffedcba9876543210', 'hex')).toString('hex'),
'681edf34d206965e86b3e94f536e4246')

section('SM2（C1C3C2，兼容 04 前缀）：')
const sm2Plain = '关于组织2026年10月安全生产考试的通知'
const sm2Cipher = '048746205dc36d75e81857b4a53b4968cb20fa84a22df02525beae081cdc6db6d1ef7f4704a1e992eafff4d786b344e2ab5982a3acdf24a61d65019f5389af4fba99a19e47aeb368601e113b18b7dd8bb0619cce4b1e51fdb4ccb5f1ef85b06f5214c247220295a95c10c1cd8966448761f12e9d385b43b120145ed835e0028de35f05ef244bf8a3fe97a21a7625aa388fea76d3'
const PRIV = 'cd763e25079384d25d3793251c3616742eba5b9f46be0675dedec6b1c64525e7'
check('带 04 前缀解密', cryptoMod.sm2Decrypt(sm2Cipher, PRIV).toString('utf8'), sm2Plain)
check('裸 C1 解密', cryptoMod.sm2Decrypt(sm2Cipher.slice(2), PRIV).toString('utf8'), sm2Plain)
check('加密解密往返', cryptoMod.sm2Decrypt(
  cryptoMod.sm2Encrypt(Buffer.from('往返测试'), cryptoMod.sm2PublicKeyFromPrivate(PRIV)), PRIV).toString('utf8'),
'往返测试')

section('SM4 传输链路（与 transferCrypto 一致）：')
const sm4Plain = '《数据安全》培训，要求全员参加并通过考试'
const sm4Cipher = 'AAECAwQFBgcICQoLDA0OD3YyE3FYDe1LCelq0S/PriUKqwFHs2Lj4eXLXAKufT3mfQ0vD8AXjR89lAfIvYghzt3y6c0+T70U9s5Pkr5qmAjE7fIPfp6g9iYEJGU8W8LSYCPvogMshzPXVEvLnn1Vpg=='
const MSG_ID = '75994933266271585864372656477345'
const SESSION = 'cda6b214bd004867a1e46af520ad8696'
const TRANSFER_KEY = 'sig-abcdef123456'
check('decryptSm4Transfer',
  im.decryptSm4Transfer(sm4Cipher, MSG_ID, SESSION, TRANSFER_KEY).toString('utf8'), sm4Plain)
check('篡改密文被 HMAC 拒绝',
  im.decryptSm4Transfer(`${sm4Cipher.slice(0, -8)}AAAAAAA=`, MSG_ID, SESSION, TRANSFER_KEY), null)
check('错误 transferKey 解不开',
  im.decryptSm4Transfer(sm4Cipher, MSG_ID, SESSION, 'wrong'), null)

section('密文形态识别 / 解密门面：')
check('hex -> SM2', im.classifyCipher(sm2Cipher), 'hex')
check('b64 -> SM4', im.classifyCipher(sm4Cipher), 'b64')
check('普通中文 -> 明文', im.classifyCipher('今天下午开会'), 'null')
const ctx = { sm2PrivateKey: PRIV, transferKey: TRANSFER_KEY, groupId: SESSION }
check('门面识别 SM4', im.resolveContent({ msgId: MSG_ID, content: sm4Cipher }, ctx).how, 'sm4')
check('门面识别 SM2', im.resolveContent({ msgId: 'x', content: sm2Cipher }, ctx).how, 'sm2')
check('门面识别明文', im.resolveContent({ msgId: 'x', content: '关于考试的通知' }, ctx).how, 'plain')
check('门面识别空消息', im.resolveContent({ msgId: 'x', content: '' }, ctx).how, 'empty')
check('缺 transferKey 判 failed',
  im.resolveContent({ msgId: 'x', content: sm4Cipher }, { groupId: SESSION }).how, 'failed')

// ============================================================================
// 二、规则与标题
// ============================================================================

const rules = store.DEFAULTS.rules

section('规则匹配：')
check('全员考试命中', chat.isQualified('请全体人员参加安全生产考试', rules).ok, 'true')
check('@所有人培训命中',
  chat.isQualified('@_{"all":"true"}_@《数据安全》培训，要求公司全员参加', rules).ok, 'true')
check('无关内容不命中', chat.isQualified('今天食堂有红烧肉', rules).ok, 'false')
check('考试但未要求全员',
  chat.isQualified('请相关同事参加考试', rules).detail, '命中关键词 考试，但未要求所有人/所有开发参与')
check('取消类排除', chat.isQualified('全体人员考试取消了', rules).detail, '命中排除词 取消')

section('标题规整：')
check('去 @所有人 占位符',
  chat.buildScheduleName('关于考试 {"all":true} 的通知', 50), '关于考试 所有人 的通知')
check('去 @提醒包装',
  chat.buildScheduleName('@_{"all":"true"}_@《数据安全》培训\n要求全员参加', 50), '《数据安全》培训')
check('取首行作标题', chat.buildScheduleName('第一行标题\n第二行正文', 50), '第一行标题')
check('超长截断', chat.buildScheduleName('考'.repeat(100), 50).length, '50')

section('部门匹配：')
check('精确匹配', chat.matchDepartment('人力资源部', ['人力资源部']), '人力资源部')
check('包含匹配', chat.matchDepartment('人力资源部（总部）', ['人力资源部']), '人力资源部')
check('其他部门不命中', chat.matchDepartment('研发部', ['人力资源部']), '')
check('空部门不命中', chat.matchDepartment('', ['人力资源部']), '')

section('建日程入参：')
const payload = chat.buildSchedulePayload(store.DEFAULTS, '测试日程', '2026-10-20')
check('字段集合与接口一致', Object.keys(payload).join(','),
  'scheduleName,address,persons,organizerId,endDate,startDate,startTime,endTime,'
  + 'meetingId,meetingName,chatNotice,remindNotice,smsNotice,emailNotice,videoPower')
check('日期取当天', `${payload.startDate}/${payload.endDate}`, '2026-10-20/2026-10-20')
check('默认时间窗', `${payload.startTime}-${payload.endTime}`, '17:00-17:30')

section('消息唯一键：')
const base = { userid: 'u1', time: 1792461900000, content: '全体人员参加考试' }
check('无 msgId 时同内容同键', chat.messageKey(base), chat.messageKey({ ...base }))
check('无 msgId 时不同内容不同键',
  chat.messageKey(base) === chat.messageKey({ ...base, content: '另一条消息' }), 'false')
check('有 msgId 时优先使用', chat.messageKey({ msgId: 'abc', content: 'x' }), 'abc')

// ============================================================================
// 三、token 自动获取
// ============================================================================

section('token 自动获取：')
const tokenInfo = findToken()
check('能从微联叮客户端读到 token', tokenInfo.ok, 'true')
if (tokenInfo.ok) {
  console.log(`       用户=${tokenInfo.username} 来源=${tokenInfo.source}`
    + ` 剩余=${tokenInfo.remainingHours.toFixed(1)}h 有效副本=${tokenInfo.validCount}`)
  const claims = require(path.join(__dirname, '..', 'src', 'token.js')).decodeJwt(tokenInfo.token)
  check('JWT 解析到 exp', Boolean(claims && claims.exp), 'true')
}

// ============================================================================
// 四、缺陷单总结助手：纯函数
// ============================================================================

const defectTicket = require(path.join(__dirname, '..', 'src', 'defect', 'ticket.js'))
const defectGit = require(path.join(__dirname, '..', 'src', 'defect', 'git.js'))
const defectAi = require(path.join(__dirname, '..', 'src', 'defect', 'ai.js'))
const defectInfo = require(path.join(__dirname, '..', 'src', 'defect', 'info.js'))

section('单号 / iid 解析：')
check('大写并去空格', defectTicket.normalizeTicketNo(' jetable2026101400071 '), 'JETABLE2026101400071')
check('相对地址取 iid', defectTicket.extractIid('/index.html#/tododetail?iid=36cc6a62'), '36cc6a62')
check('绝对地址取 iid', defectTicket.extractIid('https://x/y/index.html#/tododetail?iid=abc&t=1'), 'abc')
check('无 iid 返回空', defectTicket.extractIid('https://x/y'), '')

section('工单详情 formData.model 解析：')
const modelPayload = {
  data: {
    prepareData: {
      formData: {
        model: JSON.stringify([
          { fieldName: 'nrxq', fieldValueTwo: 'claw后台重连超时' },
          { fieldName: 'banbenhao', fieldValueTwo: '4.3.8.2' },
        ]),
      },
    },
  },
}
check('JSON 字符串能解析成数组', defectTicket.parseModelFields(modelPayload).length, '2')
check('取 nrxq',
  defectTicket.pickField(defectTicket.parseModelFields(modelPayload), 'nrxq'), 'claw后台重连超时')
check('取 banbenhao',
  defectTicket.pickField(defectTicket.parseModelFields(modelPayload), 'banbenhao'), '4.3.8.2')
const badModelPayload = { data: { prepareData: { formData: { model: '{oops' } } } }
check('坏 JSON 返回 null', defectTicket.parseModelFields(badModelPayload), 'null')
check('缺字段返回空串', defectTicket.pickField(null, 'nrxq'), '')

section('git 地址解析：')
const parsedGit = defectGit.parseGitUrl(
  'http://192.168.5.15/jpaas/jagent/be/jagent-web/tree/release-4.3.5.17')
check('仓库路径', parsedGit.projectPath, 'jpaas/jagent/be/jagent-web')
check('分支', parsedGit.branch, 'release-4.3.5.17')
check('clone 地址', parsedGit.cloneUrl, 'http://192.168.5.15/jpaas/jagent/be/jagent-web.git')
check('提交地址前缀', parsedGit.commitUrlBase,
  'http://192.168.5.15/jpaas/jagent/be/jagent-web/-/commit/')
check('兼容 -/tree 写法', defectGit.parseGitUrl('http://h/g/p/-/tree/release-4.3.5.17').branch,
  'release-4.3.5.17')
check('分支名带斜杠', defectGit.parseGitUrl('http://h/g/p/tree/release/4.3').branch, 'release/4.3')
check('末尾斜杠容错', defectGit.parseGitUrl('http://h/g/p/tree/main/').branch, 'main')

section('仓库访问凭据：')
const authCfg = defectGit.authSetup({ user: 'u1', password: 'p#1' })
check('凭据走环境变量（不在命令行）', authCfg.env.GIT_CONFIG_COUNT, '1')
check('头部键名', authCfg.env.GIT_CONFIG_KEY_0, 'http.extraheader')
check('Basic 头内容正确',
  Buffer.from(String(authCfg.env.GIT_CONFIG_VALUE_0).replace('AUTHORIZATION: Basic ', ''),
    'base64').toString(), 'u1:p#1')
check('命令行只禁用凭据助手', authCfg.args.join(' '), '-c credential.helper=')
check('没填账号密码时不用认证', Object.keys(defectGit.authSetup({}).env).length, '0')
check('只填账号时退回本机凭据', Object.keys(defectGit.authSetup({ user: 'u1' }).env).length, '0')

section('提交人过滤与更新包拼装：')
const sampleCommits = [
  {
    hash: 'a1', short: 'a1', author: 'xuning', email: 'xn1458@hanweb.com',
    date: '2026-10-15', subject: 'fix:1', files: ['A.java'],
  },
  {
    hash: 'b2', short: 'b2', author: '陶学东', email: 'txd341@hanweb.net',
    date: '2026-10-14', subject: 'fix:2', files: ['B.java'],
  },
]
check('按账号过滤', defectGit.filterCommits(sampleCommits, { gitUser: 'xuning' }).length, '1')
check('按中文名过滤', defectGit.filterCommits(sampleCommits, { gitName: '陶学东' }).length, '1')
check('不匹配为 0', defectGit.filterCommits(sampleCommits, { gitUser: 'nobody' }).length, '0')
check('不配置则全通过', defectGit.filterCommits(sampleCommits, {}).length, '2')
check('commitLimit 生效', defectGit.filterCommits(sampleCommits, { limit: 1 }).length, '1')

const pathLine = defectGit.formatUpdatePath('  http://192.168.5.15/jpaas/jagent/be/jagent-web/tree/release-4.3.5.17  ')
check('更新包提交路径 = 入参地址原样', pathLine, '更新包提交路径：http://192.168.5.15/jpaas/jagent/be/jagent-web/tree/release-4.3.5.17')
check('地址为空时有兜底', defectGit.formatUpdatePath(''), '更新包提交路径：（未填写 git 地址）')

section('git log 输出解析：')
const logText = 'abc1234\u001fabc1234\u001fxuning\u001fxn1458@hanweb.com\u001f2026-10-15\u001ffix:x\n'
  + '\nsrc/A.java\nsrc/B.java\n'
  + 'def4567\u001fdef4567\u001fyuming\u001fym@hanweb.com\u001f2026-10-14\u001ffix:y\n'
const parsedLog = defectGit.parseLogOutput(logText)
check('解析提交数', parsedLog.length, '2')
check('首条文件数', parsedLog[0].files.length, '2')
check('首条 message', parsedLog[0].subject, 'fix:x')
check('末条无文件', parsedLog[1].files.length, '0')

section('AI 输出解析：')
check('纯 JSON', defectAi.extractJson('{"analysis":"a","measures":"b"}').measures, 'b')
check('带代码围栏', defectAi.extractJson('```json\n{"analysis":"a","measures":"b"}\n```').analysis, 'a')
check('带前后缀', defectAi.extractJson('结果：{"analysis":"a2","measures":"b2"} 完毕').analysis, 'a2')
check('非 JSON 返回 null', defectAi.extractJson('这不是 JSON'), 'null')
check('编号挤在一行时断行', defectAi.formatNumbered('第一点。2. 第二点。3. 第三点'),
  '第一点。\n2. 第二点。\n3. 第三点')
check('版本号不被误断行', defectAi.formatNumbered('版本 4.3.8.2 已修复'), '版本 4.3.8.2 已修复')

const aiMessages = defectAi.buildMessages({
  title: '标题A', description: '描述B', branch: 'release-4.3.5.17', commits: sampleCommits,
})
check('消息条数', aiMessages.length, '2')
check('system 要求输出 JSON', aiMessages[0].content.includes('JSON'), 'true')
check('user 带上标题', aiMessages[1].content.includes('标题A'), 'true')
check('user 带上提交', aiMessages[1].content.includes('fix:1'), 'true')
check('描述按上限截断',
  defectAi.buildMessages({ title: 'x', description: 'D'.repeat(5000), describeMaxChars: 100 })
    .length, '2')

section('确认提交：信息数据入参：')
const infoSampleFields = {
  title: '项目和产品缺陷_演示（钱芳清）',
  description: '描述第一行\n描述第二行 <tag> & "引号"',
  analysis: '1. 分析一\n2. 分析二',
  measures: '1. 措施一\n\n更新包提交路径：http://h/p/tree/b',
}
const infoPayload = defectInfo.buildInfoPayload({
  fields: infoSampleFields,
  ticketNo: 'JETABLE2026101400071',
  cfg: { gitName: '徐宁', infoSource: '产品研发一部' },
  now: 1792555313268,
})
const infoTitle = JSON.stringify({ text: infoSampleFields.title, style: {} })
check('title = 工单标题', infoPayload.title, infoTitle)
check('jsonTitle 与 title 一致', infoPayload.jsonTitle, infoTitle)
check('titleText = 工单标题', infoPayload.titleText, infoSampleFields.title)
check('iid 是 32 位 hex', /^[0-9a-f]{32}$/.test(infoPayload.iid), 'true')
check('iid 每次不同', infoPayload.iid === defectInfo.newIid(), 'false')
check('author = gitName', infoPayload.author, '徐宁')
check('source 取配置', infoPayload.source, '产品研发一部')
check('deployTime = 传入时间', infoPayload.deployTime, '1792555313268')
check('webId 同步到 contentAttributeEntity',
  infoPayload.contentAttributeEntity.webId, infoPayload.webId)

const infoList = infoPayload.extendsEntity.elementList
const byField = (name) => (infoList.find((item) => item.fieldName === name) || {}).fieldValue
check('elementList 7 个字段', infoList.length, '7')
check('标题字段值 = 工单标题', byField('biaoti'), infoSampleFields.title)
check('问题描述原样', byField('gdwtmx'), infoSampleFields.description)
check('分析过程为富文本', byField('gdfxgc').startsWith('<p><span style="'), 'true')
check('分析过程两段', (byField('gdfxgc').match(/<p>/g) || []).length, '2')
check('信息内容含分析文本', byField('gdfxgc').includes('2. 分析二'), 'true')
check('措施保留更新包路径', byField('gdclcsjlj').includes('更新包提交路径：http://h/p/tree/b'), 'true')
check('富文本转义了尖括号', defectInfo.toRichText('a < b & c'),
  `<p><span style="${defectInfo.SPAN_STYLE}">a &lt; b &amp; c</span></p>`)
check('infoContent 与 elementList 同步',
  infoPayload.extendsEntity.infoContent, JSON.stringify(infoList))
check('固定选项保持原样', byField('gongdlx'), 'pSrHI3jbsOVgimdLIA9pj')
check('标题为空退回工单号',
  defectInfo.buildInfoPayload({ fields: { title: '' }, ticketNo: 'JET1' }).titleText, 'JET1')
check('空内容不报错',
  defectInfo.buildInfoPayload({ fields: {} }).extendsEntity.elementList.length, '7')
check('默认直接发布', infoPayload.state, 'published')
check('发布时间 = deployTime', infoPayload.releaseTime, String(infoPayload.deployTime))
check('publishTime 已填', infoPayload.publishTime, String(infoPayload.deployTime))
check('关掉发布则不带 state',
  defectInfo.buildInfoPayload({ fields: {}, cfg: { infoPublish: false } }).state, 'undefined')

section('确认提交：从信息列表取地址：')
const listPayload = {
  code: '200',
  data: {
    list: [
      { iid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', fullUrl: 'https://h/art_aaa.html', state: 'published' },
      {
        iid: '718594bbc9cf4172aa50c714d32ee744',
        fullUrl: 'https://work.hanweb.com/wd/gdzsk/art/2026/art_718594bbc9cf4172aa50c714d32ee744.html',
        state: 'published',
        titleText: '标题A',
      },
    ],
  },
}
const parsedUrl = defectInfo.parseInfoList(listPayload, '718594bbc9cf4172aa50c714d32ee744')
check('按 iid 命中', parsedUrl.found, 'true')
check('取到 fullUrl', parsedUrl.url,
  'https://work.hanweb.com/wd/gdzsk/art/2026/art_718594bbc9cf4172aa50c714d32ee744.html')
check('带上 state', parsedUrl.state, 'published')
check('iid 不存在返回空', defectInfo.parseInfoList(listPayload, 'ffff').url, '')
check('空响应不报错', defectInfo.parseInfoList(null, 'x').url, '')
check('列表为空返回空', defectInfo.parseInfoList({ data: { list: [] } }, 'x').found, 'false')
check('没有 fullUrl 时退回 url 字段',
  defectInfo.parseInfoList({ data: { list: [{ iid: 'i1', url: '/u/1' }] } }, 'i1').url, '/u/1')

// ============================================================================
// 五、可选：真实接口（只判定，不建日程）
// ============================================================================

async function live() {
  section('真实接口（dry-run，不建日程）：')
  if (!tokenInfo.ok) {
    console.log('  跳过：没有可用 token')
    return
  }
  const state = { processed: {} }
  const stats = await chat.runOnce(store.DEFAULTS, tokenInfo.token, state, {
    dryRun: true,
    log: (level, message) => {
      if (level !== 'debug') console.log(`  [${level}] ${message}`)
    },
  })
  console.log(`  共 ${stats.total} 条 / 本部门 ${stats.dept} 条 / 当天 ${stats.today} 条 / `
    + `命中 ${stats.qualified} 条 / 将建 ${stats.created} 条 / 解密失败 ${stats.undecrypted} 条`)
  check('确实取到了消息', stats.total > 0, 'true')
  check('没有解密失败', stats.undecrypted, '0')
}

live().then(() => {
  console.log(failed ? `\n失败 ${failed} 项` : '\n自检全部通过')
  process.exit(failed ? 1 : 0)
}).catch((error) => {
  console.error('\n执行出错：', error)
  process.exit(1)
})
