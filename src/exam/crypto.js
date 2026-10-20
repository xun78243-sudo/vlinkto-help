'use strict'
/**
 * 国密算法：SM3 / SM4 / SM2，全部纯 JS 实现。
 *
 * 与 exam_schedule.py 的实现逐行对齐（那份代码已与前端 sm-crypto / transferCrypto 做过互通验证）。
 * 注意：不能用 node:crypto —— Electron 内置的是 BoringSSL，没有 sm3 / sm4 算法，
 * createHash('sm3') 会抛 "Invalid digest: sm3"，在打包后的应用里才暴露。
 */

// ============================== 通用工具 ==============================

// 只借用 node:crypto 的随机数（BoringSSL 提供），国密算法全部纯 JS 实现
const nodeCrypto = require('crypto')

function rotl(x, n) {
  const s = n % 32
  return ((x << s) | (x >>> (32 - s))) >>> 0
}

function xorBytes(a, b) {
  const length = Math.min(a.length, b.length)
  const out = Buffer.alloc(length)
  for (let i = 0; i < length; i += 1) out[i] = a[i] ^ b[i]
  return out
}

/** 常量时间的等长比较（替代 node:crypto 的 timingSafeEqual） */
function timingSafeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i]
  return diff === 0
}

// ============================== SM3 ==============================

const SM3_IV = [
  0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600,
  0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e,
]

function sm3P0(x) {
  return (x ^ rotl(x, 9) ^ rotl(x, 17)) >>> 0
}

function sm3P1(x) {
  return (x ^ rotl(x, 15) ^ rotl(x, 23)) >>> 0
}

function sm3Compress(v, block, offset) {
  const w = new Uint32Array(68)
  for (let j = 0; j < 16; j += 1) {
    const p = offset + j * 4
    w[j] = ((block[p] << 24) | (block[p + 1] << 16) | (block[p + 2] << 8) | block[p + 3]) >>> 0
  }
  for (let j = 16; j < 68; j += 1) {
    w[j] = (sm3P1(w[j - 16] ^ w[j - 9] ^ rotl(w[j - 3], 15)) ^ rotl(w[j - 13], 7) ^ w[j - 6]) >>> 0
  }

  let a = v[0]
  let b = v[1]
  let c = v[2]
  let d = v[3]
  let e = v[4]
  let f = v[5]
  let g = v[6]
  let h = v[7]

  for (let j = 0; j < 64; j += 1) {
    let t
    let ff
    let gg
    if (j < 16) {
      t = 0x79cc4519
      ff = (a ^ b ^ c) >>> 0
      gg = (e ^ f ^ g) >>> 0
    } else {
      t = 0x7a879d8a
      ff = ((a & b) | (a & c) | (b & c)) >>> 0
      gg = ((e & f) | (~e & g)) >>> 0
    }
    const a12 = rotl(a, 12)
    const ss1 = rotl((a12 + e + rotl(t, j)) >>> 0, 7)
    const ss2 = (ss1 ^ a12) >>> 0
    const tt1 = (ff + d + ss2 + (w[j] ^ w[j + 4])) >>> 0
    const tt2 = (gg + h + ss1 + w[j]) >>> 0

    d = c
    c = rotl(b, 9)
    b = a
    a = tt1
    h = g
    g = rotl(f, 19)
    f = e
    e = sm3P0(tt2)
  }

  v[0] = (v[0] ^ a) >>> 0
  v[1] = (v[1] ^ b) >>> 0
  v[2] = (v[2] ^ c) >>> 0
  v[3] = (v[3] ^ d) >>> 0
  v[4] = (v[4] ^ e) >>> 0
  v[5] = (v[5] ^ f) >>> 0
  v[6] = (v[6] ^ g) >>> 0
  v[7] = (v[7] ^ h) >>> 0
}

/** SM3 摘要，返回 32 字节 */
function sm3(data) {
  const input = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
  const bitLength = input.length * 8
  const padLength = ((input.length + 9 + 63) >> 6) << 6
  const buffer = Buffer.alloc(padLength)
  input.copy(buffer)
  buffer[input.length] = 0x80
  buffer.writeUInt32BE(Math.floor(bitLength / 0x100000000) >>> 0, padLength - 8)
  buffer.writeUInt32BE(bitLength >>> 0, padLength - 4)

  const v = SM3_IV.slice()
  for (let offset = 0; offset < padLength; offset += 64) sm3Compress(v, buffer, offset)

  const out = Buffer.alloc(32)
  for (let i = 0; i < 8; i += 1) out.writeUInt32BE(v[i], i * 4)
  return out
}

/** HMAC-SM3，块长 64 字节 */
function hmacSm3(key, message) {
  let k = Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'utf8')
  const msg = Buffer.isBuffer(message) ? message : Buffer.from(String(message), 'utf8')
  if (k.length > 64) k = sm3(k)
  const padded = Buffer.alloc(64)
  k.copy(padded)

  const ipad = Buffer.alloc(64)
  const opad = Buffer.alloc(64)
  for (let i = 0; i < 64; i += 1) {
    ipad[i] = padded[i] ^ 0x36
    opad[i] = padded[i] ^ 0x5c
  }
  return sm3(Buffer.concat([opad, sm3(Buffer.concat([ipad, msg]))]))
}

// ============================== SM4 ==============================

const SM4_SBOX = Uint8Array.from([
  0xd6, 0x90, 0xe9, 0xfe, 0xcc, 0xe1, 0x3d, 0xb7, 0x16, 0xb6, 0x14, 0xc2, 0x28, 0xfb, 0x2c, 0x05,
  0x2b, 0x67, 0x9a, 0x76, 0x2a, 0xbe, 0x04, 0xc3, 0xaa, 0x44, 0x13, 0x26, 0x49, 0x86, 0x06, 0x99,
  0x9c, 0x42, 0x50, 0xf4, 0x91, 0xef, 0x98, 0x7a, 0x33, 0x54, 0x0b, 0x43, 0xed, 0xcf, 0xac, 0x62,
  0xe4, 0xb3, 0x1c, 0xa9, 0xc9, 0x08, 0xe8, 0x95, 0x80, 0xdf, 0x94, 0xfa, 0x75, 0x8f, 0x3f, 0xa6,
  0x47, 0x07, 0xa7, 0xfc, 0xf3, 0x73, 0x17, 0xba, 0x83, 0x59, 0x3c, 0x19, 0xe6, 0x85, 0x4f, 0xa8,
  0x68, 0x6b, 0x81, 0xb2, 0x71, 0x64, 0xda, 0x8b, 0xf8, 0xeb, 0x0f, 0x4b, 0x70, 0x56, 0x9d, 0x35,
  0x1e, 0x24, 0x0e, 0x5e, 0x63, 0x58, 0xd1, 0xa2, 0x25, 0x22, 0x7c, 0x3b, 0x01, 0x21, 0x78, 0x87,
  0xd4, 0x00, 0x46, 0x57, 0x9f, 0xd3, 0x27, 0x52, 0x4c, 0x36, 0x02, 0xe7, 0xa0, 0xc4, 0xc8, 0x9e,
  0xea, 0xbf, 0x8a, 0xd2, 0x40, 0xc7, 0x38, 0xb5, 0xa3, 0xf7, 0xf2, 0xce, 0xf9, 0x61, 0x15, 0xa1,
  0xe0, 0xae, 0x5d, 0xa4, 0x9b, 0x34, 0x1a, 0x55, 0xad, 0x93, 0x32, 0x30, 0xf5, 0x8c, 0xb1, 0xe3,
  0x1d, 0xf6, 0xe2, 0x2e, 0x82, 0x66, 0xca, 0x60, 0xc0, 0x29, 0x23, 0xab, 0x0d, 0x53, 0x4e, 0x6f,
  0xd5, 0xdb, 0x37, 0x45, 0xde, 0xfd, 0x8e, 0x2f, 0x03, 0xff, 0x6a, 0x72, 0x6d, 0x6c, 0x5b, 0x51,
  0x8d, 0x1b, 0xaf, 0x92, 0xbb, 0xdd, 0xbc, 0x7f, 0x11, 0xd9, 0x5c, 0x41, 0x1f, 0x10, 0x5a, 0xd8,
  0x0a, 0xc1, 0x31, 0x88, 0xa5, 0xcd, 0x7b, 0xbd, 0x2d, 0x74, 0xd0, 0x12, 0xb8, 0xe5, 0xb4, 0xb0,
  0x89, 0x69, 0x97, 0x4a, 0x0c, 0x96, 0x77, 0x7e, 0x65, 0xb9, 0xf1, 0x09, 0xc5, 0x6e, 0xc6, 0x84,
  0x18, 0xf0, 0x7d, 0xec, 0x3a, 0xdc, 0x4d, 0x20, 0x79, 0xee, 0x5f, 0x3e, 0xd7, 0xcb, 0x39, 0x48,
])

const SM4_FK = [0xa3b1bac6, 0x56aa3350, 0x677d9197, 0xb27022dc]
const SM4_CK = (() => {
  const out = new Uint32Array(32)
  for (let i = 0; i < 32; i += 1) {
    out[i] = (((4 * i) * 7 % 256) << 24) | (((4 * i + 1) * 7 % 256) << 16)
      | (((4 * i + 2) * 7 % 256) << 8) | ((4 * i + 3) * 7 % 256)
  }
  return out
})()

function sm4Sub(x) {
  return ((SM4_SBOX[x >>> 24] << 24)
    | (SM4_SBOX[(x >>> 16) & 0xff] << 16)
    | (SM4_SBOX[(x >>> 8) & 0xff] << 8)
    | SM4_SBOX[x & 0xff]) >>> 0
}

function sm4T(x) {
  const y = sm4Sub(x)
  return (y ^ rotl(y, 2) ^ rotl(y, 10) ^ rotl(y, 18) ^ rotl(y, 24)) >>> 0
}

function sm4TPrime(x) {
  const y = sm4Sub(x)
  return (y ^ rotl(y, 13) ^ rotl(y, 23)) >>> 0
}

/** 由 16 字节密钥派生 32 轮轮密钥 */
function sm4RoundKeys(key) {
  if (!key || key.length !== 16) throw new Error('SM4 密钥必须为 16 字节')
  const k = new Uint32Array(36)
  for (let i = 0; i < 4; i += 1) {
    k[i] = (key.readUInt32BE(i * 4) ^ SM4_FK[i]) >>> 0
  }
  const rk = new Uint32Array(32)
  for (let i = 0; i < 32; i += 1) {
    k[i + 4] = (k[i] ^ sm4TPrime(k[i + 1] ^ k[i + 2] ^ k[i + 3] ^ SM4_CK[i])) >>> 0
    rk[i] = k[i + 4]
  }
  return rk
}

function sm4Block(raw, rk) {
  const x = new Uint32Array(36)
  for (let i = 0; i < 4; i += 1) x[i] = raw.readUInt32BE(i * 4)
  for (let i = 0; i < 32; i += 1) {
    x[i + 4] = (x[i] ^ sm4T(x[i + 1] ^ x[i + 2] ^ x[i + 3] ^ rk[i])) >>> 0
  }
  const out = Buffer.alloc(16)
  const order = [35, 34, 33, 32]
  for (let i = 0; i < 4; i += 1) out.writeUInt32BE(x[order[i]], i * 4)
  return out
}

function sm4EncryptBlock(block, key) {
  return sm4Block(block, sm4RoundKeys(key))
}

function sm4DecryptBlock(block, key) {
  return sm4Block(block, Uint32Array.from(sm4RoundKeys(key)).reverse())
}

function pkcs7Unpad(data) {
  if (!data.length) throw new Error('空数据无法去填充')
  const pad = data[data.length - 1]
  if (pad < 1 || pad > 16 || pad > data.length) throw new Error(`PKCS#7 填充非法: ${pad}`)
  for (let i = data.length - pad; i < data.length; i += 1) {
    if (data[i] !== pad) throw new Error('PKCS#7 填充内容非法')
  }
  return data.subarray(0, data.length - pad)
}

function sm4CbcPkcs7Decrypt(key, iv, cipher) {
  if (!iv || iv.length !== 16) throw new Error('SM4-CBC IV 必须为 16 字节')
  if (!cipher || cipher.length === 0 || cipher.length % 16 !== 0) {
    throw new Error('SM4-CBC 密文长度非法')
  }
  const rk = Uint32Array.from(sm4RoundKeys(key)).reverse() // 解密用逆序轮密钥
  let prev = iv
  const out = Buffer.alloc(cipher.length)
  for (let offset = 0; offset < cipher.length; offset += 16) {
    const block = cipher.subarray(offset, offset + 16)
    const plain = xorBytes(sm4Block(block, rk), prev)
    plain.copy(out, offset)
    prev = block
  }
  return Buffer.from(pkcs7Unpad(out))
}

// ============================== SM2 ==============================

const SM2_P = 0xfffffffeffffffffffffffffffffffffffffffff00000000ffffffffffffffffn
const SM2_A = 0xfffffffeffffffffffffffffffffffffffffffff00000000fffffffffffffffcn
const SM2_B = 0x28e9fa9e9d9f5e344d5a9e4bcf6509a7f39789f515ab8f92ddbcbd414d940e93n
const SM2_N = 0xfffffffeffffffffffffffffffffffff7203df6b21c6052b53bbf40939d54123n
const SM2_G = [
  0x32c4ae2c1f1981195f9904466a39c9948fe30bbff2660be1715a4589334c74c7n,
  0xbc3736a2f4f6779c59bdcee36b692153d0a9877cc62a474002df32e52139f0a0n,
]

function mod(value, m) {
  const r = value % m
  return r < 0n ? r + m : r
}

function modPow(base, exponent, m) {
  let result = 1n
  let b = mod(base, m)
  let e = exponent
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m
    b = (b * b) % m
    e >>= 1n
  }
  return result
}

function bufToBigInt(buf) {
  return buf.length ? BigInt('0x' + buf.toString('hex')) : 0n
}

function bigIntToBuf(value, length = 32) {
  const hex = value.toString(16).padStart(length * 2, '0')
  return Buffer.from(hex, 'hex')
}

function sm2OnCurve(point) {
  if (!point) return false
  const [x, y] = point
  if (x < 0n || x >= SM2_P || y < 0n || y >= SM2_P) return false
  return mod(y * y - (x * x * x + SM2_A * x + SM2_B), SM2_P) === 0n
}

function sm2Add(p1, p2) {
  if (!p1) return p2
  if (!p2) return p1
  const [x1, y1] = p1
  const [x2, y2] = p2
  let lambda
  if (x1 === x2) {
    if (mod(y1 + y2, SM2_P) === 0n) return null
    lambda = mod((3n * x1 * x1 + SM2_A) * modPow(2n * y1, SM2_P - 2n, SM2_P), SM2_P)
  } else {
    lambda = mod((y2 - y1) * modPow(x2 - x1, SM2_P - 2n, SM2_P), SM2_P)
  }
  const x3 = mod(lambda * lambda - x1 - x2, SM2_P)
  const y3 = mod(lambda * (x1 - x3) - y1, SM2_P)
  return [x3, y3]
}

function sm2Mul(k, point) {
  let result = null
  let addend = point
  let scalar = k
  while (scalar > 0n) {
    if (scalar & 1n) result = sm2Add(result, addend)
    addend = sm2Add(addend, addend)
    scalar >>= 1n
  }
  return result
}

function sm2Kdf(z, klen) {
  const parts = []
  let counter = 1
  let total = 0
  while (total < klen) {
    const block = sm3(Buffer.concat([z, Buffer.from([
      (counter >>> 24) & 0xff, (counter >>> 16) & 0xff, (counter >>> 8) & 0xff, counter & 0xff,
    ])]))
    parts.push(block)
    total += block.length
    counter += 1
  }
  return Buffer.concat(parts).subarray(0, klen)
}

function sm2Core(x2, y2, c2, c3) {
  const z = Buffer.concat([bigIntToBuf(x2), bigIntToBuf(y2)])
  const t = sm2Kdf(z, c2.length)
  if (t.every((byte) => byte === 0)) throw new Error('SM2 KDF 输出全零')
  const msg = xorBytes(c2, t)
  const digest = sm3(Buffer.concat([z.subarray(0, 32), msg, z.subarray(32)]))
  if (!digest.equals(c3)) throw new Error('SM2 C3 校验不通过')
  return msg
}

/**
 * 解密 sm-crypto 的 SM2 密文（hex，C1C3C2），兼容 "04" 前缀与裸 C1 两种布局。
 * @param {string} hexStr 16 进制密文
 * @param {string} privateKeyHex 私钥（32 字节 hex）
 * @returns {Buffer} 明文
 */
function sm2Decrypt(hexStr, privateKeyHex) {
  const raw = Buffer.from(hexStr, 'hex')
  const priv = BigInt('0x' + privateKeyHex)

  const candidates = []
  if (raw.length >= 1 + 64 + 32 + 1 && raw[0] === 0x04) candidates.push(raw.subarray(1))
  candidates.push(raw)

  let lastError = null
  for (const body of candidates) {
    if (body.length < 96) {
      lastError = new Error(`SM2 密文长度不足: ${body.length}`)
      continue
    }
    const c1 = [bufToBigInt(body.subarray(0, 32)), bufToBigInt(body.subarray(32, 64))]
    if (!sm2OnCurve(c1)) {
      lastError = new Error('SM2 C1 不在曲线上')
      continue
    }
    const c3 = body.subarray(64, 96)
    const c2 = body.subarray(96)
    const shared = sm2Mul(priv, c1)
    if (!shared) {
      lastError = new Error('SM2 共享点无穷远')
      continue
    }
    try {
      return sm2Core(shared[0], shared[1], c2, c3)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('SM2 解密失败')
}

/** 仅供自检：SM2 加密，返回 "04"+hex(C1C3C2)。 */
function sm2Encrypt(plain, publicKeyHex) {
  let pub = publicKeyHex
  if (pub.startsWith('04')) pub = pub.slice(2)
  const pPub = [BigInt('0x' + pub.slice(0, 64)), BigInt('0x' + pub.slice(64, 128))]
  const k = BigInt('0x' + nodeCrypto.randomBytes(32).toString('hex')) % (SM2_N - 1n) + 1n
  const c1 = sm2Mul(k, SM2_G)
  const shared = sm2Mul(k, pPub)
  if (!shared) throw new Error('SM2 共享点无穷远')
  const z = Buffer.concat([bigIntToBuf(shared[0]), bigIntToBuf(shared[1])])
  const t = sm2Kdf(z, plain.length)
  const c2 = xorBytes(plain, t)
  const c3 = sm3(Buffer.concat([z.subarray(0, 32), plain, z.subarray(32)]))
  return '04' + Buffer.concat([bigIntToBuf(c1[0]), bigIntToBuf(c1[1]), c3, c2]).toString('hex')
}

function sm2PublicKeyFromPrivate(privateKeyHex) {
  const point = sm2Mul(BigInt('0x' + privateKeyHex), SM2_G)
  return '04' + Buffer.concat([bigIntToBuf(point[0]), bigIntToBuf(point[1])]).toString('hex')
}

module.exports = {
  sm3,
  hmacSm3,
  xorBytes,
  timingSafeEqual,
  sm4CbcPkcs7Decrypt,
  sm4EncryptBlock,
  sm4DecryptBlock,
  sm2Decrypt,
  sm2Encrypt,
  sm2PublicKeyFromPrivate,
  SM2_N,
  SM2_G,
}
