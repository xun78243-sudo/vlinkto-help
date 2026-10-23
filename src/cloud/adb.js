'use strict'
/**
 * 内置 adb 的薄封装：只做「起进程 + 收输出 + 超时保护」。
 * 内置的 adb.exe 与 AdbWinApi/AdbWinUsbApi.dll 放在 assets/cloud 下，
 * 用户无需自己装 Android Platform-Tools。
 */

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const DEFAULT_TIMEOUT = 20000

class AdbError extends Error {
  constructor(message, detail) {
    super(message)
    this.name = 'AdbError'
    this.detail = detail || ''
  }
}

function createAdb({ binaryDir, log = () => {} }) {
  const adbPath = path.join(binaryDir, process.platform === 'win32' ? 'adb.exe' : 'adb')
  let serverStarted = false

  function exists() {
    try {
      return fs.statSync(adbPath).isFile()
    } catch (error) {
      return false
    }
  }

  /**
   * 运行一次 adb，收集 stdout/stderr。
   * @param {string[]} args
   * @param {{timeout?: number, serial?: string, allowFail?: boolean}} options
   */
  function run(args, options = {}) {
    const { timeout = DEFAULT_TIMEOUT, serial, allowFail = false } = options
    const full = serial ? ['-s', serial, ...args] : args.slice()

    return new Promise((resolve, reject) => {
      if (!exists()) {
        reject(new AdbError(`找不到内置 adb：${adbPath}`))
        return
      }

      let child
      try {
        child = spawn(adbPath, full, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        reject(new AdbError(`启动 adb 失败：${error.message}`))
        return
      }

      const out = []
      const err = []
      let settled = false

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { child.kill() } catch (error) { /* ignore */ }
        reject(new AdbError(`adb 超时（${Math.round(timeout / 1000)}s）：adb ${full.join(' ')}`,
          Buffer.concat(err).toString('utf8')))
      }, timeout)

      child.stdout.on('data', (chunk) => out.push(chunk))
      child.stderr.on('data', (chunk) => err.push(chunk))

      child.on('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new AdbError(`adb 执行出错：${error.message}`))
      })

      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const stdoutBuffer = Buffer.concat(out)
        const stdout = stdoutBuffer.toString('utf8')
        const stderr = Buffer.concat(err).toString('utf8')
        if (code !== 0 && !allowFail) {
          reject(new AdbError(`adb ${full.join(' ')} 失败（exit ${code}）`,
            (stderr || stdout).trim()))
          return
        }
        // stdoutBuffer 给 screencap 这类二进制输出用（PNG 走 exec-out 是原始字节）
        resolve({ code, stdout, stdoutBuffer, stderr })
      })
    })
  }

  /** adb start-server，只做一次 */
  async function startServer() {
    if (serverStarted) return
    await run(['start-server'], { timeout: 30000, allowFail: true })
    serverStarted = true
  }

  /**
   * adb devices -l 的解析结果。
   * 行格式：<serial>  <state>  product:.. model:.. device:.. transport_id:..
   */
  async function listDevices() {
    await startServer()
    const { stdout } = await run(['devices', '-l'], { timeout: 15000, allowFail: true })
    const devices = []
    for (const raw of stdout.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('List of devices')) continue
      if (line.startsWith('*')) continue
      const parts = line.split(/\s+/)
      if (parts.length < 2) continue
      const serial = parts[0]
      const state = parts[1]
      const info = {}
      for (const item of parts.slice(2)) {
        const index = item.indexOf(':')
        if (index > 0) info[item.slice(0, index)] = item.slice(index + 1)
      }
      devices.push({
        serial,
        state,
        product: info.product || '',
        model: info.model || '',
        device: info.device || '',
        transportId: info.transport_id || '',
        wireless: /^\d+\.\d+\.\d+\.\d+(:\d+)?$/.test(serial)
          || serial.includes(':') && /^\d/.test(serial),
      })
    }
    return devices
  }

  /** 设备屏幕尺寸（物理像素），供没有视频流时兜底计算坐标 */
  async function screenSize(serial) {
    const { stdout } = await run(['shell', 'wm', 'size'], { serial, allowFail: true })
    const override = /Override size:\s*(\d+)x(\d+)/.exec(stdout)
    const physical = /Physical size:\s*(\d+)x(\d+)/.exec(stdout)
    const match = override || physical
    if (!match) return null
    return { width: Number(match[1]), height: Number(match[2]) }
  }

  async function androidVersion(serial) {
    const { stdout } = await run(['shell', 'getprop', 'ro.build.version.release'],
      { serial, allowFail: true })
    return stdout.trim()
  }

  async function pushFile(serial, localPath, remotePath) {
    await run(['push', localPath, remotePath], { serial, timeout: 60000 })
  }

  /**
   * 通知手机媒体库重新扫描某个文件，让刚 push 上去的图片立刻出现在相册。
   * Android 8+ 对隐式广播有限制，但 MEDIA_SCANNER_SCAN_FILE 由系统
   * MediaScannerReceiver 处理，实测可用；扫描失败不影响文件已经传上去。
   */
  async function scanFile(serial, remotePath) {
    const uri = `file://${encodeRemotePath(remotePath)}`
    return run([
      'shell', 'am', 'broadcast',
      '-a', 'android.intent.action.MEDIA_SCANNER_SCAN_FILE',
      '-d', uri,
    ], { serial, timeout: 15000, allowFail: true })
  }

  async function removeFile(serial, remotePath) {
    await run(['shell', 'rm', '-f', remotePath], { serial, allowFail: true })
  }

  /** adb reverse <deviceSocket> tcp:<port>：设备 → 电脑（scrcpy 默认优先） */
  async function reverse(serial, remote, localPort) {
    await run(['reverse', `tcp:${localPort}`, remote], { serial, allowFail: true })
  }

  async function reverseRemove(serial, remote) {
    await run(['reverse', '--remove', remote], { serial, allowFail: true })
  }

  async function reverseRemoveAll(serial) {
    await run(['reverse', '--remove-all'], { serial, allowFail: true })
  }

  /** adb forward tcp:<port> <deviceSocket>：电脑 → 设备（reverse 失败时回退） */
  async function forward(serial, localPort, remote) {
    await run(['forward', `tcp:${localPort}`, remote], { serial, allowFail: true })
  }

  async function forwardRemove(serial, localPort) {
    await run(['forward', '--remove', `tcp:${localPort}`], { serial, allowFail: true })
  }

  async function forwardRemoveAll(serial) {
    await run(['forward', '--remove-all'], { serial, allowFail: true })
  }

  /** 把无线调试设备变成可通过局域网连接（等价 scrcpy --tcpip） */
  async function tcpip(serial, port = 5555) {
    await run(['tcpip', String(port)], { serial, timeout: 20000 })
  }

  async function connect(address) {
    const { stdout } = await run(['connect', address], { timeout: 20000, allowFail: true })
    return stdout.trim()
  }

  async function disconnect(address) {
    await run(['disconnect', address], { timeout: 15000, allowFail: true })
  }

  /** 从 adb 的 "wifi_ip" 参数里取手机局域网 IP（scrcpy 同样做法） */
  async function deviceIp(serial) {
    const { stdout } = await run(['shell', 'ip', 'route'], { serial, allowFail: true })
    for (const line of stdout.split(/\r?\n/)) {
      const match = /src\s+(\d+\.\d+\.\d+\.\d+)/.exec(line)
      if (match) return match[1]
    }
    return ''
  }

  /** 启动长驻的 server 进程（app_process），返回子进程 */
  function spawnServer(serial, argv, log = () => {}) {
    const child = spawn(adbPath, ['-s', serial, 'shell', ...argv], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) log(line.trim())
      }
    })
    child.stderr.on('data', (chunk) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) log(line.trim())
      }
    })
    // adb 偶发非零退出（如设备休眠）时不要让异常逃到主进程
    child.on('error', (error) => log(`adb 子进程出错：${error.message}`))
    return child
  }

  return {
    adbPath,
    exists,
    run,
    startServer,
    listDevices,
    screenSize,
    androidVersion,
    pushFile,
    scanFile,
    removeFile,
    reverse,
    reverseRemove,
    reverseRemoveAll,
    forward,
    forwardRemove,
    forwardRemoveAll,
    tcpip,
    connect,
    disconnect,
    deviceIp,
    spawnServer,
  }
}

/**
 * 把手机上的绝对路径编码成可以安全塞进 adb shell 命令行的 file:// URI。
 * 文件名里的空格、中文、& 等都可能被设备端 shell 解释，必须逐段编码。
 */
function encodeRemotePath(remotePath) {
  return String(remotePath || '')
    .split('/')
    .map((segment) => encodeURIComponent(segment)
      .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/')
}

module.exports = { createAdb, AdbError, encodeRemotePath }
