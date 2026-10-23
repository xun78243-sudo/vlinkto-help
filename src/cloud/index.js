'use strict'
/**
 * 主进程侧的「云手机」控制器。
 *
 * 职责：
 *   - 管一个 CloudSession（同一时间只连一台手机）
 *   - 把视频帧按批发给渲染进程（批量发送能显著减少 IPC 次数）
 *   - 把渲染进程的触控/按键/文字转成 scrcpy 控制消息写进 control socket
 *   - 设备列表、转无线、截图等 adb 便捷操作
 */

const fs = require('fs')
const path = require('path')

const { createAdb } = require('./adb')
const { CloudSession, CloudError } = require('./session')
const P = require('./protocol')

const FRAME_FLUSH_MS = 16

// 图片统一放到相册目录下的专用子目录；建目录失败时退回 Pictures 根目录
const IMAGE_DIR = '/sdcard/Pictures/CloudPhone'
const IMAGE_FALLBACK_DIR = '/sdcard/Pictures'
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']

function createCloudController({ send, log = () => {}, binaryDir }) {
  const adb = createAdb({ binaryDir, log })
  let session = null
  let pending = []
  let flushTimer = null
  let lastSessionSent = ''
  let sendingImages = false

  const info = () => (session ? session.info : {
    serial: '',
    state: 'idle',
    deviceName: '',
    codec: '',
    width: 0,
    height: 0,
    tunnel: '',
    paused: false,
    lastError: '',
    hint: '',
  })

  function emitState() {
    send('cloud:state', info())
  }

  function scheduleFlush() {
    if (flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      if (!pending.length) return
      const packets = pending
      pending = []
      const sessionInfo = lastSessionSent !== `${info().width}x${info().height}`
        ? { width: info().width, height: info().height }
        : null
      if (sessionInfo) lastSessionSent = `${info().width}x${info().height}`
      send('cloud:frames', {
        packets: packets.map((packet) => ({
          key: packet.key,
          config: packet.config,
          pts: packet.pts,
          data: packet.data,
        })),
        session: sessionInfo,
      })
    }, FRAME_FLUSH_MS)
  }

  function attach(target) {
    target.on('state', (payload) => {
      send('cloud:state', payload)
    })
    target.on('packet', (packet) => {
      // VideoFrame 用不到 config 以外的 flag，这里只保留 key/config/pts/data
      pending.push(packet)
      // 防止渲染进程卡住时无限堆积
      if (pending.length > 240) pending.splice(0, pending.length - 240)
      scheduleFlush()
    })
    target.on('session', ({ width, height }) => {
      lastSessionSent = `${width}x${height}`
    })
    target.on('device-message', (message) => {
      if (message.type === 'clipboard') {
        log(`[云手机] 手机剪贴板：${String(message.text || '').slice(0, 60)}`)
      }
    })
    target.on('closed', () => {
      send('cloud:state', target.info)
    })
    target.on('failed', (error) => {
      log(`[云手机] 会话异常：${error.message}`)
    })
  }

  async function start(serial) {
    if (!serial) throw new CloudError('请先选择设备')
    if (session) {
      if (session.serial === serial && session.state === 'running') return info()
      await stop()
    }
    session = new CloudSession({ adb, serial, binaryDir, log })
    attach(session)
    try {
      await session.start()
    } catch (error) {
      // 会话自己已经置为 error 并 emit 过状态，这里吞掉避免 unhandled rejection
      log(`[云手机] 连接失败：${error.message}`)
    }
    return info()
  }

  async function stop() {
    if (!session) return info()
    const current = session
    session = null
    pending = []
    lastSessionSent = ''
    await current.stop()
    return info()
  }

  async function devices() {
    try {
      await adb.startServer()
      return await adb.listDevices()
    } catch (error) {
      log(`[云手机] 读取设备列表失败：${error.message}`)
      return []
    }
  }

  function input(payload) {
    if (!session || session.state !== 'running') return { ok: false, error: '手机未连接' }
    const { kind } = payload

    if (kind === 'touch') {
      const e = payload.event || {}
      return { ok: session.send(P.touchEvent(e)) }
    }
    if (kind === 'key') {
      const e = payload.event || {}
      return { ok: session.send(P.keyEvent(e.action, e.keycode, e.repeat || 0, e.metaState || 0)) }
    }
    if (kind === 'text') {
      const text = (payload.payload && payload.payload.text) || ''
      if (!text) return { ok: false }
      // 单条消息上限 300 字节，长文本按字节切片分多条发送
      let ok = true
      for (const chunk of splitUtf8(text, 300)) {
        ok = session.send(P.textEvent(chunk)) && ok
      }
      return { ok }
    }
    if (kind === 'scroll') {
      return { ok: session.send(P.scrollEvent(payload.event || {})) }
    }
    if (kind === 'rotate') {
      return { ok: session.send(P.rotateDevice()) }
    }
    if (kind === 'notification') {
      return { ok: session.send(P.expandNotificationPanel()) }
    }
    if (kind === 'displayPower') {
      // 切换屏幕电源：亮着就灭，灭着就亮
      const on = !(payload.on === true)
      return { ok: session.send(P.displayPower(on)) }
    }
    return { ok: false }
  }

  function pause(value) {
    if (!session) return info()
    session.setPaused(value)
    if (value) pending = []
    return info()
  }

  async function screenshot() {
    if (!session) return { ok: false, error: '手机未连接' }
    const serial = session.serial
    const dir = global.__cloudShotDir || process.cwd()
    const file = path.join(dir, `cloud-${Date.now()}.png`)
    try {
      const result = await adb.run(['exec-out', 'screencap', '-p'], {
        serial,
        timeout: 30000,
        allowFail: true,
      })
      if (result.code !== 0) {
        return { ok: false, error: (result.stderr || '').trim() || 'screencap 执行失败' }
      }
      const buffer = result.stdoutBuffer || Buffer.from(result.stdout, 'latin1')
      if (buffer.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') {
        return { ok: false, error: '返回内容不是 PNG' }
      }
      fs.writeFileSync(file, buffer)
      return { ok: true, file }
    } catch (error) {
      return { ok: false, error: error.message }
    }
  }

  /** 当前投屏会话的 serial；没连上返回空串 */
  function connectedSerial() {
    return session && session.state === 'running' ? session.serial : ''
  }

  /** 手机上的图片目录：优先专用子目录，建不出来就退回 Pictures 根目录 */
  async function imageDir(serial) {
    for (const dir of [IMAGE_DIR, IMAGE_FALLBACK_DIR]) {
      const result = await adb.run(['shell', 'mkdir', '-p', dir], {
        serial,
        timeout: 15000,
        allowFail: true,
      })
      if (result.code === 0) return dir
    }
    throw new Error('手机上无法创建图片保存目录')
  }

  async function remoteNames(serial, dir) {
    const result = await adb.run(['shell', 'ls', dir], {
      serial,
      timeout: 15000,
      allowFail: true,
    })
    const names = new Set()
    if (result.code !== 0) return names
    for (const line of result.stdout.split(/\r?\n/)) {
      const name = line.trim()
      if (name) names.add(name)
    }
    return names
  }

  /**
   * 把本地图片 push 到手机相册目录，并通知媒体库扫描。
   * 单张失败不影响其余文件；返回结果给界面展示。
   * @param {string[]} localPaths 文件选择框选中的本地路径
   */
  async function sendImages(localPaths) {
    if (!connectedSerial()) return { ok: false, error: '手机未连接' }
    if (sendingImages) return { ok: false, error: '正在发送上一批图片，请稍候' }

    const paths = Array.isArray(localPaths) ? localPaths.filter(Boolean) : []
    if (!paths.length) return { ok: false, canceled: true, error: '', sent: 0, failed: 0, files: [], errors: [] }

    sendingImages = true
    const serial = connectedSerial()
    try {
      let dir
      try {
        dir = await imageDir(serial)
      } catch (error) {
        return {
          ok: false,
          error: error.message,
          sent: 0,
          failed: paths.length,
          files: [],
          errors: [],
        }
      }

      // 先列一次目录，重名时追加 -1/-2，避免悄悄覆盖手机上已有的图片
      const existing = await remoteNames(serial, dir).catch((error) => {
        log(`[云手机] 读取图片目录失败，继续发送：${error.message}`)
        return new Set()
      })
      const files = []
      const errors = []

      for (const local of paths) {
        try {
          const stat = fs.statSync(local)
          if (!stat.isFile()) throw new Error('不是文件')
          if (!stat.size) throw new Error('文件是空的')
          const ext = path.extname(local).toLowerCase()
          if (!IMAGE_EXTENSIONS.includes(ext)) {
            throw new Error(`不支持的图片格式：${ext || '（无扩展名）'}`)
          }

          const name = uniqueName(safeImageName(path.basename(local)), existing)
          const remote = `${dir}/${name}`
          await adb.pushFile(serial, local, remote)
          try {
            const scanned = await adb.scanFile(serial, remote)
            if (scanned.code !== 0) {
              log(`[云手机] 媒体扫描失败（图片已推送）：${(scanned.stderr || '').trim() || remote}`)
            }
          } catch (scanError) {
            // 扫描只是让相册立刻看到，失败不改变「图片已发送」的事实
            log(`[云手机] 媒体扫描失败（图片已推送）：${scanError.message}`)
          }

          files.push({ local, remote, name, size: stat.size })
          log(`[云手机] 图片已发送：${path.basename(local)} → ${remote}`)
        } catch (error) {
          errors.push({ local, error: error.message })
          log(`[云手机] 图片发送失败：${path.basename(local)}（${error.message}）`)
        }
      }

      const errorText = errors.length
        ? (files.length ? `${errors.length} 张图片发送失败` : errors[0].error)
        : ''
      return {
        ok: files.length > 0,
        canceled: false,
        sent: files.length,
        failed: errors.length,
        dir,
        files,
        errors,
        error: errorText,
      }
    } finally {
      sendingImages = false
    }
  }

  async function enableWireless(serial) {
    const ip = await adb.deviceIp(serial)
    if (!ip) return ''
    await adb.tcpip(serial, 5555)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const result = await adb.connect(`${ip}:5555`)
    if (/connected/.test(result)) return `${ip}:5555`
    return ''
  }

  return {
    info,
    emitState,
    start,
    stop,
    devices,
    input,
    pause,
    screenshot,
    sendImages,
    enableWireless,
    isConnected: () => Boolean(connectedSerial()),
    adb,
  }
}

/** 按 UTF-8 字节切分字符串，避免把多字节字符截断 */
function splitUtf8(text, maxBytes) {
  const out = []
  let current = ''
  let bytes = 0
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (bytes + size > maxBytes) {
      if (current) out.push(current)
      current = char
      bytes = size
    } else {
      current += char
      bytes += size
    }
  }
  if (current) out.push(current)
  return out
}

/**
 * 远程文件名只去掉文件系统和 shell 不安全的字符，中文、空格保留，
 * 这样手机相册/文件选择器里还能认出原来叫什么。
 */
function safeImageName(name) {
  const original = String(name || '')
  const ext = path.extname(original).toLowerCase()
  const stem = path.basename(original, path.extname(original))
    .replace(/[\\/:*?"<>|'`$;&\r\n\t]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 60)
  return `${stem || 'image'}${ext}`
}

/** 同名文件追加 -1 / -2，避免覆盖手机上已有的图片 */
function uniqueName(name, existing) {
  const ext = path.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let candidate = name
  let index = 1
  while (existing.has(candidate)) {
    candidate = `${stem}-${index}${ext}`
    index += 1
  }
  existing.add(candidate)
  return candidate
}

module.exports = { createCloudController, safeImageName, uniqueName }
