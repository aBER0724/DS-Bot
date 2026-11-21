// The service worker DS Bot serves at /sw.js. A page that is closed has no window to show
// anything from, so this file is where a push becomes a notification: the host sends only
// the conversation's name and what kind of thing happened, never a message.
//
// It is kept as source text rather than a built file: the host hands these bytes to the
// browser as they are, and nothing else in the plugin needs them.
export const SERVICE_WORKER = String.raw`// DS Bot's service worker: shows a push, and opens the conversation it names.
self.addEventListener('install', () => { void self.skipWaiting() })
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()) })

const SENTENCES = {
  reply: { zh: '回复了你', en: 'answered you' },
  question: { zh: '有一个问题在等你', en: 'is waiting for your answer' },
  mention: { zh: '在群里 @ 了你', en: 'called you in a group' },
  test: { zh: '通知已经打开', en: 'notifications are on' },
}

const language = (navigator.language || 'en').toLowerCase().startsWith('zh') ? 'zh' : 'en'

function sentenceFor(kind) {
  const entry = SENTENCES[kind]
  return entry === undefined ? '' : entry[language] ?? entry.en
}


self.addEventListener('push', (event) => {
  let payload = {}
  try { payload = event.data?.json() ?? {} } catch { payload = {} }
  const kind = typeof payload.kind === 'string' ? payload.kind : 'reply'
  const title = typeof payload.title === 'string' && payload.title !== '' ? payload.title : 'DS Bot'
  const body = sentenceFor(kind)
  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag: 'ds-bot-' + (payload.sessionId ?? payload.roomId ?? kind),
    renotify: true,
    data: payload,
    icon: new URL('apple-touch-icon.png', self.registration.scope).href,
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  // The conversation itself is opened by the page: the notification only brings it forward.
  const target = self.registration.scope
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of windows) {
      if (client.url.startsWith(self.registration.scope)) {
        await client.focus()
        if ('navigate' in client) await client.navigate(target)
        return
      }
    }
    await self.clients.openWindow(target)
  })())
})

// The push service handed out a new endpoint: keep the subscription alive by asking the
// page for one. Without a page awake a subscription cannot be renewed, which is why the
// page subscribes again on its next start.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of windows) client.postMessage({ type: 'ds-bot:resubscribe' })
  })())
})
`
