// Web Push from the page's side: the browser subscribes, the host wakes it up.
//
// A page that is closed cannot decide anything, so the subscription, the switches and what
// this window is looking at all live on the host (`src/host/push.js`). This module registers
// the service worker, asks the browser for permission once the user turns notifications on,
// and keeps the host told: which devices exist, which conversations are muted, and which
// conversation this window is showing right now.
//
// Where a browser cannot do it — no service workers, no HTTPS — nothing here is called, and
// the page falls back to the notification API it already has.
import { call } from './api.js'

const ENDPOINT_KEY = 'ds-bot:push-endpoint'
// How often the window tells the host what it is looking at.
const PRESENCE_MS = 5_000

const supported = () => typeof navigator !== 'undefined'
  && 'serviceWorker' in navigator
  && typeof window !== 'undefined'
  && window.isSecureContext === true

let endpointMemory
let lastPresence = 0

/** The endpoint this browser subscribed with, or undefined when it has none. */
export function pushEndpoint() {
  if (endpointMemory !== undefined) return endpointMemory
  try {
    endpointMemory = window.localStorage.getItem(ENDPOINT_KEY) ?? null
  } catch {
    endpointMemory = null
  }
  return endpointMemory ?? undefined
}

/** Whether this browser is subscribed, so the page leaves the speaking to the push. */
export const pushOn = () => pushEndpoint() !== undefined

/** Whether this browser can subscribe at all. */
export const canPush = supported

const remember = (endpoint) => {
  endpointMemory = endpoint ?? null
  try {
    if (endpoint === undefined) window.localStorage.removeItem(ENDPOINT_KEY)
    else window.localStorage.setItem(ENDPOINT_KEY, endpoint)
  } catch { /* storage unavailable */ }
}

// A VAPID key travels as base64url; the browser wants the bytes.
function keyBytes(text) {
  const base64 = String(text ?? '').replaceAll('-', '+').replaceAll('_', '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const raw = window.atob(padded)
  return Uint8Array.from(raw, character => character.codePointAt(0))
}

async function registration() {
  if (!supported()) return undefined
  try {
    const existing = await navigator.serviceWorker.getRegistration()
    return existing ?? await navigator.serviceWorker.register('sw.js', { scope: './' })
  } catch {
    return undefined
  }
}

/**
 * Ask for the browser's permission, subscribe, and hand the subscription to the host.
 * Called from the notifications switch, so the permission request is inside a gesture.
 * @param {{ muted?: string[], label?: string }} options
 * @returns {Promise<'on' | 'denied' | 'unavailable'>}
 */
export async function enablePush({ muted = [], label } = {}) {
  if (!supported()) return 'unavailable'
  let permission = Notification.permission
  if (permission === 'default') {
    try {
      permission = await Notification.requestPermission()
    } catch {
      permission = 'denied'
    }
  }
  if (permission !== 'granted') return 'denied'
  const worker = await registration()
  if (worker === undefined) return 'unavailable'
  try {
    const state = await call('push-state')
    const current = await worker.pushManager.getSubscription()
    const subscription = current ?? await worker.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(state.publicKey),
    })
    const json = subscription.toJSON()
    await call('push-subscribe', {
      subscription: { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } },
      enabled: true,
      muted,
      ...(label === undefined ? {} : { label }),
    })
    remember(json.endpoint)
    return 'on'
  } catch {
    return 'unavailable'
  }
}

/** Stop this browser's subscription, here and on the host. */
export async function disablePush() {
  const endpoint = pushEndpoint()
  try {
    const worker = await navigator.serviceWorker?.getRegistration()
    const subscription = await worker?.pushManager?.getSubscription()
    await subscription?.unsubscribe()
  } catch { /* already gone */ }
  remember(undefined)
  if (endpoint !== undefined) await call('push-unsubscribe', { endpoint }).catch(() => undefined)
}

/** Tell the host this device's switches, so a push honours them while the page is closed. */
export async function syncPushPrefs({ enabled, muted }) {
  const endpoint = pushEndpoint()
  if (endpoint === undefined) return
  await call('push-prefs', { endpoint, enabled, muted: Object.keys(muted ?? {}).filter(id => muted[id] === true) }).catch(() => undefined)
}

/**
 * Say what this window is looking at. The host uses it to skip a push for a conversation
 * the user already has on screen.
 * @param {{ sessionId?: string, visible?: boolean, focused?: boolean, now?: boolean }} view
 */
export function reportPresence({ sessionId, visible, focused, now = false }) {
  const endpoint = pushEndpoint()
  if (endpoint === undefined) return
  const at = Date.now()
  if (!now && at - lastPresence < PRESENCE_MS) return
  lastPresence = at
  void call('push-presence', {
    endpoint,
    sessionId: sessionId ?? undefined,
    visible: visible === true,
    focused: focused === true,
  }).catch(() => undefined)
}


/**
 * Keep the subscription fresh across a reload: a browser that still holds a subscription
 * renews it with the host (a new VAPID key means a new subscription).
 * @param {{ muted?: Record<string, boolean>, label?: string }} prefs
 * @returns {Promise<boolean>} whether this browser is subscribed now
 */
export async function resumePush({ muted = {}, label } = {}) {
  if (!supported()) return false
  const endpoint = pushEndpoint()
  if (endpoint === undefined) return false
  const worker = await navigator.serviceWorker?.getRegistration()
  const subscription = await worker?.pushManager?.getSubscription().catch(() => undefined)
  if (subscription === undefined || subscription === null) {
    remember(undefined)
    return false
  }
  const json = subscription.toJSON()
  if (json.endpoint !== endpoint) {
    // The browser replaced it: hand the new one over before anything else uses the old.
    remember(json.endpoint)
  }
  await call('push-subscribe', {
    subscription: { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } },
    enabled: true,
    muted: Object.keys(muted).filter(id => muted[id] === true),
    ...(label === undefined ? {} : { label }),
  }).catch(() => undefined)
  return true
}

// A push service that rotates the endpoint asks the page to subscribe again.
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'ds-bot:resubscribe') remember(undefined)
  })
}
