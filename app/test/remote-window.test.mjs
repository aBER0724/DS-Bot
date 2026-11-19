// The window that takes the address of a remote DSH Web: the page it loads and what it answers
// with. The Electron parts are stubs: no display, no Electron.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRemoteAddressWindow } from '../src/remote-window.mjs'

const labels = () => ({
  remoteTitle: 'Remote DSH Web',
  remoteHint: 'The address the remote dsh web printed, launch token and all.',
  remoteConnect: 'Connect',
  remoteUseLocal: 'Use this computer',
  remoteBadAddress: 'That is not an address: paste the line dsh web printed.',
  remoteBadScheme: 'The address has to start with http:// or https://.',
  cancel: 'Cancel',
})

// One window as the module sees it, with what it asked for and the page it loaded.
function harness() {
  const ipc = new Map()
  const asked = { url: undefined, options: undefined, shown: 0 }
  const windows = []
  class Window {
    constructor(options) {
      asked.options = options
      this.webContents = { id: `page ${String(windows.length + 1)}` }
      this.handlers = new Map()
      this.destroyed = false
      windows.push(this)
    }
    once(event, run) { this.handlers.set(event, run) }
    async loadURL(url) { asked.url = url }
    show() { asked.shown += 1 }
    focus() {}
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true }
  }
  const win = createRemoteAddressWindow({
    BrowserWindow: Window,
    ipcMain: { handle: (channel, run) => { ipc.set(channel, run) }, on: (channel, run) => { ipc.set(channel, run) } },
    preload: '/preload.cjs',
    labels,
  })
  // What the page's own buttons and keys send (remote-preload.cjs).
  const send = (text, page = windows.at(-1)) => ipc.get('ds-bot:remote-address')({ sender: page.webContents }, text)
  const cancel = (page = windows.at(-1)) => ipc.get('ds-bot:remote-address-cancel')({ sender: page.webContents })
  const html = () => decodeURIComponent(asked.url.slice(asked.url.indexOf(',') + 1))
  return { win, asked, windows, send, cancel, html }
}

const check = (text) => (text === 'no' ? { error: 'address' } : { url: text })

test('the page shows the address it was given, as text and not as markup', () => {
  const h = harness()
  void h.win.ask({ value: 'https://dsh.example.com/?token=1&x="<script>"', check })
  assert.match(h.asked.url, /^data:text\/html;charset=utf-8,/u)
  const html = h.html()
  // The field's first value travels as a JSON string with its tags escaped: a pasted address
  // cannot end the page's own script.
  assert.ok(html.includes('\\u003cscript>'), 'the tags of the address stay text')
  assert.ok(!html.includes('"<script>"'), 'no markup from the address')
  assert.ok(html.includes('Remote DSH Web'), 'the window\'s own copy')
  assert.ok(html.includes('Use this computer'))
  assert.ok(html.includes('window.dsBotRemote'), 'the page talks to the preload, not to Node')
  assert.equal(h.asked.options.webPreferences.sandbox, true)
  assert.equal(h.asked.options.webPreferences.preload, '/preload.cjs')
  assert.equal(h.asked.options.parent, undefined, 'no parent when the app has none on screen')
  // What a rejected address says, in the app's own words: the main process sends a code.
  assert.ok(html.includes('That is not an address: paste the line dsh web printed.'))
  assert.ok(html.includes('The address has to start with http:// or https://.'))
})

test('a rejected address keeps the window open and says what is wrong', async () => {
  const h = harness()
  const answered = h.win.ask({ value: 'no', check })
  assert.deepEqual(await h.send('no'), { error: 'address' })
  assert.equal(h.asked.shown, 0, 'nothing is on screen yet')
  assert.equal(h.windows.at(-1).destroyed, false, 'the window stays for the next try')
  h.cancel()
  assert.equal(await answered, undefined)
  assert.equal(h.windows.at(-1).destroyed, true)
})

test('a good address answers with it and closes the window', async () => {
  const h = harness()
  const answered = h.win.ask({ value: 'no', check })
  assert.deepEqual(await h.send('https://dsh.example.com/'), { ok: true })
  assert.equal(await answered, 'https://dsh.example.com/')
  // The window goes on the next task, so that its own answer reaches the page first.
  assert.equal(h.windows.at(-1).destroyed, false)
  await new Promise((resolve) => { setImmediate(resolve) })
  assert.equal(h.windows.at(-1).destroyed, true)
})

test('another window cannot answer for it, and one window is asked at a time', async () => {
  const h = harness()
  const answered = h.win.ask({ check })
  assert.deepEqual(await h.send('https://x.test/', { webContents: { id: 'a page of another window' } }), { error: '' })
  // A second ask brings the open window forward instead of a second field.
  assert.equal(await h.win.ask({ check }), undefined)
  assert.equal(h.windows.length, 1)
  assert.equal(h.asked.shown, 1)
  h.cancel()
  assert.equal(await answered, undefined)
})

test('a window the user closes is a cancelled one', async () => {
  const h = harness()
  const answered = h.win.ask({ check })
  h.windows.at(-1).handlers.get('closed')()
  assert.equal(await answered, undefined)
})

test('a page that does not load answers nothing instead of waiting forever', async () => {
  const ipc = new Map()
  const windows = []
  class Window {
    constructor() {
      this.webContents = { id: 'page' }
      this.handlers = new Map()
      this.destroyed = false
      windows.push(this)
    }
    once(event, run) { this.handlers.set(event, run) }
    async loadURL() { throw new Error('the page did not load') }
    show() {}
    isDestroyed() { return this.destroyed }
    destroy() { this.destroyed = true }
  }
  const win = createRemoteAddressWindow({
    BrowserWindow: Window,
    ipcMain: { handle: (channel, run) => { ipc.set(channel, run) }, on: (channel, run) => { ipc.set(channel, run) } },
    preload: '/preload.cjs',
    labels,
    log: { error: () => {} },
  })
  assert.equal(await win.ask({ check }), undefined)
  assert.equal(windows[0].destroyed, true)
})
