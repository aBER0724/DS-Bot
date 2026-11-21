// Web Push, the two parts that are pure crypto: the message (RFC 8291, `aes128gcm` with
// one record, RFC 8188's header) and the VAPID header that says who is pushing (RFC 8292).
// Nothing here touches the network or the team's files, so a test can hold it against the
// published test vectors.
//
// A push service only needs the subscription's own keys: the browser's public key and its
// 16-byte auth secret, both handed over when the device subscribed. Everything below is
// derived from those, one ephemeral key pair per message.
import { createCipheriv, createECDH, createPrivateKey, createSign, hkdfSync, randomBytes } from 'node:crypto'

const CURVE = 'prime256v1'
// One record holds the whole message; the receiver's buffer is far larger than any
// notification body DS Bot sends.
const RECORD_SIZE = 4096
const PAD = Buffer.from([2])
// How long a VAPID token is accepted for. Push services allow at most 24 hours.
const VAPID_TTL_MS = 12 * 60 * 60_000
/**
 * A buffer as base64url without padding, the encoding every Web Push field uses.
 * @param {Buffer} buffer
 * @returns {string}
 */
export const b64url = buffer => Buffer.from(buffer).toString('base64url')

/**
 * Read base64url (padding optional) back into a buffer.
 * @param {string} text
 * @returns {Buffer}
 */
export const unb64url = text => Buffer.from(String(text ?? ''), 'base64url')

/**
 * Whether a string is a base64url value of exactly the given byte length. A round trip
 * through the encoder is the test: node's decoder drops what it does not know, so only a
 * string that encodes to itself was valid.
 * @param {unknown} text
 * @param {number} bytes
 * @returns {boolean}
 */
export function isB64url(text, bytes) {
  if (typeof text !== 'string' || text.length === 0) return false
  const buffer = unb64url(text)
  return buffer.length === bytes && b64url(buffer) === text
}

/**
 * A new VAPID key pair, kept as the raw private scalar and the uncompressed public point.
 * @returns {{ privateKey: string, publicKey: string }} base64url, no padding
 */
export function newVapidKeys() {
  const ecdh = createECDH(CURVE)
  ecdh.generateKeys()
  return { privateKey: b64url(ecdh.getPrivateKey()), publicKey: b64url(ecdh.getPublicKey()) }
}

/**
 * The public point of a stored private key.
 * @param {string} privateKey
 * @returns {string} base64url, no padding
 */
export function publicKeyOf(privateKey) {
  const ecdh = createECDH(CURVE)
  ecdh.setPrivateKey(unb64url(privateKey))
  return b64url(ecdh.getPublicKey())
}

// The signing key as a JWK, which needs no DER to be assembled by hand.
function jwkOf(privateKey) {
  const ecdh = createECDH(CURVE)
  ecdh.setPrivateKey(unb64url(privateKey))
  const point = ecdh.getPublicKey()
  return { kty: 'EC', crv: 'P-256', d: b64url(ecdh.getPrivateKey()), x: b64url(point.subarray(1, 33)), y: b64url(point.subarray(33, 65)) }
}

/**
 * The `Authorization` value a push request carries: a signed VAPID token and the public key
 * the push service checks it with.
 * @param {{ endpoint: string, privateKey: string, subject?: string, now?: number }} options
 * @returns {string}
 */
export function vapidAuthorization({ endpoint, privateKey, subject = 'mailto:ds-bot@localhost', now = Date.now() }) {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const payload = b64url(Buffer.from(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor((now + VAPID_TTL_MS) / 1000),
    sub: subject,
  })))
  const signing = Buffer.from(`${header}.${payload}`)
  // ES256 signatures travel as r||s, which is what ieee-p1363 means.
  const key = createPrivateKey({ key: jwkOf(privateKey), format: 'jwk' })
  const signature = createSign('sha256').update(signing).sign({ key, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${header}.${payload}.${b64url(signature)}, k=${publicKeyOf(privateKey)}`
}

/**
 * Encrypt one notification body for one subscription.
 * @param {{ plaintext: string | Buffer, uaPublic: string, auth: string, ephemeralKey?: string, salt?: string }} options
 *   `ephemeralKey` and `salt` exist for the published test vector; production passes neither.
 * @returns {Buffer} the request body: salt, record size, key id, ciphertext
 */
export function encryptPush({ plaintext, uaPublic, auth, ephemeralKey, salt: fixedSalt }) {
  const uaPublicBytes = unb64url(uaPublic)
  if (uaPublicBytes.length !== 65 || uaPublicBytes[0] !== 4) throw new Error('The subscription public key is not an uncompressed P-256 point')
  const authSecret = unb64url(auth)
  if (authSecret.length !== 16) throw new Error('The subscription auth secret is not 16 bytes')
  const ecdh = createECDH(CURVE)
  if (ephemeralKey === undefined) ecdh.generateKeys()
  else ecdh.setPrivateKey(unb64url(ephemeralKey))
  const asPublic = ecdh.getPublicKey()
  const secret = ecdh.computeSecret(uaPublicBytes)
  const salt = fixedSalt === undefined ? randomBytes(16) : unb64url(fixedSalt)

  // RFC 8291 §3.4: the auth secret, the shared secret and both public keys feed the key
  // material; the salt then splits it into the record's key and nonce.
  const ikm = Buffer.from(hkdfSync('sha256', secret, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublicBytes, asPublic]), 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))

  const body = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext))
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([body, PAD])), cipher.final(), cipher.getAuthTag()])

  const header = Buffer.alloc(21)
  salt.copy(header, 0)
  header.writeUInt32BE(RECORD_SIZE, 16)
  header.writeUInt8(asPublic.length, 20)
  return Buffer.concat([header, asPublic, encrypted])
}

export { RECORD_SIZE, VAPID_TTL_MS }
