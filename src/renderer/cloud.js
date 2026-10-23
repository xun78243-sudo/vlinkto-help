/**
 * 云手机（投屏 + 操控）渲染端。
 *
 * 视频：主进程把 scrcpy-server 的 H.264 码流按 scrcpy 12 字节头切好帧发过来，
 *       这里用 WebCodecs VideoDecoder 解码，再把 VideoFrame 画到 canvas。
 * 控制：坐标按 canvas 显示尺寸换算回手机原始像素（scrcpy 要求 int32 像素 + 参考尺寸），
 *       再经 preload 交给主进程写进 control socket。
 *
 * 整体包在 IIFE 里：本文件和 renderer.js 都是普通 <script>，顶层同名声明
 * （api / $ / state / cleanError 等）会互相覆盖，直接报 SyntaxError 让整个文件失效。
 */

(function () {
  'use strict'

  const api = window.assistant
  const $ = (id) => document.getElementById(id)

  const KEYCODES = {
    back: 4,
    home: 3,
    appswitch: 187,
    power: 26,
    volumeup: 24,
    volumedown: 25,
    enter: 66,
  }

  const ACTION = {
    DOWN: 0,
    UP: 1,
    MOVE: 2,
    POINTER_DOWN: 5,
    POINTER_UP: 6,
  }

  const POINTER_FINGER = -2
  const POINTER_MOUSE = -1
  const POINTER_VIRTUAL = -3

  const state = {
    info: null,
    decoder: null,
    decoderConfig: null,
    ready: false,
    canvasCtx: null,
    width: 0,
    height: 0,
    frameCount: 0,
    fpsWindow: [],
    currentFps: 0,
    sending: false,
    devices: [],
    pointer: { down: false, x: 0, y: 0, lastX: 0, lastY: 0, startedAt: 0, moved: false },
    virtualFinger: null,
    paused: false,
    basePts: null,
  }

  // ---------------------------------------------------------------- 工具

  function overlay(title, text) {
    const box = $('cloud-overlay')
    if (!title) {
      box.hidden = true
      return
    }
    box.hidden = false
    $('cloud-overlay-title').textContent = title
    $('cloud-overlay-text').textContent = text || ''
  }

  function setBadge(text, tone) {
    const badge = $('cloud-badge')
    badge.textContent = text
    badge.className = 'cloud-badge' + (tone ? ` is-${tone}` : '')
  }

  function showError(message, hint) {
    const box = $('cloud-error')
    if (!message) {
      box.hidden = true
      box.textContent = ''
      return
    }
    box.hidden = false
    box.textContent = ''
    const line = document.createElement('div')
    line.textContent = message
    box.appendChild(line)
    if (hint) {
      const note = document.createElement('span')
      note.className = 'hint'
      note.textContent = hint
      box.appendChild(note)
    }
  }

  function setControlsEnabled(enabled) {
    for (const node of document.querySelectorAll('.cloud-key')) node.disabled = !enabled
    $('btn-cloud-send-text').disabled = !enabled
    $('btn-cloud-send-enter').disabled = !enabled
    $('btn-cloud-send-image').disabled = !enabled
    $('btn-cloud-screenshot').disabled = !enabled
    $('cloud-screen').classList.toggle('is-live', enabled)
  }

  /** 图片发送结果提示：成功绿底，部分失败黄底 */
  function setTransfer(message, tone) {
    const node = $('cloud-transfer')
    node.hidden = !message
    node.textContent = message || ''
    node.className = 'hint cloud-transfer' + (tone ? ` is-${tone}` : '')
  }

  // ---------------------------------------------------------------- 设备列表

  async function refreshDevices({ silent = false } = {}) {
    const button = $('btn-cloud-scan')
    button.disabled = true
    button.textContent = '扫描中…'
    try {
      const devices = await api.cloudDevices()
      state.devices = devices || []
      const select = $('cloud-device-select')
      const previous = select.value
      select.textContent = ''
      if (!state.devices.length) {
        const option = document.createElement('option')
        option.value = ''
        option.textContent = '未发现设备（请检查 USB 调试）'
        select.appendChild(option)
      } else {
        for (const device of state.devices) {
          const option = document.createElement('option')
          option.value = device.serial
          const label = `${device.model || device.device || device.serial}`
          const stateText = device.state === 'device' ? '' : ` · ${device.state}`
          option.textContent = `${label}（${device.serial}）${stateText}`
          select.appendChild(option)
        }
        if (previous && state.devices.some((item) => item.serial === previous)) {
          select.value = previous
        }
      }
      if (!silent) showError('')
    } catch (error) {
      if (!silent) showError(`读取设备列表失败：${cleanError(error)}`, '确认内置 adb 未被杀毒软件拦截')
    } finally {
      button.disabled = false
      button.textContent = '刷新设备'
    }
  }

  function selectedSerial() {
    const typed = $('cloud-address').value.trim()
    if (typed) return typed
    return $('cloud-device-select').value || ''
  }

  // ---------------------------------------------------------------- 视频解码

  function ensureDecoder(width, height, buildConfig) {
    const target = {
      codec: buildConfig.codec || 'avc1.42E01E',
      codedWidth: width,
      codedHeight: height,
      optimizeForLatency: true,
    }
    // description（avcC）必须一起带进 configure，否则解码器会按 Annex-B 解析，
    // 而我们按 AVCC 送帧，结果就是 "Decoder error."。
    if (buildConfig.description) target.description = buildConfig.description

    const same = state.decoderConfig
      && state.decoderConfig.codec === target.codec
      && state.decoderConfig.codedWidth === width
      && state.decoderConfig.codedHeight === height
      && Boolean(state.decoderConfig.description) === Boolean(target.description)

    if (state.decoder && same) return

    destroyDecoder()

    if (typeof window.VideoDecoder !== 'function') {
      showError('当前 Electron 不支持 WebCodecs，无法解码 H.264 画面',
        '请升级到最新版微联叮小助手')
      return
    }

    const decoder = new VideoDecoder({
      output: (frame) => {
        drawFrame(frame)
        frame.close()
      },
      error: (error) => {
        showError(`视频解码失败：${error.message}`,
          '手机编码参数可能与内置解码器不兼容，可尝试重新连接')
      },
    })

    try {
      decoder.configure(target)
    } catch (error) {
      showError(`视频解码器初始化失败：${error.message}`)
      return
    }

    state.decoder = decoder
    state.decoderConfig = target
    state.ready = true
  }

  function destroyDecoder() {
    if (!state.decoder) return
    try {
      if (state.decoder.state !== 'closed') state.decoder.close()
    } catch (error) { /* ignore */ }
    state.decoder = null
    state.decoderConfig = null
    state.ready = false
  }

  function drawFrame(frame) {
    const canvas = $('cloud-canvas')
    const ctx = state.canvasCtx
    if (!ctx) return
    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas.width = frame.displayWidth
      canvas.height = frame.displayHeight
      state.width = frame.displayWidth
      state.height = frame.displayHeight
      fitCanvas()
    }
    ctx.drawImage(frame, 0, 0, canvas.width, canvas.height)

    state.frameCount += 1
    const now = performance.now()
    state.fpsWindow.push(now)
    while (state.fpsWindow.length && now - state.fpsWindow[0] > 1000) state.fpsWindow.shift()
    state.currentFps = state.fpsWindow.length
    $('cloud-fps').textContent = `${state.info && state.info.codec ? state.info.codec.toUpperCase() : 'H.264'} · ${state.currentFps} fps`
  }

  /** 按容器大小等比缩放画布（保持比例，留黑边） */
  function fitCanvas() {
    const canvas = $('cloud-canvas')
    const stage = $('cloud-screen')
    if (!canvas.width || !canvas.height) return
    const boxW = stage.clientWidth
    const boxH = stage.clientHeight
    const scale = Math.min(boxW / canvas.width, boxH / canvas.height)
    canvas.style.width = `${Math.floor(canvas.width * scale)}px`
    canvas.style.height = `${Math.floor(canvas.height * scale)}px`
  }

  function feedPacket(packet) {
    if (state.paused) return
    const { data, config, key } = packet
    if (!data || !data.byteLength) return

    if (config) {
      // codec 配置包（SPS/PPS）：解析出 avcC 描述，供 VideoDecoder 使用
      const description = extractAvcC(toBytes(data))
      if (description) {
        const width = (state.info && state.info.width) || 720
        const height = (state.info && state.info.height) || 1280
        ensureDecoder(width, height, { codec: avcCodecString(description), description })
      }
      return
    }

    if (!state.ready || !state.decoder) {
      // 没有先收到配置包时，用默认 baseline profile 兜底
      const width = (state.info && state.info.width) || 720
      const height = (state.info && state.info.height) || 1280
      ensureDecoder(width, height, { codec: 'avc1.42E01E' })
    }
    if (!state.decoder || state.decoder.state !== 'configured') return

    try {
      // 配了 avcC description 时，WebCodecs 要求码流是 AVCC 格式
      // （每个 NAL 前缀 4 字节长度），而 scrcpy 给的是 Annex-B（00 00 00 01）。
      // 不转换就会得到 "Decoder error."。
      const chunkData = state.decoderConfig && state.decoderConfig.description
        ? annexBToAvcc(data)
        : data
      // scrcpy 的 pts 是手机开机以来的微秒数（可达 2^43），
      // 转成相对第一帧的时间戳，避免长时间运行后溢出解码器的时间轴。
      if (state.basePts === null || state.basePts === undefined) state.basePts = packet.pts || 0
      const timestamp = Math.max(0, (packet.pts || 0) - state.basePts)
      state.decoder.decode(new EncodedVideoChunk({
        type: key ? 'key' : 'delta',
        timestamp,
        data: chunkData,
      }))
    } catch (error) {
      // 解码队列异常时重建解码器，避免整场卡死
      if (String(error.message).includes('closed')) return
      showError(`送帧失败：${error.message}`)
    }
  }

  /** IPC 传过来的是 Uint8Array；渲染进程没有 Node 的 Buffer，统一按 Uint8Array 处理 */
  function toBytes(data) {
    if (data instanceof Uint8Array) return data
    if (data instanceof ArrayBuffer) return new Uint8Array(data)
    return new Uint8Array(data)
  }

  /**
   * 从 H.264 码流里抽 SPS/PPS 拼成 avcC（AVCDecoderConfigurationRecord）。
   * scrcpy 的 config 包内容就是一个 Annex-B 的 SPS+PPS。
   */
  function extractAvcC(input) {
    const buffer = toBytes(input)
    const units = splitAnnexB(buffer)
    const sps = units.find((unit) => (unit[0] & 0x1f) === 7)
    const pps = units.find((unit) => (unit[0] & 0x1f) === 8)
    if (!sps || !pps) return null

    const size = 11 + sps.length + pps.length
    const out = new Uint8Array(size)
    const view = new DataView(out.buffer)
    let offset = 0
    out[offset++] = 1
    out[offset++] = sps[1]
    out[offset++] = sps[2]
    out[offset++] = sps[3]
    out[offset++] = 0xff
    out[offset++] = 0xe1
    view.setUint16(offset, sps.length); offset += 2
    out.set(sps, offset); offset += sps.length
    out[offset++] = 1
    view.setUint16(offset, pps.length); offset += 2
    out.set(pps, offset)
    return out
  }

  function splitAnnexB(input) {
    const buffer = toBytes(input)
    const units = []
    const starts = []
    let i = 0
    // 先找出所有起始码位置（00 00 01 或 00 00 00 01）
    while (i + 2 < buffer.length) {
      if (buffer[i] === 0 && buffer[i + 1] === 0 && buffer[i + 2] === 1) {
        starts.push({ start: i + 3, prefix: i })
        i += 3
      } else {
        i++
      }
    }
    for (let k = 0; k < starts.length; k++) {
      const begin = starts[k].start
      let end = k + 1 < starts.length ? starts[k + 1].prefix : buffer.length
      // 下一个起始码可能是 00 00 00 01，它的第一个 00 会被算进上一个 NAL 的尾部；
      // 按 Annex-B 约定去掉这些 trailing zero，否则解码器会认为 NAL 里有非法尾字节。
      while (end > begin && buffer[end - 1] === 0) end--
      if (end > begin) units.push(buffer.subarray(begin, end))
    }
    return units
  }

  function avcCodecString(avcC) {
    const profile = avcC[1]
    const compat = avcC[2]
    const level = avcC[3]
    return `avc1.${profile.toString(16).padStart(2, '0')}${compat.toString(16).padStart(2, '0')}${level.toString(16).padStart(2, '0')}`
  }

  /**
   * Annex-B → AVCC：把每个 NAL 前的起始码（00 00 01 / 00 00 00 01）
   * 换成 4 字节大端长度。scrcpy 输出 Annex-B，而配了 avcC description
   * 的 VideoDecoder 只接受 AVCC，不转换会直接报 Decoder error。
   */
  function annexBToAvcc(input) {
    const buffer = toBytes(input)
    const units = splitAnnexB(buffer)
    if (!units.length) return buffer
    let total = 0
    for (const unit of units) total += 4 + unit.length
    const out = new Uint8Array(total)
    const view = new DataView(out.buffer)
    let offset = 0
    for (const unit of units) {
      view.setUint32(offset, unit.length)
      offset += 4
      out.set(unit, offset)
      offset += unit.length
    }
    return out
  }

  // ---------------------------------------------------------------- 坐标 / 输入

  /** canvas 内坐标 → 手机像素坐标（scrcpy 要求像素 + 参考尺寸） */
  function toDevicePoint(event) {
    const canvas = $('cloud-canvas')
    const rect = canvas.getBoundingClientRect()
    const width = state.width || canvas.width
    const height = state.height || canvas.height
    if (!width || !height || !rect.width || !rect.height) return null
    const scaleX = width / rect.width
    const scaleY = height / rect.height
    const x = Math.round((event.clientX - rect.left) * scaleX)
    const y = Math.round((event.clientY - rect.top) * scaleY)
    if (x < 0 || y < 0 || x > width || y > height) return null
    return { x, y, width, height }
  }

  async function sendTouch(action, point, extra = {}) {
    if (!state.ready || !point) return
    await api.cloudTouch({
      action,
      pointerId: extra.pointerId !== undefined ? extra.pointerId : POINTER_FINGER,
      x: point.x,
      y: point.y,
      width: point.width,
      height: point.height,
      pressure: extra.pressure !== undefined ? extra.pressure : 1,
      actionButton: extra.actionButton || 0,
      buttons: extra.buttons || 0,
    })
  }

  async function handlePointerDown(event) {
    if (!state.ready) return
    const point = toDevicePoint(event)
    if (!point) return
    $('cloud-canvas').setPointerCapture(event.pointerId)
    state.pointer.down = true
    state.pointer.x = point.x
    state.pointer.y = point.y
    state.pointer.lastX = point.x
    state.pointer.lastY = point.y
    state.pointer.moved = false
    state.pointer.startedAt = Date.now()

    if (event.altKey) {
      // Alt+拖动：鼠标作为「虚拟手指」，配合下面第二根手指做双指缩放
      state.virtualFinger = { x: point.x, y: point.y, width: point.width, height: point.height }
      await sendTouch(ACTION.DOWN, point, { pointerId: POINTER_VIRTUAL })
      return
    }

    await sendTouch(ACTION.DOWN, point, {
      pointerId: POINTER_MOUSE,
      actionButton: 1,
      buttons: 1,
    })
  }

  async function handlePointerMove(event) {
    if (!state.pointer.down || !state.ready) return
    const point = toDevicePoint(event)
    if (!point) return
    if (Math.abs(point.x - state.pointer.x) > 2 || Math.abs(point.y - state.pointer.y) > 2) {
      state.pointer.moved = true
    }
    state.pointer.lastX = point.x
    state.pointer.lastY = point.y

    const pointerId = state.virtualFinger ? POINTER_VIRTUAL : POINTER_MOUSE
    await sendTouch(ACTION.MOVE, point, {
      pointerId,
      actionButton: 1,
      buttons: 1,
    })
  }

  async function handlePointerUp(event) {
    if (!state.pointer.down || !state.ready) return
    state.pointer.down = false
    const point = toDevicePoint(event)
    if (!point) {
      state.virtualFinger = null
      return
    }

    const pointerId = state.virtualFinger ? POINTER_VIRTUAL : POINTER_MOUSE
    await sendTouch(ACTION.UP, point, {
      pointerId,
      pressure: 0,
      actionButton: 1,
      buttons: 0,
    })
    state.virtualFinger = null

    // 右键 = 返回
    if (event.button === 2 && !state.pointer.moved) {
      await pressKey(KEYCODES.back)
    }
  }

  async function handleWheel(event) {
    if (!state.ready) return
    const point = toDevicePoint(event)
    if (!point) return
    event.preventDefault()
    const vScroll = event.deltaY > 0 ? -1 : 1
    await api.cloudScroll({ ...point, vScroll })
  }

  async function pressKey(keycode) {
    if (!state.ready) return
    await api.cloudKey({ action: 0, keycode, repeat: 0, metaState: 0 })
    await api.cloudKey({ action: 1, keycode, repeat: 0, metaState: 0 })
  }

  async function sendText() {
    const box = $('cloud-text')
    const text = box.value
    if (!text || !state.ready) return
    await api.cloudText({ text })
    box.value = ''
  }

  // ---------------------------------------------------------------- 状态渲染

  function renderInfo(info) {
    if (!info) return
    state.info = info

    const map = {
      idle: ['未连接', ''],
      starting: ['连接中…', 'busy'],
      running: ['已连接', 'ok'],
      stopping: ['断开中…', 'busy'],
      disconnected: ['已断开', 'error'],
      error: ['连接失败', 'error'],
    }
    const [label, tone] = map[info.state] || ['未连接', '']
    setBadge(info.paused ? '已暂停' : label, info.paused ? 'busy' : tone)

    $('cloud-tunnel').textContent = info.tunnel === 'forward' ? 'adb forward' : (info.tunnel === 'reverse' ? 'adb reverse' : '—')
    $('cloud-size').textContent = info.width && info.height ? `${info.width}×${info.height}` : '—'
    if (!info.codec) $('cloud-fps').textContent = '—'

    const live = info.state === 'running'
    setControlsEnabled(live)
    if (!live) setTransfer('')
    $('btn-cloud-connect').textContent = live || info.state === 'starting' ? '断开' : '连接'
    $('btn-cloud-pause').textContent = info.paused ? '继续画面' : '暂停画面'

    if (info.state === 'starting') {
      overlay('正在连接手机…', '推送 scrcpy-server → 建立隧道 → 接入视频流')
      showError('')
    } else if (info.state === 'running') {
      overlay(info.paused ? '画面已暂停' : '', info.paused ? '点「继续画面」恢复接收新帧' : '')
    } else if (info.state === 'error') {
      overlay('连接失败', info.lastError || '请重试')
      showError(info.lastError, info.hint)
    } else if (info.state === 'disconnected') {
      overlay('连接已断开', '手机可能锁屏、USB 拔出或被其它投屏占用')
    } else {
      overlay('手机未连接', '点右上角「连接」开始投屏')
    }
  }

  // ---------------------------------------------------------------- 事件绑定

  function bind() {
    $('tabs').addEventListener('click', (event) => {
      const item = event.target.closest('.menu-item')
      if (!item || item.dataset.pane !== 'cloud') return
      setTimeout(fitCanvas, 30)
    })

    $('btn-cloud-scan').addEventListener('click', () => refreshDevices())

    $('btn-cloud-connect').addEventListener('click', async () => {
      const info = state.info || {}
      if (info.state === 'running' || info.state === 'starting') {
        const next = await api.cloudStop()
        renderInfo(next.cloud || next)
        destroyDecoder()
        return
      }
      const serial = selectedSerial()
      if (!serial) {
        showError('还没有选择设备', '插上 USB 并允许调试，或填写「局域网地址」后点连接')
        return
      }
      showError('')
      destroyDecoder()
      state.frameCount = 0
      const next = await api.cloudStart(serial)
      renderInfo(next.cloud || next)
    })

    $('btn-cloud-wireless').addEventListener('click', async () => {
      const serial = $('cloud-device-select').value
      if (!serial) {
        showError('请先选择一个 USB 连接中的设备')
        return
      }
      $('btn-cloud-wireless').disabled = true
      try {
        const address = await api.cloudEnableWireless(serial)
        if (address) {
          $('cloud-address').value = address
          await refreshDevices({ silent: true })
        } else {
          showError('没能取到手机局域网 IP', '请确认手机与电脑在同一网段且已连 Wi-Fi')
        }
      } catch (error) {
        showError(`转无线失败：${cleanError(error)}`)
      } finally {
        $('btn-cloud-wireless').disabled = false
      }
    })

    const canvas = $('cloud-canvas')
    canvas.addEventListener('pointerdown', handlePointerDown)
    canvas.addEventListener('pointermove', handlePointerMove)
    canvas.addEventListener('pointerup', handlePointerUp)
    canvas.addEventListener('pointercancel', handlePointerUp)
    canvas.addEventListener('contextmenu', (event) => event.preventDefault())
    canvas.addEventListener('wheel', handleWheel, { passive: false })

    for (const node of document.querySelectorAll('.cloud-key')) {
      node.addEventListener('click', async () => {
        const which = node.dataset.key
        if (which === 'rotate') {
          await api.cloudRotate()
          return
        }
        if (which === 'notification') {
          await api.cloudNotification()
          return
        }
        if (which === 'power') {
          await api.cloudDisplayPower()
          return
        }
        await pressKey(KEYCODES[which])
      })
    }

    $('btn-cloud-send-text').addEventListener('click', sendText)
    $('btn-cloud-send-enter').addEventListener('click', () => pressKey(KEYCODES.enter))
    $('cloud-text').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        sendText()
      }
    })

    $('btn-cloud-pause').addEventListener('click', async () => {
      const next = await api.cloudPause(!(state.info && state.info.paused))
      renderInfo(next.cloud || next)
    })

    $('btn-cloud-screenshot').addEventListener('click', async () => {
      const result = await api.cloudScreenshot()
      if (result && result.ok) {
        $('cloud-tip').textContent = `截图已保存：${result.file}`
      } else if (result && result.error) {
        showError(`截图失败：${result.error}`)
      }
    })

    $('btn-cloud-send-image').addEventListener('click', async () => {
      const button = $('btn-cloud-send-image')
      const label = button.textContent
      button.disabled = true
      button.textContent = '发送中…'
      showError('')
      try {
        const result = await api.cloudSendImages()
        if (!result || result.canceled) return
        if (!result.ok) {
          showError(`发送图片失败：${result.error || '未知错误'}`)
          if (result.sent) {
            setTransfer(`已发送 ${result.sent} 张图片，另有 ${result.failed} 张失败`, 'warn')
          }
          return
        }

        const where = String(result.dir || '').replace(/^\/sdcard\//, '')
        if (result.failed) {
          setTransfer(`已发送 ${result.sent} 张图片到「${where}」，${result.failed} 张失败`, 'warn')
        } else {
          setTransfer(`已发送 ${result.sent} 张图片到「${where}」，可在手机相册中查看`)
        }
      } catch (error) {
        showError(`发送图片失败：${cleanError(error)}`)
      } finally {
        button.textContent = label
        button.disabled = !(state.info && state.info.state === 'running')
      }
    })

    window.addEventListener('resize', fitCanvas)

    api.onCloudFrames(({ packets, session }) => {
      if (session) {
        ensureDecoder(session.width, session.height, { codec: 'avc1.42E01E' })
      }
      if (!packets || !packets.length) return
      for (const packet of packets) feedPacket(packet)
    })

    api.onCloudState((info) => {
      renderInfo(info)
      if (info.state === 'running' && state.info && !state.info.deviceName) {
        $('cloud-tip').textContent = '在画面上按住拖动 = 滑动；滚轮 = 上下滑动；右键 = 返回'
      }
    })
  }

  function cleanError(error) {
    const text = error && error.message ? error.message : String(error)
    return text.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '')
  }

  async function init() {
    state.canvasCtx = $('cloud-canvas').getContext('2d', { alpha: false, desynchronized: true })
    bind()
    renderInfo({ state: 'idle' })
    const current = await api.cloudState()
    if (current) renderInfo(current)
    await refreshDevices({ silent: true })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
