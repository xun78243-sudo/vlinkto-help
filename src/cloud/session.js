'use strict'
/**
 * 云手机会话：把 scrcpy-server 推到手机、用 app_process 拉起，
 * 按 scrcpy 协议接出「视频 socket + 控制 socket」。
 *
 * 连接方式沿用 scrcpy 的做法（app/src/adb/adb_tunnel.c:124-145）：
 *   1. 先试 adb reverse（电脑监听，手机主动连），失败再回退 adb forward（电脑主动连）。
 *   2. 手机端建立 socket 顺序固定：video → audio → control
 *      （server/.../device/DesktopConnection.java:56-101），电脑端也必须按这个顺序。
 *   3. scrcpy 会先写 64 字节设备名（DesktopConnection.sendDeviceMeta），
 *      forward 模式下还有 1 个 dummy 字节（DesktopConnection.java:68-72）。
 *
 * 实测踩到的坑（都已写进处理逻辑）：
 *   - scrcpy-server 启动时立刻 unlink 自己的 jar（CleanUp.java:175-181），
 *     所以每次启动前必须重新 push，并且传 cleanup=false，
 *     否则下次连接会直接 "Aborted"（jar 已不在）。
 *   - 华为 Android 9 上 `adb reverse` 命令成功、`--list` 也有记录，但手机端
 *     LocalSocket 连回 PC 得到 "Connection refused"，即 adb 端不支持反向转发。
 *     所以 reverse 必须「手机真的连上来」才算可用，否则回退 forward。
 *   - reverse 失败后必须等旧 server 进程退出干净，否则它稍后去连 abstract socket
 *     会把新注册的 forward 端口"吃掉"（表现为连上后 0 字节立刻断开）。
 *   - socket 建连和首字节必须合并处理：一旦在 connect 后才挂 data 监听，
 *     首字节（dummy / 设备名）可能已经到达并被丢弃。
 *   - 编码器要等 control 通道就绪后才开始出帧；画面静止时 MediaCodec 不产帧属正常。
 */

const net = require('net')
const path = require('path')
const { EventEmitter } = require('events')

const { VideoStreamParser, DeviceMessageParser } = require('./protocol')

const SERVER_VERSION = '5.0.1'
const SERVER_DEVICE_PATH = '/data/local/tmp/scrcpy-server.jar'
const SERVER_SOCKET = 'scrcpy'
const DEVICE_NAME_LENGTH = 64

// 刻意避开 scrcpy 官方客户端用的 27183 起那一段：
// 两边共用同一个 adb server，forward 表是共享的，端口撞上就会互相抢 socket，
// 表现为「日志已连接但画面不出来」。这里用一段高位端口，互不干扰。
const PORT_CANDIDATES = [37300, 37310, 37320, 37330, 37340, 37350]
const REVERSE_PROBE_TIMEOUT = 3500
const CONNECT_TIMEOUT = 20000

class CloudError extends Error {
  constructor(message, hint) {
    super(message)
    this.name = 'CloudError'
    this.hint = hint || ''
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 端口是否空闲（能被我们 listen 成功）。用来避开同一台电脑上 scrcpy 客户端占着的端口。 */
function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, '127.0.0.1')
  })
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    const onError = (error) => reject(error)
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError)
      resolve(server)
    })
  })
}

/**
 * 等一条进入的连接，并顺手把首字节读掉（避免 connect 之后的监听空窗期丢数据）。
 * 回调式返回 { socket, firstChunk }，调用方自己对 socket 挂后续监听。
 */
function acceptOne(server, timeout, label) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new CloudError(`等待手机端建立 ${label} socket 超时`,
        '手机端 scrcpy-server 没能连回来，可能是手机休眠或该端口被占用'))
    }, timeout)
    const onConnection = (socket) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      server.removeListener('error', onError)
      socket.setNoDelay(true)
      // 一次性读首字节，读完再交给调用方
      socket.once('data', (chunk) => {
        resolve({ socket, firstChunk: chunk })
      })
      socket.once('error', (error) => {
        reject(new CloudError(`${label} socket 出错：${error.message}`))
      })
    }
    const onError = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new CloudError(`本地监听 ${label} 失败：${error.message}`))
    }
    server.once('connection', onConnection)
    server.once('error', onError)
  })
}

/**
 * 连本地转发端口。
 *
 * expectData=true（视频）：scrcpy-server 的 send_dummy_byte 只在第一个 accept 的
 *   socket 上写 1 个 0x00，所以这里可以等首字节确认对端真的就绪。
 * expectData=false（控制）：dummy 字节已经在视频那条用掉了（DesktopConnection.open
 *   里 sendDummyByte 置 false），control 上不会再有数据，等首字节必然超时，
 *   因此 connect 成功即视为就绪。
 */
function connectOne(port, { expectData = true, timeout = CONNECT_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    socket.setNoDelay(true)
    let settled = false
    const fail = (message, hint) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.destroy() } catch (error) { /* ignore */ }
      reject(new CloudError(message, hint))
    }
    const timer = setTimeout(() => {
      fail(`连接本地端口 ${port} 超时`)
    }, timeout)
    socket.once('error', (error) => fail(`连接本地端口 ${port} 失败：${error.message}`))
    socket.once('connect', () => {
      if (!expectData) {
        settled = true
        clearTimeout(timer)
        resolve({ socket, firstChunk: Buffer.alloc(0) })
        return
      }
      socket.once('data', (chunk) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ socket, firstChunk: chunk })
      })
      // connect 之后到首字节之间可能对端直接关闭（远端已退出），给出明确错误
      socket.once('end', () => fail(`本地端口 ${port} 的对端已关闭（手机端没有就绪）`))
      socket.once('close', () => fail(`本地端口 ${port} 的连接已断开`))
    })
  })
}

/** 丢掉首字节里的 dummy 0x00（如果存在），返回剩余字节 */
function stripDummy(chunk) {
  if (chunk && chunk.length && chunk[0] === 0) return chunk.slice(1)
  return chunk || Buffer.alloc(0)
}

class CloudSession extends EventEmitter {
  constructor({ adb, serial, binaryDir, log = () => {} }) {
    super()
    this.adb = adb
    this.serial = serial
    this.binaryDir = binaryDir
    this.log = log

    this.state = 'idle'
    this.serverProcess = null
    this.videoServer = null
    this.videoPort = 0
    this.forward = false
    this.forwardPorts = []

    this.videoSocket = null
    this.controlSocket = null
    this.videoParser = null
    this.controlParser = null

    this.deviceName = ''
    this.metaBuffer = Buffer.alloc(0)
    this.metaDone = false

    this.codec = ''
    this.width = 0
    this.height = 0
    this.firstPacketAt = 0
    this.paused = false
    this.lastError = ''
    this.hint = ''
    this.starting = null
  }

  get info() {
    return {
      serial: this.serial,
      state: this.state,
      deviceName: this.deviceName,
      codec: this.codec,
      width: this.width,
      height: this.height,
      tunnel: this.forward ? 'forward' : 'reverse',
      paused: this.paused,
      lastError: this.lastError,
      hint: this.hint,
    }
  }

  emitState(patch = {}) {
    this.emit('state', { ...this.info, ...patch })
  }

  // ------------------------------------------------------------ 启停

  start() {
    if (this.starting) return this.starting
    if (this.state === 'running') return Promise.resolve()
    this.starting = this.doStart().finally(() => { this.starting = null })
    return this.starting
  }

  async doStart() {
    this.state = 'starting'
    this.lastError = ''
    this.hint = ''
    this.emitState()
    this.log(`[云手机] 开始连接 ${this.serial}`)

    try {
      await this.adb.startServer()
      const devices = await this.adb.listDevices()
      const device = devices.find((item) => item.serial === this.serial)
      if (!device) {
        throw new CloudError(`找不到设备 ${this.serial}`,
          '请确认 USB 已插好；无线连接请先在手机上开启「无线调试」并填对 IP:端口')
      }
      if (device.state !== 'device') {
        throw new CloudError(`设备状态是 ${device.state}`,
          '若显示 unauthorized，请在手机上点「允许 USB 调试」后重试')
      }

      this.log('[云手机] 推送 scrcpy-server 到手机')
      await this.adb.removeFile(this.serial, SERVER_DEVICE_PATH)
      await this.adb.pushFile(this.serial, path.join(this.binaryDir, 'scrcpy-server'), SERVER_DEVICE_PATH)

      await this.openTunnel()
      await this.connectSockets()
      await this.waitForVideo()

      this.state = 'running'
      this.emitState()
      this.log(`[云手机] 已连接：${this.deviceName || this.serial} ${this.width}x${this.height} ${this.codec}`)
    } catch (error) {
      this.lastError = error.message
      this.hint = error.hint || ''
      await this.teardown()
      this.state = 'error'
      this.emitState()
      this.log(`[云手机] 连接失败：${error.message}${this.hint ? `（${this.hint}）` : ''}`)
      throw error
    }
  }

  async stop() {
    await this.teardown()
    this.state = 'idle'
    this.emitState()
    this.log('[云手机] 已断开')
  }

  async teardown() {
    this.state = 'stopping'

    this.discardSockets()
    this.metaBuffer = Buffer.alloc(0)
    this.metaDone = false

    if (this.videoServer) {
      try { this.videoServer.close() } catch (error) { /* ignore */ }
      this.videoServer = null
    }

    this.killServer()
    // 让 server 进程真正退出，否则残留的进程会去抢 abstract socket
    await delay(150)

    if (this.serial) {
      // 只清自己用过的端口段。别用 forward --remove-all：
      // 同一台电脑上 scrcpy 官方客户端的转发也存在这张共享表里，一起删会把别人的投屏断开。
      for (const port of PORT_CANDIDATES) {
        try { await this.adb.forwardRemove(this.serial, port) } catch (error) { /* ignore */ }
        try { await this.adb.forwardRemove(this.serial, port + 1) } catch (error) { /* ignore */ }
      }
      try { await this.adb.reverseRemoveAll(this.serial) } catch (error) { /* ignore */ }
      try { await this.adb.removeFile(this.serial, SERVER_DEVICE_PATH) } catch (error) { /* ignore */ }
    }

    this.forward = false
    this.forwardPorts = []
    this.videoPort = 0
    this.deviceName = ''
    this.codec = ''
    this.width = 0
    this.height = 0
    this.firstPacketAt = 0
    this.paused = false
  }

  discardSockets() {
    for (const socket of [this.videoSocket, this.controlSocket]) {
      if (!socket) continue
      try {
        socket.removeAllListeners()
        socket.on('error', () => {})
        socket.destroy()
      } catch (error) { /* ignore */ }
    }
    this.videoSocket = null
    this.controlSocket = null
    this.videoParser = null
    this.controlParser = null
  }

  // ------------------------------------------------------------ 隧道

  async openTunnel() {
    // 设备上还留着上一次（或其它程序）启动的 scrcpy-server 时，它会占着 @scrcpy
    // 抽象 socket，导致新起的 server 连不上或被抢先 accept，表现就是
    // 「日志显示已连接、但画面不出来」或者刚连上就断。先清掉再起新的。
    await this.adb.run(['shell', 'pkill', '-f', 'com.genymobile.scrcpy.Server'],
      { serial: this.serial, allowFail: true, timeout: 5000 })
    await delay(300)

    // 只清自己用过的端口段，不要用 forward --remove-all：
    // 那会把同一台电脑上 scrcpy 官方客户端的转发一起删掉，把别人的投屏断开。
    for (const port of PORT_CANDIDATES) {
      try { await this.adb.forwardRemove(this.serial, port) } catch (error) { /* ignore */ }
      try { await this.adb.forwardRemove(this.serial, port + 1) } catch (error) { /* ignore */ }
    }
    try { await this.adb.reverseRemoveAll(this.serial) } catch (error) { /* ignore */ }

    const reversePort = await this.tryReverse()
    if (reversePort) {
      this.forward = false
      this.videoPort = reversePort
      this.log(`[云手机] 隧道：adb reverse tcp:${reversePort} → ${SERVER_SOCKET}（电脑监听）`)
      return
    }

    // 关键：reverse 探测时起过的 server 可能还没退出，
    // 它晚一步去连 abstract socket 会把下面注册的 forward 端口抢走。
    this.killServer()
    await delay(400)

    this.log('[云手机] adb reverse 不可用（手机端连不回来），改用 adb forward（电脑主动连）')
    await this.setupForward()
  }

  async tryReverse() {
    for (const port of PORT_CANDIDATES) {
      let server
      try {
        server = await listen(port)
      } catch (error) {
        continue
      }

      await this.adb.reverse(this.serial, SERVER_SOCKET, port)
      const list = await this.adb.run(['reverse', '--list'], { serial: this.serial, allowFail: true })
      if (!list.stdout.includes(`tcp:${port}`)) {
        try { server.close() } catch (error) { /* ignore */ }
        await this.adb.reverseRemove(this.serial, SERVER_SOCKET)
        continue
      }

      // 真起一次 server，手机端能连回来才算 reverse 可用
      this.spawnServer()
      try {
        const video = await acceptOne(server, REVERSE_PROBE_TIMEOUT, 'video')
        const control = await acceptOne(server, REVERSE_PROBE_TIMEOUT, 'control')
        this.videoServer = server
        this.videoSocket = video.socket
        this.controlSocket = control.socket
        this.attachVideo()
        this.pushVideo(video.firstChunk)
        this.attachControl()
        this.pushControl(control.firstChunk)
        return port
      } catch (error) {
        this.discardSockets()
        this.killServer()
        try { server.close() } catch (closeError) { /* ignore */ }
        await this.adb.reverseRemove(this.serial, SERVER_SOCKET)
        return null
      }
    }
    return null
  }

  async setupForward() {
    // adb forward 表是和 adb server 共享的：电脑上同时开着 scrcpy 官方客户端时，
    // 它也会在这台设备上注册 tcp:27183/27184。直接覆盖会互相抢 socket，
    // 表现就是「日志显示已连接、但画面不出来」。
    // forward --list 靠不住（我们刚清过自己的端口），这里直接试听一次：
    // 端口能被我们 listen 成功，才说明没有别的进程占着。
    for (const port of PORT_CANDIDATES) {
      if (!(await portFree(port)) || !(await portFree(port + 1))) {
        this.log(`[云手机] 端口 ${port}/${port + 1} 被其它程序占用（可能是 scrcpy 客户端），跳过`)
        continue
      }
      const video = await this.adb.run(
        ['forward', `tcp:${port}`, `localabstract:${SERVER_SOCKET}`],
        { serial: this.serial, allowFail: true },
      )
      if (video.code !== 0) continue
      const control = await this.adb.run(
        ['forward', `tcp:${port + 1}`, `localabstract:${SERVER_SOCKET}`],
        { serial: this.serial, allowFail: true },
      )
      if (control.code !== 0) {
        await this.adb.forwardRemove(this.serial, port)
        continue
      }
      this.forward = true
      this.forwardPorts = [port, port + 1]
      this.videoPort = port
      this.log(`[云手机] 隧道：adb forward tcp:${port}(视频) / tcp:${port + 1}(控制) → ${SERVER_SOCKET}`)
      return
    }
    throw new CloudError('无法建立 adb 隧道（reverse 与 forward 都失败）',
      '确认 adb 能正常执行 shell 命令；若同时开着 scrcpy 客户端，请先关掉它再重试')
  }

  // ------------------------------------------------------------ socket

  serverArgv() {
    const argv = [
      `CLASSPATH=${SERVER_DEVICE_PATH}`,
      'app_process',
      '/',
      'com.genymobile.scrcpy.Server',
      SERVER_VERSION,
      'audio=false',
      'video=true',
      'control=true',
      // cleanup=false：不起「恢复手机设置」的清理子进程，也不会删自己
      // （本项目每次启动都重新 push，避免 jar 被 unlink 后下次直接 Aborted）
      'cleanup=false',
      'log_level=warn',
    ]
    if (this.forward) argv.push('tunnel_forward=true')
    return argv
  }

  spawnServer() {
    if (this.serverProcess) return
    const argv = this.serverArgv()
    this.serverProcess = this.adb.spawnServer(this.serial, argv, (line) => {
      if (/ERROR|error|Aborted|Exception/i.test(line)) this.log(`[手机端] ${line}`)
    })
    this.serverProcess.on('exit', (code) => {
      this.log(`[手机端] server 退出（code ${code}）`)
      this.serverProcess = null
    })
  }

  killServer() {
    if (!this.serverProcess) return
    try { this.serverProcess.kill() } catch (error) { /* ignore */ }
    this.serverProcess = null
  }

  /**
   * forward 接线：手机端按 video → control 顺序 accept，
   * 电脑端串行连两个转发端口，并各自读掉开头 1 个 dummy 字节。
   */
  async connectSockets() {
    if (!this.forward) return

    // 关键：必须等手机端把 LocalServerSocket 挂到 @scrcpy 之后再注册 forward，
    // 否则 adbd 的转发目标会失效（连上后 0 字节直接断开）。
    // 这里先起 server，再轮询抽象 socket 是否出现，最后重建一次 forward。
    this.spawnServer()
    await this.waitForDeviceSocket()

    await this.adb.forwardRemove(this.serial, this.forwardPorts[0])
    await this.adb.forwardRemove(this.serial, this.forwardPorts[1])
    await this.adb.forward(this.serial, this.forwardPorts[0], `localabstract:${SERVER_SOCKET}`)
    await this.adb.forward(this.serial, this.forwardPorts[1], `localabstract:${SERVER_SOCKET}`)

    const video = await connectOne(this.forwardPorts[0], { expectData: true })
    this.videoSocket = video.socket
    this.attachVideo()
    this.pushVideo(stripDummy(video.firstChunk))

    // control 上不会再写 dummy 字节（sendDummyByte 已在 video accept 时用掉），
    // 连上就算就绪；手机端按 video → control 顺序 accept，顺序不能反。
    await delay(300)
    const control = await connectOne(this.forwardPorts[1], { expectData: false })
    this.controlSocket = control.socket
    this.attachControl()
  }

  /**
   * 轮询手机端 /proc/net/unix，等 @scrcpy 这个抽象 socket 被监听。
   * mount /proc/net/unix 里出现对应行即视为就绪。
   */
  async waitForDeviceSocket(timeout = 15000) {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      const result = await this.adb.run(
        ['shell', 'cat', '/proc/net/unix'],
        { serial: this.serial, allowFail: true, timeout: 5000 },
      )
      if (result.stdout.includes('@scrcpy') || result.stdout.includes(' scrcpy')) return true
      await delay(150)
    }
    this.log('[云手机] 等待手机端监听 @scrcpy 超时，仍继续尝试连接')
    return false
  }

  pushVideo(buffer) {
    if (!buffer || !buffer.length || !this.videoParser) return
    try {
      this.videoParser.push(buffer)
    } catch (error) {
      this.fail(error)
    }
  }

  pushControl(buffer) {
    if (!buffer || !buffer.length) return
    this.handleControlData(buffer)
  }

  attachVideo() {
    this.videoParser = new VideoStreamParser({
      onDeviceName: (name) => {
        this.deviceName = name
        this.log(`[云手机] 设备名：${name || '(空)'}`)
        this.emitState()
      },
      onCodec: (id, name) => {
        this.codec = name
        if (id === 0) throw new CloudError('手机端禁用了视频流（codec id 0）')
        if (id === 1) throw new CloudError('手机端视频编码配置出错（codec id 1）',
          '尝试降低分辨率，或换一台手机')
        this.emitState()
      },
      onSession: ({ width, height }) => {
        // session 头：byte4-7 宽、byte8-11 高
        if (!width || !height) return
        this.width = width
        this.height = height
        this.emitState()
        this.emit('session', { width, height })
      },
      onPacket: (packet) => {
        if (!this.firstPacketAt) {
          this.firstPacketAt = Date.now()
          this.log('[云手机] 收到第一帧视频数据')
        }
        if (this.paused) return
        this.emit('packet', packet)
      },
    })

    this.videoSocket.on('data', (chunk) => this.pushVideo(chunk))
    this.videoSocket.on('close', () => this.onSocketClosed('video'))
    this.videoSocket.on('error', (error) => this.log(`[云手机] video 通道错误：${error.message}`))
  }

  attachControl() {
    this.controlParser = new DeviceMessageParser()
    this.controlSocket.on('data', (chunk) => this.pushControl(chunk))
    this.controlSocket.on('close', () => this.onSocketClosed('control'))
    this.controlSocket.on('error', (error) => this.log(`[云手机] control 通道错误：${error.message}`))
  }

  /** control 上是纯 DeviceMessage 序列（设备名在 video 流里） */
  /** control 上是纯 DeviceMessage 序列（设备名在 video 流里） */
  handleControlData(chunk) {
    if (!chunk || !chunk.length) return
    try {
      for (const message of this.controlParser.push(chunk)) {
        this.emit('device-message', message)
      }
    } catch (error) {
      this.log(`[云手机] control 通道解析失败：${error.message}`)
    }
  }

  onSocketClosed(kind) {
    if (this.state !== 'running') return
    this.log(`[云手机] ${kind} 通道已关闭，会话结束`)
    this.state = 'disconnected'
    this.emitState()
    this.emit('closed', kind)
  }

  fail(error) {
    this.lastError = error.message
    this.hint = error.hint || ''
    this.state = 'error'
    this.emitState()
    this.emit('failed', error)
  }

  waitForVideo() {
    return new Promise((resolve, reject) => {
      if (this.width && this.height) {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new CloudError('手机端没有回传画面',
          '确认手机已解锁、未被其它投屏软件占用。Android 12+ 可尝试关闭「隐私保护」'))
      }, 20000)
      const onSession = () => {
        cleanup()
        resolve()
      }
      const onFailed = (error) => {
        cleanup()
        reject(error)
      }
      const cleanup = () => {
        clearTimeout(timer)
        this.removeListener('session', onSession)
        this.removeListener('failed', onFailed)
      }
      this.once('session', onSession)
      this.once('failed', onFailed)
    })
  }

  // ------------------------------------------------------------ 控制下发

  send(buffer) {
    if (!buffer) return false
    if (!this.controlSocket || this.controlSocket.destroyed) return false
    try {
      this.controlSocket.write(buffer)
      return true
    } catch (error) {
      this.log(`[云手机] 发送控制消息失败：${error.message}`)
      return false
    }
  }

  setPaused(value) {
    this.paused = Boolean(value)
    this.emitState()
    return this.paused
  }
}

module.exports = { CloudSession, CloudError, SERVER_VERSION, SERVER_DEVICE_PATH, SERVER_SOCKET }