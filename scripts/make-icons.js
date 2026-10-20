'use strict'
/**
 * 生成应用图标（不依赖任何第三方库，手写 PNG 编码）。
 * 输出：assets/icon.png(256)、assets/tray.png(32)、assets/tray@2x.png(64)
 */

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const OUT_DIR = path.join(__dirname, '..', 'assets')

// ------------------------------ PNG 编码 ------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([length, typeBuf, data, crcBuf])
}

/** @param {Buffer} rgba 长度 = width*height*4 */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ------------------------------ 绘制 ------------------------------

function mix(colorA, colorB, t) {
  return [
    colorA[0] + (colorB[0] - colorA[0]) * t,
    colorA[1] + (colorB[1] - colorA[1]) * t,
    colorA[2] + (colorB[2] - colorA[2]) * t,
  ]
}

/** 点到线段的距离（用于画指针） */
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const lengthSq = dx * dx + dy * dy
  let t = lengthSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lengthSq
  t = Math.max(0, Math.min(1, t))
  const cx = x1 + t * dx
  const cy = y1 + t * dy
  return Math.hypot(px - cx, py - cy)
}

/**
 * 画一个圆角时钟图标。
 * @param {number} size 边长
 */
function drawClock(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const SS = 3 // 每像素 3x3 超采样做抗锯齿
  const center = size / 2
  const radius = size * 0.46
  const bgTop = [47, 111, 237]
  const bgBottom = [94, 156, 255]
  const white = [255, 255, 255]

  const handWidth = Math.max(1.2, size * 0.055)
  const hubRadius = size * 0.06

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0

      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x + (sx + 0.5) / SS
          const py = y + (sy + 0.5) / SS
          const dist = Math.hypot(px - center, py - center)

          if (dist > radius) continue // 圆外透明

          // 表盘底色（竖向渐变）
          const t = Math.max(0, Math.min(1, py / size))
          let color = mix(bgTop, bgBottom, t)

          // 指针：竖线 + 斜线 + 圆心
          const vLine = distToSegment(px, py, center, center, center, center - radius * 0.55)
          const hLine = distToSegment(px, py, center, center, center + radius * 0.42, center + radius * 0.22)
          const inHands = vLine <= handWidth / 2 || hLine <= handWidth / 2
          const inHub = dist <= hubRadius
          if (inHands || inHub) color = white

          r += color[0]
          g += color[1]
          b += color[2]
          a += 255
        }
      }

      const samples = SS * SS
      const alpha = a / samples
      const offset = (y * size + x) * 4
      if (alpha <= 0) {
        rgba[offset] = 0
        rgba[offset + 1] = 0
        rgba[offset + 2] = 0
        rgba[offset + 3] = 0
      } else {
        // 用有效样本归一化颜色，避免边缘发黑
        const weight = a / 255
        rgba[offset] = Math.round(r / weight)
        rgba[offset + 1] = Math.round(g / weight)
        rgba[offset + 2] = Math.round(b / weight)
        rgba[offset + 3] = Math.round(alpha)
      }
    }
  }
  return rgba
}

/**
 * 生成 ICO（Windows 图标）：多尺寸 PNG 内嵌方案，Vista 以上原生支持。
 * @param {Array<{size: number, png: Buffer}>} entries 升序排列
 */
function encodeIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type = icon
  header.writeUInt16LE(entries.length, 4)

  const directory = Buffer.alloc(16 * entries.length)
  let offset = 6 + 16 * entries.length

  entries.forEach((entry, index) => {
    const base = index * 16
    const dim = entry.size >= 256 ? 0 : entry.size
    directory[base] = dim
    directory[base + 1] = dim
    directory[base + 2] = 0 // 调色板数
    directory[base + 3] = 0 // reserved
    directory.writeUInt16LE(1, base + 4) // color planes
    directory.writeUInt16LE(32, base + 6) // bits per pixel
    directory.writeUInt32LE(entry.png.length, base + 8)
    directory.writeUInt32LE(offset, base + 12)
    offset += entry.png.length
  })

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.png)])
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const targets = [
    ['icon.png', 256],
    ['tray.png', 32],
    ['tray@2x.png', 64],
  ]
  for (const [name, size] of targets) {
    const file = path.join(OUT_DIR, name)
    fs.writeFileSync(file, encodePng(size, size, drawClock(size)))
    console.log(`generated ${name} (${size}x${size})`)
  }

  const icoSizes = [16, 24, 32, 48, 64, 128, 256]
  const icoPath = path.join(OUT_DIR, 'icon.ico')
  fs.writeFileSync(icoPath, encodeIco(icoSizes.map((size) => ({
    size,
    png: encodePng(size, size, drawClock(size)),
  }))))
  console.log(`generated icon.ico (${icoSizes.join('/')})`)
}

main()
