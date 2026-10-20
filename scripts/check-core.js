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
// 四、可选：真实接口（只判定，不建日程）
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
