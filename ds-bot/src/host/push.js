// Web Push for the browser: a Bot that answered, a card waiting, or a group that called
// the user reaches the phone or the installed PWA even while the page is closed.
//
// Everything a push needs is per device and per team: the team holds one VAPID key pair
// (`push.json`, 0600, beside the roster) and one record per subscribed device — its push
// endpoint, the browser's public key and auth secret, and that device's switches. The
// notice stream the mobile API already emits is the source: `pushNotice` is called with
// each one and decides, for each device, whether it is worth waking a phone for.
//
// The body of a notification never carries a message: a lock screen shows it, so it names
// the conversation and the kind of thing that happened, and nothing else.
import { createHash } from 'node:crypto'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { replaceFile } from './files.js'
import { SERVICE_WORKER } from './push-sw.js'
import { encryptPush, isB64url, newVapidKeys, vapidAuthorization } from './push-crypto.js'
import { mentionSpans } from '../shared/mentions.js'

const FILE = 'push.json'
// The browser asks for this file at the origin root; its scope is the whole page.
export const SW_PATH = '/sw.js'
const MAX_DEVICES = 32
// A device that reported looking at a conversation this recently is not pushed for it.
const PRESENCE_MS = 90_000
const SEND_TIMEOUT_MS = 10_000
// A push service keeps a message this long while the device is away.
const TTL_SECONDS = 12 * 60 * 60
// A Bot writing "@user" or "@you" is calling the user.
const USER_MENTIONS = [{ name: 'user' }, { name: 'you' }]

/**
 * What a notice is worth pushing, or undefined for one that is not.
 * @param {{ kind?: string, text?: string }} notice
 * @returns {'reply' | 'question' | 'mention' | undefined}
 */
export function pushKindOf(notice) {
  switch (notice?.kind) {
    // A card the user has to answer, and an approval waiting on them.
    case 'question':
    case 'approval':
      return 'question'
    // A Bot's own chat: it answered.
    case 'message':
      return 'reply'
    // A group says nothing for an ordinary reply; only calling the user is worth a push.
    case 'group':
      return mentionSpans(notice.text ?? '', USER_MENTIONS).length > 0 ? 'mention' : undefined
    default:
      return undefined
  }
}

/**
 * Whether this device should be woken for a notice.
 * @param {{ enabled?: boolean, muted?: string[], presence?: { sessionId?: string, visible?: boolean, focused?: boolean, at?: number } }} device
 * @param {{ kind?: string, sessionId?: string, roomId?: string }} notice
 * @param {'reply' | 'question' | 'mention'} kind
 * @param {number} now
 * @returns {boolean}
 */
export function wantsPush(device, notice, kind, now = Date.now()) {
  if (device?.enabled === false) return false
  const place = notice.sessionId ?? notice.roomId
  if (place !== undefined && (device.muted ?? []).includes(place)) return false
  const presence = device.presence
  if (presence?.visible === true && presence.focused === true && place !== undefined
    && presence.sessionId === place && now - (presence.at ?? 0) < PRESENCE_MS) return false
  return kind !== undefined
}

/**
 * The notification a service worker shows for a notice. No message text: this reaches a
 * lock screen.
 * @param {{ kind?: string, name?: string, title?: string, sessionId?: string, roomId?: string }} notice
 * @param {'reply' | 'question' | 'mention'} kind
 * @returns {{ title: string, kind: string, sessionId?: string, roomId?: string }}
 */
export function payloadOf(notice, kind) {
  return {
    title: String(notice.title ?? notice.name ?? 'DS Bot'),
    kind,
    ...(notice.sessionId === undefined ? {} : { sessionId: notice.sessionId }),
    ...(notice.roomId === undefined ? {} : { roomId: notice.roomId }),
  }
}

const deviceKey = endpoint => createHash('sha256').update(String(endpoint)).digest('hex').slice(0, 16)

/** A subscription as the browser hands it over, or undefined when it is not one. */
function subscriptionOf(value) {
  const endpoint = typeof value?.endpoint === 'string' ? value.endpoint.trim() : ''
  if (!/^https:\/\//i.test(endpoint) || endpoint.length > 2048) return undefined
  const p256dh = value?.keys?.p256dh
  const auth = value?.keys?.auth
  if (!isB64url(p256dh, 65) || !isB64url(auth, 16)) return undefined
  return { endpoint, p256dh, auth }
}

export function install(rt) {
  const { ctx } = rt
  const file = join(rt.home, FILE)
  let loaded
  const load = async () => {
    if (loaded !== undefined) return loaded
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'))
      loaded = {
        version: 1,
        vapid: parsed?.vapid?.privateKey ? parsed.vapid : undefined,
        devices: Array.isArray(parsed?.devices) ? parsed.devices.filter(device => subscriptionOf(device) !== undefined) : [],
      }
    } catch {
      loaded = { version: 1, vapid: undefined, devices: [] }
    }
    // The key pair is the team's; losing it would silently unsubscribe every device.
    if (loaded.vapid === undefined) {
      loaded.vapid = newVapidKeys()
      await save()
    }
    return loaded
  }
  let writing = Promise.resolve()
  const save = () => {
    const snapshot = JSON.stringify({ version: 1, vapid: loaded.vapid, devices: loaded.devices }, null, 2)
    writing = writing.then(async () => {
      const temp = `${file}.${String(process.pid)}.tmp`
      await writeFile(temp, `${snapshot}\n`, { encoding: 'utf8', mode: 0o600 })
      await chmod(temp, 0o600).catch(() => {})
      await replaceFile(temp, file)
    }).catch(error => rt.warn?.('ds-bot: push subscriptions were not saved: %s', error))
    return writing
  }

  const state = async () => {
    const data = await load()
    return data
  }

  const ok = value => ({ ok: true, value })
  const fail = message => ({ ok: false, error: { message } })

  // The browser's half asks for the key, hands over its subscription, and reports what it
  // is looking at so a phone that is already showing a conversation is not woken for it.
  async function pushEndpoint(endpoint, body) {
    const data = await state()
    switch (endpoint) {
      case 'push-state':
        return ok({ publicKey: data.vapid.publicKey, devices: data.devices.length })
      case 'push-subscribe': {
        const subscription = subscriptionOf(body?.subscription)
        if (subscription === undefined) return fail('That is not a push subscription.')
        const now = Date.now()
        const existing = data.devices.find(device => device.endpoint === subscription.endpoint)
        const record = {
          id: existing?.id ?? deviceKey(subscription.endpoint),
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          createdAt: existing?.createdAt ?? now,
          lastSeen: now,
          enabled: body?.enabled !== false,
          muted: Array.isArray(body?.muted) ? body.muted.filter(item => typeof item === 'string').slice(0, 200) : (existing?.muted ?? []),
          ...(typeof body?.label === 'string' ? { label: body.label.slice(0, 80) } : {}),
          presence: existing?.presence,
        }
        data.devices = [record, ...data.devices.filter(device => device.endpoint !== subscription.endpoint)]
        if (data.devices.length > MAX_DEVICES) data.devices = data.devices.slice(0, MAX_DEVICES)
        await save()
        return ok({ id: record.id, publicKey: data.vapid.publicKey })
      }
      case 'push-unsubscribe': {
        const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : ''
        const before = data.devices.length
        data.devices = data.devices.filter(device => device.endpoint !== endpoint)
        if (data.devices.length !== before) await save()
        return ok({ removed: before !== data.devices.length })
      }
      case 'push-prefs': {
        const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : ''
        const device = data.devices.find(item => item.endpoint === endpoint)
        if (device === undefined) return ok({ known: false })
        if (typeof body.enabled === 'boolean') device.enabled = body.enabled
        if (Array.isArray(body.muted)) device.muted = body.muted.filter(item => typeof item === 'string').slice(0, 200)
        device.lastSeen = Date.now()
        await save()
        return ok({ known: true })
      }
      case 'push-presence': {
        const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : ''
        const device = data.devices.find(item => item.endpoint === endpoint)
        if (device === undefined) return ok({ known: false })
        device.presence = {
          sessionId: typeof body?.sessionId === 'string' ? body.sessionId : undefined,
          visible: body?.visible === true,
          focused: body?.focused === true,
          at: Date.now(),
        }
        // Presence is read by the next push, not by anyone else: no save for every blink.
        return ok({ known: true })
      }
      default:
        return undefined
    }
  }

  // One notification to one device. A push service that answers 404 or 410 has dropped the
  // subscription for good, so the record goes with it.
  async function send(device, payload) {
    const data = await load()
    const body = encryptPush({
      plaintext: JSON.stringify(payload),
      uaPublic: device.keys.p256dh,
      auth: device.keys.auth,
    })
    try {
      const response = await fetch(device.endpoint, {
        method: 'POST',
        headers: {
          'content-encoding': 'aes128gcm',
          'content-type': 'application/octet-stream',
          ttl: String(TTL_SECONDS),
          urgency: payload.kind === 'question' ? 'high' : 'normal',
          authorization: vapidAuthorization({ endpoint: device.endpoint, privateKey: data.vapid.privateKey }),
        },
        body,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      })
      if (response.status === 404 || response.status === 410) {
        data.devices = data.devices.filter(item => item.endpoint !== device.endpoint)
        await save()
        return false
      }
      if (!response.ok) {
        rt.warn?.('ds-bot: push to %s answered %d', device.label ?? device.id, response.status)
        return false
      }
      return true
    } catch (error) {
      rt.warn?.('ds-bot: push to %s failed: %s', device.label ?? device.id, error?.message ?? error)
      return false
    }
  }

  // Every notice the mobile API emits passes here; a device is woken only for what its own
  // switches and its last report allow.
  const pushNotice = (notice) => {
    const kind = pushKindOf(notice)
    if (kind === undefined) return
    void (async () => {
      const data = await state()
      const now = Date.now()
      const payload = payloadOf(notice, kind)
      // A copy: a push service that dropped one device takes it out of the list.
      for (const device of data.devices.slice()) {
        if (!wantsPush(device, notice, kind, now)) continue
        await send(device, payload)
      }
    })().catch(error => rt.warn?.('ds-bot: push failed: %s', error))
  }

  // The service worker itself. It cannot live on the API channel: a worker's scope has to
  // cover the page, so it is served from the origin root by the web server instead.
  ctx.effect(() => {
    const webServer = ctx.get?.('webServer')
    if (typeof webServer?.register !== 'function') return undefined
    const dispose = webServer.register({
      kind: 'exact',
      path: SW_PATH,
      handler: (request, response) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405, { allow: 'GET, HEAD' })
          response.end()
          return
        }
        response.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          // A worker is fetched on every start; an old copy must not outlive the plugin.
          'cache-control': 'no-cache',
        })
        response.end(request.method === 'HEAD' ? undefined : SERVICE_WORKER)
      },
    })
    return () => { dispose() }
  }, 'ds-bot: push service worker')

  Object.assign(rt, { pushNotice, pushEndpoint, pushPublicKey: async () => (await state()).vapid.publicKey })
}

export { FILE as PUSH_FILE, MAX_DEVICES, PRESENCE_MS, deviceKey }
