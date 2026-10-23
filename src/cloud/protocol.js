'use strict'
/**
 * scrcpy 客户端协议（PC 端）
 *
 * 协议编号与字段布局全部来自 scrcpy 源码，逐条对应：
 *   - 12 字节帧头 / session 包      app/src/demuxer.c:12-17, 67-133
 *   - 4 字节 codec id               server/.../device/Streamer.java:48-55
 *   - 64 字节设备名                 server/.../device/DesktopConnection.java:18, 155-165
 *   - 控制消息 0..22 与序列化       app/src/control_msg.c:103-211
 *   - 设备 → PC 消息                 server/.../control/DeviceMessage.java:5-7
 */

// ---------------------------------------------------------------- 视频流

const PACKET_HEADER_SIZE = 12
const PACKET_FLAG_SESSION = 1n << 63n
const PACKET_FLAG_CONFIG = 1n << 62n
const PACKET_FLAG_KEY_FRAME = 1n << 61n
const PACKET_PTS_MASK = (1n << 61n) - 1n

const DEVICE_NAME_FIELD_LENGTH = 64

// codec id 为大端 32 位，取值是 4 个 ASCII 字节（demuxer.c:21-29 / VideoCodec.java:9-14）
const CODEC_IDS = {
  0x68323634: 'h264',
  0x68323635: 'h265',
  0x0066763a: 'av1',
  0x00767038: 'vp8',
  0x00767039: 'vp9',
  0x00000000: 'disabled',
  0x00000001: 'error',
}

function codecName(id) {
  return CODEC_IDS[id >>> 0] || `unknown(0x${(id >>> 0).toString(16)})`
}

// ---------------------------------------------------------------- 控制消息

const CONTROL = {
  INJECT_KEYCODE: 0,
  INJECT_TEXT: 1,
  INJECT_TOUCH_EVENT: 2,
  INJECT_SCROLL_EVENT: 3,
  BACK_OR_SCREEN_ON: 4,
  EXPAND_NOTIFICATION_PANEL: 5,
  EXPAND_SETTINGS_PANEL: 6,
  COLLAPSE_PANELS: 7,
  GET_CLIPBOARD: 8,
  SET_CLIPBOARD: 9,
  SET_DISPLAY_POWER: 10,
  ROTATE_DEVICE: 11,
  START_APP: 16,
  RESET_VIDEO: 17,
}

// control_msg.h:23-27 —— 负数 pointer id 是保留值
const POINTER_ID_MOUSE = 0xFFFFFFFFFFFFFFFFn
const POINTER_ID_VIRTUAL_FINGER = 0xFFFFFFFFFFFFFFFDn

// Android MotionEvent action（android/input.h）
const ACTION = {
  DOWN: 0,
  UP: 1,
  MOVE: 2,
  CANCEL: 3,
  POINTER_DOWN: 5,
  POINTER_UP: 6,
  HOVER_MOVE: 7,
  SCROLL: 8,
}
const ACTION_POINTER_INDEX_SHIFT = 8

const BUTTON_PRIMARY = 1

/** 负数按 64 位二进制补码转成可写入的无符号 BigInt */
function toU64(value) {
  const big = BigInt(value)
  return big < 0n ? big + (1n << 64n) : big
}

/** 0..1 的浮点压力 → 16 位无符号定点（util/binary.h:69-78 的 sc_float_to_u16fp） */
function u16FixedPoint(value) {
  const f = Math.max(0, Math.min(1, value))
  const u = Math.floor(f * 0x10000)
  return u >= 0xffff ? 0xffff : u
}

/** -1..1 的浮点 → 16 位有符号定点（sc_float_to_i16fp） */
function i16FixedPoint(value) {
  const f = Math.max(-1, Math.min(1, value))
  const i = Math.floor(f * 0x8000)
  if (i >= 0x7fff) return 0x7fff
  if (i <= -0x8000) return -0x8000
  return i
}

/**
 * 触摸事件：32 字节（control_msg.c:118-127）
 *   0 type | 1 action | 2..9 pointerId(be64) | 10..13 x | 14..17 y
 *   18..19 screenWidth | 20..21 screenHeight | 22..23 pressure
 *   24..27 actionButton | 28..31 buttons
 */
function touchEvent(message) {
  const buf = Buffer.alloc(32)
  const { action, pointerId = POINTER_ID_VIRTUAL_FINGER, x, y, width, height } = message
  const pressure = message.pressure === undefined ? 1 : message.pressure
  const actionButton = message.actionButton || 0
  const buttons = message.buttons || 0

  buf[0] = CONTROL.INJECT_TOUCH_EVENT
  buf[1] = action
  buf.writeBigUInt64BE(toU64(pointerId), 2)
  buf.writeInt32BE(Math.round(x), 10)
  buf.writeInt32BE(Math.round(y), 14)
  buf.writeUInt16BE(width, 18)
  buf.writeUInt16BE(height, 20)
  buf.writeUInt16BE(u16FixedPoint(pressure), 22)
  buf.writeUInt32BE(actionButton >>> 0, 24)
  buf.writeUInt32BE(buttons >>> 0, 28)
  return buf
}

/** 键码：14 字节（control_msg.c:107-112） */
function keyEvent(action, keycode, repeat = 0, metaState = 0) {
  const buf = Buffer.alloc(14)
  buf[0] = CONTROL.INJECT_KEYCODE
  buf[1] = action
  buf.writeInt32BE(keycode, 2)
  buf.writeInt32BE(repeat, 6)
  buf.writeInt32BE(metaState, 10)
  return buf
}

/** 文本：1 + 4 + utf8（单条上限 300 字节，control_msg.h:15-18） */
function textEvent(text) {
  const bytes = Buffer.from(String(text), 'utf8')
  const body = bytes.length > 300 ? bytes.slice(0, 300) : bytes
  const buf = Buffer.alloc(5 + body.length)
  buf[0] = CONTROL.INJECT_TEXT
  buf.writeUInt32BE(body.length, 1)
  body.copy(buf, 5)
  return buf
}

/** 滚轮：21 字节（control_msg.c:128-141） */
function scrollEvent({ x, y, width, height, hScroll = 0, vScroll = -1, buttons = 0 }) {
  const buf = Buffer.alloc(21)
  buf[0] = CONTROL.INJECT_SCROLL_EVENT
  buf.writeInt32BE(Math.round(x), 1)
  buf.writeInt32BE(Math.round(y), 5)
  buf.writeUInt16BE(width, 9)
  buf.writeUInt16BE(height, 11)
  buf.writeInt16BE(i16FixedPoint(hScroll / 16), 13)
  buf.writeInt16BE(i16FixedPoint(vScroll / 16), 15)
  buf.writeUInt32BE(buttons >>> 0, 17)
  return buf
}

/** 显示电源（control_msg.c:154-156） */
function displayPower(on) {
  return Buffer.from([CONTROL.SET_DISPLAY_POWER, on ? 1 : 0])
}

/** 返回键 / 亮屏（control_msg.c:142-144） */
function backOrScreenOn(action) {
  return Buffer.from([CONTROL.BACK_OR_SCREEN_ON, action])
}

/** 0 负载的控制类型（control_msg.c:197-206） */
function emptyControl(type) {
  return Buffer.from([type])
}

function rotateDevice() {
  return emptyControl(CONTROL.ROTATE_DEVICE)
}

function expandNotificationPanel() {
  return emptyControl(CONTROL.EXPAND_NOTIFICATION_PANEL)
}

function collapsePanels() {
  return emptyControl(CONTROL.COLLAPSE_PANELS)
}

/** 启动 App（control_msg.c:181-184） */
function startApp(packageName) {
  const bytes = Buffer.from(String(packageName), 'utf8')
  const body = bytes.length > 255 ? bytes.slice(0, 255) : bytes
  const buf = Buffer.alloc(2 + body.length)
  buf[0] = CONTROL.START_APP
  buf[1] = body.length
  body.copy(buf, 2)
  return buf
}

// ---------------------------------------------------------------- Android keycodes

const KEYCODE = {
  HOME: 3,
  BACK: 4,
  CALL: 5,
  ENDCALL: 6,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  POWER: 26,
  CAMERA: 27,
  MENU: 82,
  NOTIFICATION: 83,
  SEARCH: 84,
  ENTER: 66,
  DEL: 67,
  TAB: 61,
  SPACE: 62,
  ESCAPE: 111,
  MEDIA_PLAY_PAUSE: 85,
  APP_SWITCH: 187,
  MOVE_HOME: 122,
  MOVE_END: 123,
  PAGE_UP: 92,
  PAGE_DOWN: 93,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
}

// ---------------------------------------------------------------- 设备 → PC

/**
 * 增量解析设备发来的消息流（DeviceMessage.java:5-7 / device_msg.h）
 * 返回已完整解析的消息数组，未完成的字节留在内部缓冲里。
 */
class DeviceMessageParser {
  constructor() {
    this.buffer = Buffer.alloc(0)
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    const messages = []
    for (;;) {
      const parsed = this.parseOne()
      if (!parsed) break
      messages.push(parsed)
    }
    return messages
  }

  parseOne() {
    const buf = this.buffer
    if (buf.length < 1) return null
    const type = buf[0]
    if (type === 0) {
      // clipboard: type + 4 字节长度 + 文本（DeviceMessageWriter.java:26-31，没有 sequence）
      if (buf.length < 5) return null
      const length = buf.readUInt32BE(1)
      if (buf.length < 5 + length) return null
      const text = buf.slice(5, 5 + length).toString('utf8')
      this.buffer = buf.slice(5 + length)
      return { type: 'clipboard', text }
    }
    if (type === 1) {
      if (buf.length < 9) return null
      const sequence = buf.readBigUInt64BE(1)
      this.buffer = buf.slice(9)
      return { type: 'ack-clipboard', sequence: Number(sequence) }
    }
    if (type === 2) {
      // uhid output: type + 2 字节 id + 2 字节长度 + 数据
      if (buf.length < 5) return null
      const id = buf.readUInt16BE(1)
      const length = buf.readUInt16BE(3)
      if (buf.length < 5 + length) return null
      this.buffer = buf.slice(5 + length)
      return { type: 'uhid-output', id }
    }
    // 未知类型：无法安全跳帧，直接清空
    this.buffer = Buffer.alloc(0)
    return { type: 'unknown', code: type }
  }
}

/**
 * 增量解析视频 socket 上的字节流，交给回调处理帧。
 * 顺序：64B 设备名 → 4B codec id → 12B session/frame 包…
 *
 * 实测（scrcpy-server 5.0.1 / Android 9）：
 *   视频流是 [dummy 0x00][64B 设备名][4B codec="h264"][12B session][12B hdr + payload]…
 * 调用方负责去掉开头的 dummy 字节，设备名由本解析器消费。
 */
class VideoStreamParser {
  constructor({ onDeviceName, onCodec, onSession, onPacket } = {}) {
    this.buffer = Buffer.alloc(0)
    this.stage = 'deviceName'
    this.onDeviceName = onDeviceName || (() => {})
    this.onCodec = onCodec || (() => {})
    this.onSession = onSession || (() => {})
    this.onPacket = onPacket || (() => {})
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    this.drain()
  }

  drain() {
    for (;;) {
      if (this.stage === 'deviceName') {
        if (this.buffer.length < DEVICE_NAME_FIELD_LENGTH) return
        const name = this.buffer.slice(0, DEVICE_NAME_FIELD_LENGTH)
          .toString('utf8').replace(/\0+$/, '')
        this.buffer = this.buffer.slice(DEVICE_NAME_FIELD_LENGTH)
        this.stage = 'codec'
        this.onDeviceName(name)
        continue
      }

      if (this.stage === 'codec') {
        if (this.buffer.length < 4) return
        const id = this.buffer.readUInt32BE(0)
        this.buffer = this.buffer.slice(4)
        this.stage = 'packets'
        this.onCodec(id, codecName(id))
        continue
      }

      if (this.buffer.length < PACKET_HEADER_SIZE) return
      const header = this.buffer.slice(0, PACKET_HEADER_SIZE)
      const flags = header.readBigUInt64BE(0)
      const size = header.readUInt32BE(8)

      if ((flags & PACKET_FLAG_SESSION) !== 0n) {
        // 实测 scrcpy-server 5.0.1 的 session 头是单个 12 字节：
        //   [0..3] 0x80000000 | 可选 bit0(client resize)
        //   [4..7] width  [8..11] height
        // 也就是 width/height 直接写在「帧头」这 12 字节里，没有额外 payload。
        this.buffer = this.buffer.slice(PACKET_HEADER_SIZE)
        this.onSession({
          width: header.readUInt32BE(4),
          height: header.readUInt32BE(8),
          clientResize: (header[3] & 1) === 1,
        })
        continue
      }

      if (this.buffer.length < PACKET_HEADER_SIZE + size) return
      const payload = this.buffer.slice(PACKET_HEADER_SIZE, PACKET_HEADER_SIZE + size)
      this.buffer = this.buffer.slice(PACKET_HEADER_SIZE + size)

      const config = (flags & PACKET_FLAG_CONFIG) !== 0n
      const key = (flags & PACKET_FLAG_KEY_FRAME) !== 0n
      const pts = config ? -1 : Number(flags & PACKET_PTS_MASK)
      this.onPacket({ config, key, pts, data: payload })
    }
  }
}

module.exports = {
  PACKET_HEADER_SIZE,
  DEVICE_NAME_FIELD_LENGTH,
  CODEC_IDS,
  codecName,
  CONTROL,
  POINTER_ID_MOUSE,
  POINTER_ID_VIRTUAL_FINGER,
  ACTION,
  ACTION_POINTER_INDEX_SHIFT,
  BUTTON_PRIMARY,
  KEYCODE,
  u16FixedPoint,
  i16FixedPoint,
  touchEvent,
  keyEvent,
  textEvent,
  scrollEvent,
  displayPower,
  backOrScreenOn,
  emptyControl,
  rotateDevice,
  expandNotificationPanel,
  collapsePanels,
  startApp,
  DeviceMessageParser,
  VideoStreamParser,
}
