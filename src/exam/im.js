'use strict'
/**
 * IM 消息解密门面，对齐 jim-oa-web/src/tools：
 *   - 旧链路：SM2（tools.decrypt -> sm2.doDecrypt）
 *   - 新链路：transferCrypto.js（HKDF-SM3 派生 SM4 密钥 + HMAC-SM3 校验）
 */

const {
  sm3, hmacSm3, sm4CbcPkcs7Decrypt, sm2Decrypt, timingSafeEqual,
} = require('./crypto')

// transferCrypto.js 中的 HKDF_SALT
const HKDF_SALT = Buffer.from([
  0xa3, 0x5f, 0x12, 0xe8, 0x4b, 0x7c, 0x19, 0xd6,
  0x2e, 0xaa, 0x71, 0x0f, 0xcd, 0x36, 0x98, 0x55,
])

const RE_HEX = /^[0-9a-fA-F]+$/
const RE_B64 = /^[A-Za-z0-9+/=]+$/

/** IKM = msgId + sessionId + transferKey -> { encKey(16), macKey(32) } */
function deriveTransferKeys(keyMaterial) {
  const prk = hmacSm3(HKDF_SALT, Buffer.from(keyMaterial, 'utf8'))

  const expand = (info, length) => {
    const infoBuf = Buffer.from(info, 'utf8')
    const chunks = []
    let block = Buffer.alloc(0)
    let counter = 1
    let total = 0
    while (total < length) {
      block = hmacSm3(prk, Buffer.concat([block, infoBuf, Buffer.from([counter])]))
      chunks.push(block)
      total += block.length
      counter += 1
    }
    return Buffer.concat(chunks).subarray(0, length)
  }

  return {
    encKey: expand('sm4-enc-key', 16),
    macKey: expand('sm3-hmac-key', 32),
  }
}

/**
 * 解密 transferCrypto.decryptContent：Base64(IV16 + SM4-CBC 密文 + HMAC-SM3 32)
 * @returns {Buffer|null} 解密失败返回 null（不抛异常）
 */
function decryptSm4Transfer(cipherB64, msgId, sessionId, transferKey) {
  let data
  try {
    data = Buffer.from(cipherB64, 'base64')
  } catch (error) {
    return null
  }
  if (data.length < 48) return null

  const { encKey, macKey } = deriveTransferKeys(
    `${msgId || ''}${sessionId || ''}${transferKey || ''}`,
  )
  const iv = data.subarray(0, 16)
  const body = data.subarray(16, data.length - 32)
  const receivedMac = data.subarray(data.length - 32)
  if (!body.length || body.length % 16 !== 0) return null

  const expectedMac = hmacSm3(macKey, Buffer.concat([iv, body]))
  if (!timingSafeEqual(receivedMac, expectedMac)) return null

  try {
    return sm4CbcPkcs7Decrypt(encKey, iv, body)
  } catch (error) {
    return null
  }
}

/** 判断密文形态：'hex'(SM2) / 'b64'(SM4) / null(当明文处理) */
function classifyCipher(text) {
  if (RE_HEX.test(text) && text.length >= 130 && text.length % 2 === 0) return 'hex'
  if (RE_B64.test(text) && text.length >= 64) {
    try {
      if (Buffer.from(text, 'base64').length >= 48) return 'b64'
    } catch (error) {
      return null
    }
  }
  return null
}

/** 解密后若是 JSON，按 tools.decrypt(...)->JSON.parse 的用法取出正文字段 */
function unwrapJsonText(text) {
  const stripped = text.trim()
  if (!stripped || (stripped[0] !== '{' && stripped[0] !== '[')) return text
  let obj
  try {
    obj = JSON.parse(stripped)
  } catch (error) {
    return text
  }
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const key of ['data', 'content', 'text', 'msg', 'message', 'title']) {
      const value = obj[key]
      if (typeof value === 'string' && value.trim()) return unwrapJsonText(value)
    }
  }
  return JSON.stringify(obj)
}

/**
 * 解析消息正文。
 * @returns {{ text: string|null, how: 'empty'|'plain'|'sm2'|'sm4'|'failed' }}
 */
function resolveContent(msg, ctx = {}) {
  const raw = msg && msg.content
  if (typeof raw !== 'string' || !raw.trim()) return { text: null, how: 'empty' }
  const text = raw.trim()
  const kind = classifyCipher(text)
  if (!kind) return { text, how: 'plain' }

  const msgId = String(msg.msgId || msg.id || '')
  const sessionId = String(ctx.groupId || '')
  const transferKey = ctx.transferKey || ''

  const decode = (buf) => unwrapJsonText(buf.toString('utf8'))

  if (kind === 'b64' && transferKey) {
    const plain = decryptSm4Transfer(text, msgId, sessionId, transferKey)
    if (plain) return { text: decode(plain), how: 'sm4' }
  }

  if (ctx.sm2PrivateKey) {
    try {
      const plain = sm2Decrypt(text, ctx.sm2PrivateKey)
      return { text: decode(plain), how: 'sm2' }
    } catch (error) {
      /* 落到 failed */
    }
  }

  return { text: null, how: 'failed' }
}

module.exports = {
  HKDF_SALT,
  deriveTransferKeys,
  decryptSm4Transfer,
  classifyCipher,
  unwrapJsonText,
  resolveContent,
  sm3,
}
