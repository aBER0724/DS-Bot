import assert from 'node:assert/strict'
import { createDecipheriv, createECDH, createPublicKey, createVerify, hkdfSync, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fakeContext } from './fake-ctx.js'
import { install, payloadOf, pushKindOf, wantsPush } from '../src/host/push.js'
import { b64url, encryptPush, isB64url, newVapidKeys, publicKeyOf, vapidAuthorization, unb64url } from '../src/host/push-crypto.js'
import { SERVICE_WORKER } from '../src/host/push-sw.js'

// The published Web Push example (RFC 8291 appendix A): the same keys, the same salt, the
// same plaintext, and the exact body the RFC prints.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  ephemeralKey: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

// What a browser does with a push body: parse the header, derive the same keys from its own
// private key, and open the record.
function decryptPush(body, { privateKey, auth }) {
  const salt = body.subarray(0, 16)
  const keyIdLength = body.readUInt8(20)
  const asPublic = body.subarray(21, 21 + keyIdLength)
  const ciphertext = body.subarray(21 + keyIdLength)
  const ua = createECDH('prime256v1')
  ua.setPrivateKey(unb64url(privateKey))
  const secret = ua.computeSecret(asPublic)
  const authSecret = unb64url(auth)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic])
  const ikm = Buffer.from(hkdf(secret, authSecret, keyInfo, 32))
  const cek = Buffer.from(hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const tag = ciphertext.subarray(ciphertext.length - 16)
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(tag)
  const record = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()])
  // The last record ends with a 0x02 pad delimiter, then zero padding.
  const end = record.lastIndexOf(2)
  return record.subarray(0, end)
}

function hkdf(ikm, salt, info, length) {
  return hkdfSync('sha256', ikm, salt, info, length)
}

test('a push body matches the published Web Push example', () => {
  const body = encryptPush({
    plaintext: RFC.plaintext,
    uaPublic: RFC.uaPublic,
    auth: RFC.auth,
    ephemeralKey: RFC.ephemeralKey,
    salt: RFC.salt,
  })
  assert.equal(b64url(body), RFC.body)
})

test('what a browser opens is what was sent', () => {
  const ua = createECDH('prime256v1')
  ua.generateKeys()
  const auth = b64url(randomBytes(16))
  const body = encryptPush({ plaintext: JSON.stringify({ title: 'Chief', kind: 'reply' }), uaPublic: b64url(ua.getPublicKey()), auth })
  assert.equal(decryptPush(body, { privateKey: b64url(ua.getPrivateKey()), auth }).toString(), JSON.stringify({ title: 'Chief', kind: 'reply' }))
})

test('the VAPID header is a signed token for that push service', () => {
  const keys = newVapidKeys()
  const header = vapidAuthorization({ endpoint: 'https://push.example.net/message/abc', privateKey: keys.privateKey, now: 1_700_000_000_000 })
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(header)
  assert.ok(match, header)
  const [token, key] = [match[1], match[2]]
  const [head, payload, signature] = token.split('.')
  assert.deepEqual(JSON.parse(unb64url(head).toString()), { typ: 'JWT', alg: 'ES256' })
  const claims = JSON.parse(unb64url(payload).toString())
  assert.equal(claims.aud, 'https://push.example.net')
  assert.equal(claims.exp, 1_700_000_000_000 / 1000 + 12 * 60 * 60)
  assert.match(claims.sub, /^mailto:/)
  assert.equal(key, publicKeyOf(keys.privateKey))
  // r||s, 64 bytes, which verifies with the same key as ieee-p1363.
  const raw = unb64url(signature)
  assert.equal(raw.length, 64)
  const x = unb64url(key).subarray(1, 33)
  const y = unb64url(key).subarray(33, 65)
  const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64url(x), y: b64url(y) }, format: 'jwk' })
  assert.equal(createVerify('sha256').update(`${head}.${payload}`).verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, raw), true)
})

test('base64url values are read by length, and only in that alphabet', () => {
  const keys = newVapidKeys()
  assert.equal(isB64url(keys.privateKey, 32), true)
  assert.equal(isB64url(keys.publicKey, 65), true)
  assert.equal(isB64url(keys.publicKey, 32), false)
  assert.equal(isB64url('not base64url!', 65), false)
  assert.equal(isB64url('', 0), false)
  assert.equal(isB64url(undefined, 65), false)
})

test('a notice is pushed for a reply, a question, and a group that calls the user', () => {
  assert.equal(pushKindOf({ kind: 'message' }), 'reply')
  assert.equal(pushKindOf({ kind: 'question' }), 'question')
  assert.equal(pushKindOf({ kind: 'approval' }), 'question')
  assert.equal(pushKindOf({ kind: 'group', text: 'hello @you there' }), 'mention')
  assert.equal(pushKindOf({ kind: 'group', text: 'hello @User' }), 'mention')
  // An ordinary group reply, a finished-work line and a view card are not worth a phone.
  assert.equal(pushKindOf({ kind: 'group', text: 'done with the draft' }), undefined)
  assert.equal(pushKindOf({ kind: 'done' }), undefined)
  assert.equal(pushKindOf({ kind: 'view' }), undefined)
  // An address or a code fence is not a call.
  assert.equal(pushKindOf({ kind: 'group', text: 'mail me at a@user.example' }), undefined)
  assert.equal(pushKindOf({ kind: 'group', text: '`@you`' }), undefined)
})

test('a device is woken unless its switches or what it shows say otherwise', () => {
  const notice = { sessionId: 's1', kind: 'message' }
  const now = Date.now()
  assert.equal(wantsPush({ enabled: true }, notice, 'reply', now), true)
  assert.equal(wantsPush({ enabled: false }, notice, 'reply', now), false)
  assert.equal(wantsPush({ enabled: true, muted: ['s1'] }, notice, 'reply', now), false)
  const looking = { enabled: true, presence: { sessionId: 's1', visible: true, focused: true, at: now } }
  assert.equal(wantsPush(looking, notice, 'reply', now), false)
  // Another conversation, another tab, or a report too old to trust does not count.
  assert.equal(wantsPush({ ...looking, presence: { ...looking.presence, sessionId: 's2' } }, notice, 'reply', now), true)
  assert.equal(wantsPush({ ...looking, presence: { ...looking.presence, visible: false } }, notice, 'reply', now), true)
  assert.equal(wantsPush({ ...looking, presence: { ...looking.presence, at: now - 120_000 } }, notice, 'reply', now), true)
})

test('a push names the conversation and never the message', () => {
  assert.deepEqual(payloadOf({ kind: 'message', name: 'Chief', text: 'the answer is 42', sessionId: 's1' }, 'reply'),
    { title: 'Chief', kind: 'reply', sessionId: 's1' })
  assert.deepEqual(payloadOf({ kind: 'group', title: '研发群', roomId: 'r1', text: '@you' }, 'mention'),
    { title: '研发群', kind: 'mention', roomId: 'r1' })
  assert.equal(payloadOf({}, 'reply').title, 'DS Bot')
})

function bench() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-push-'))
  const ctx = fakeContext()
  const routes = []
  ctx.connection = { fetch: { register: route => { routes.push(route); return () => {} } } }
  const warnings = []
  const rt = { ctx, home, warn: (...args) => warnings.push(args) }
  install(rt)
  return { rt, ctx, home, routes, warnings }
}

function subscription() {
  const ua = createECDH('prime256v1')
  ua.generateKeys()
  const auth = b64url(randomBytes(16))
  return {
    privateKey: b64url(ua.getPrivateKey()),
    auth,
    wire: { endpoint: 'https://push.example.net/message/abc', keys: { p256dh: b64url(ua.getPublicKey()), auth } },
  }
}

test('a device subscribes, is stored with its switches, and can be dropped', async () => {
  const { rt, home } = bench()
  const sub = subscription()
  const state = await rt.pushEndpoint('push-state', {})
  assert.equal(state.ok, true)
  assert.equal(isB64url(state.value.publicKey, 65), true)

  assert.equal((await rt.pushEndpoint('push-subscribe', { subscription: sub.wire })).ok, true)
  const file = join(home, 'push.json')
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.devices.length, 1)
  assert.equal(saved.devices[0].endpoint, sub.wire.endpoint)
  assert.equal(saved.devices[0].enabled, true)
  assert.equal(statSync(file).mode & 0o777, 0o600)

  await rt.pushEndpoint('push-prefs', { endpoint: sub.wire.endpoint, enabled: false, muted: ['s1'] })
  const after = JSON.parse(readFileSync(file, 'utf8')).devices[0]
  assert.equal(after.enabled, false)
  assert.deepEqual(after.muted, ['s1'])

  const presence = await rt.pushEndpoint('push-presence', { endpoint: sub.wire.endpoint, sessionId: 's1', visible: true, focused: true })
  assert.deepEqual(presence, { ok: true, value: { known: true } })

  const removed = await rt.pushEndpoint('push-unsubscribe', { endpoint: sub.wire.endpoint })
  assert.deepEqual(removed, { ok: true, value: { removed: true } })
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).devices.length, 0)
})

test('a subscription that is not one is refused', async () => {
  const { rt, home } = bench()
  for (const subscription of [
    undefined,
    { endpoint: 'http://insecure.example/x', keys: { p256dh: b64url(randomBytes(65)), auth: b64url(randomBytes(16)) } },
    { endpoint: 'https://push.example.net/x', keys: { p256dh: 'short', auth: b64url(randomBytes(16)) } },
    { endpoint: 'https://push.example.net/x', keys: { p256dh: b64url(Buffer.concat([Buffer.from([4]), randomBytes(64)])), auth: 'nope' } },
  ]) {
    const answer = await rt.pushEndpoint('push-subscribe', { subscription })
    assert.equal(answer.ok, false, JSON.stringify(subscription))
  }
  assert.equal(JSON.parse(readFileSync(join(home, 'push.json'), 'utf8')).devices.length, 0)
})

test('a notice reaches the subscribed device, and one a phone reads is dropped', async () => {
  const { rt } = bench()
  const sub = subscription()
  await rt.pushEndpoint('push-subscribe', { subscription: sub.wire })
  const sent = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (endpoint, init) => {
    sent.push({ endpoint, init })
    return new Response('', { status: 201 })
  }
  try {
    rt.pushNotice({ kind: 'message', name: 'Chief', sessionId: 's1', text: 'hello' })
    await waitFor(() => sent.length === 1)
    const [request] = sent
    assert.equal(request.endpoint, sub.wire.endpoint)
    assert.equal(request.init.headers['content-encoding'], 'aes128gcm')
    assert.equal(request.init.headers.ttl, String(12 * 60 * 60))
    assert.equal(request.init.headers.urgency, 'normal')
    assert.match(request.init.headers.authorization, /^vapid t=.+, k=.+$/)
    const opened = JSON.parse(decryptPush(Buffer.from(request.init.body), { privateKey: sub.privateKey, auth: sub.auth }).toString())
    assert.deepEqual(opened, { title: 'Chief', kind: 'reply', sessionId: 's1' })

    // A question is urgent, an ordinary group line is not pushed at all.
    rt.pushNotice({ kind: 'question', name: 'Chief', sessionId: 's1', text: 'pick one' })
    await waitFor(() => sent.length === 2)
    assert.equal(sent[1].init.headers.urgency, 'high')
    rt.pushNotice({ kind: 'group', title: '群', roomId: 'r1', text: '进度更新' })
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(sent.length, 2)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a push service that dropped the subscription takes the record with it', async () => {
  const { rt, home } = bench()
  const sub = subscription()
  await rt.pushEndpoint('push-subscribe', { subscription: sub.wire })
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('', { status: 410 })
  try {
    rt.pushNotice({ kind: 'message', name: 'Chief', sessionId: 's1', text: 'hi' })
    await waitFor(() => JSON.parse(readFileSync(join(home, 'push.json'), 'utf8')).devices.length === 0)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('the service worker is served at the origin root', async () => {
  const { routes } = bench()
  const route = routes.find(entry => entry.path === '/sw.js')
  assert.ok(route, 'no /sw.js route')
  assert.deepEqual(route.methods, ['GET'])
  const response = await route.fetch(new Request('https://example.test/sw.js'))
  assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8')
  const text = await response.text()
  assert.equal(text, SERVICE_WORKER)
  assert.match(text, /addEventListener\('push'/)
  assert.match(text, /showNotification/)
  assert.doesNotMatch(text, /\\$\{/)
})

function waitFor(test, timeoutMs = 2000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      let answer = false
      try {
        answer = test()
      } catch {
        answer = false
      }
      if (answer) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error('timed out'))
      setTimeout(tick, 5)
    }
    tick()
  })
}
