'use strict'
/**
 * 工单到期提醒自检：拉一次真实待办列表，按当前时间算出「今天到期」和「这一轮该弹的通知」。
 * 只读接口，不发通知（想验证 Windows 通知本身，用界面上的「测试通知」）。
 *
 *   node scripts/check-reminder.js               # 按当前时间算
 *   node scripts/check-reminder.js --at=17:31    # 假装现在是今天 17:31
 *   node scripts/check-reminder.js --at="2026-10-21 17:31"
 */

const path = require('path')

const store = require(path.join(__dirname, '..', 'src', 'config.js'))
const { findToken } = require(path.join(__dirname, '..', 'src', 'token.js'))
const reminder = require(path.join(__dirname, '..', 'src', 'reminder', 'index.js'))

function pad2(value) {
  return String(value).padStart(2, '0')
}

function clock(date) {
  if (!date) return '—'
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

function full(date) {
  if (!date) return '—'
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
    + `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** --at=HH:mm 或 --at="YYYY-MM-DD HH:mm"；只填时间就用今天。 */
function parseAt(text, now) {
  const raw = String(text || '').trim()
  if (!raw) return now
  let match = /^(\d{1,2}):(\d{2})$/.exec(raw)
  if (match) {
    const date = new Date(now)
    date.setHours(Number(match[1]), Number(match[2]), 0, 0)
    return date
  }
  match = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/.exec(raw)
  if (match) {
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]),
      Number(match[4]), Number(match[5]), 0, 0)
  }
  throw new Error(`看不懂的时间：${raw}（支持 17:31 或 "2026-10-21 17:31"）`)
}

function argOf(name) {
  const prefix = `--${name}=`
  const hit = process.argv.find((item) => item.startsWith(prefix))
  if (hit) return hit.slice(prefix.length)
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : ''
}

async function main() {
  const userDir = process.env.APPDATA ? path.join(process.env.APPDATA, '微联叮小助手') : ''
  const cfg = userDir ? store.loadConfig(userDir) : store.DEFAULTS
  const conf = cfg.reminder || store.DEFAULTS.reminder

  const tokenInfo = findToken()
  if (!tokenInfo.ok) throw new Error(`拿不到 access-token：${tokenInfo.error}`)

  const now = parseAt(argOf('at'), new Date())
  console.log(`接口：${conf.apiHost}${conf.listPath}`)
  console.log(`typeId=${conf.typeId} sortRole=${conf.sortRole} applyState=${conf.applyState} `
    + `plan=${conf.plan} pageSize=${conf.pageSize}`)
  console.log(`现在：${full(now)}${argOf('at') ? '（--at 模拟）' : ''}`)

  const fetched = await reminder.fetchPending(conf, tokenInfo.token, {
    log: (level, message) => console.log(`  [${level}] ${message}`),
  })
  console.log(`\n待办 ${fetched.items.length} 条（翻页 ${fetched.pages} 次，totalCount=${fetched.totalCount}）：`)

  const rows = fetched.items.map((item) => reminder.describeItem(item, now, conf))
  for (const row of rows) {
    const deadline = row.deadlineAt ? new Date(row.deadlineAt) : null
    console.log(`  ${row.ticketNo}  ${row.title.slice(0, 30)}`)
    console.log(`      截止 ${row.deadlineText}（解析 ${full(deadline)}，来源 ${row.deadlineSource || '未知'}）`)
    console.log(`      今天到期=${row.isToday ? '是' : '否'}`
      + ` 窗口=${row.window || '—'}`
      + ` 提醒点=${row.window ? clock(new Date(row.notifyAt)) : '—'}`)
  }

  const today = rows.filter((row) => row.isToday)
  const due = reminder.dueNotifications(fetched.items, now, conf, {})
  const messages = reminder.buildNotifications(due)

  console.log(`\n今天到期 ${today.length} 条（18:00 前 `
    + `${today.filter((row) => row.window === 'soon').length} 条、18:00 后 `
    + `${today.filter((row) => row.window === 'evening').length} 条）`)
  console.log(`这一轮该弹 ${messages.length} 条：`)
  for (const message of messages) {
    console.log(`  · ${message.title}`)
    for (const line of String(message.body).split('\n')) console.log(`      ${line}`)
  }
  if (!messages.length) console.log('  （没有到点的：18:00 前的单子在截止前 '
    + `${conf.advanceMinutes} 分钟内提醒，18:00 后的统一 ${conf.eveningNotifyTime} 提醒）`)

  console.log('\n工单到期提醒自检通过')
}

main().catch((error) => {
  console.error(`自检失败：${error && error.message ? error.message : error}`)
  process.exit(1)
})
