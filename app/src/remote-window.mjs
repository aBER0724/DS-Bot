// The window that takes the address of a remote DSH Web: one field, Connect and Cancel
// (the tray's 「远程 DSH Web…」). The address is checked here, so a typo keeps the window open
// with the reason instead of leaving the app on an address that does not answer.
// docs/plans/2026-11-17-desktop-remote.md.
const SAVE = 'ds-bot:remote-address'
const CANCEL = 'ds-bot:remote-address-cancel'

/**
 * @param {{
 *   BrowserWindow: new (options: object) => object,
 *   ipcMain: { handle: (channel: string, listener: (event: { sender: object }, text: string) => unknown) => void, on: (channel: string, listener: (event: { sender: object }) => void) => void },
 *   preload: string,
 *   labels: () => { remoteTitle: string, remoteHint: string, remoteConnect: string, remoteUseLocal: string, cancel: string },
 *   log?: Pick<Console, 'error' | 'warn'>,
 * }} options the injected Electron surface and the app's own copy
 * @returns {{ ask: (options: { value?: string, check: (text: string) => { url?: string, error?: string }, parent?: object, dark?: boolean }) => Promise<string | undefined> }}
 *   `ask` answers with the address to keep, with `''` for 「改用本机」, and with undefined when the
 *   window is cancelled or closed
 */
export function createRemoteAddressWindow({ BrowserWindow, ipcMain, preload, labels, log = console }) {
  let win
  // The window that waits for the typed address, and what its answer goes to.
  let asking
  const close = () => {
    const target = win
    win = undefined
    if (target !== undefined && !target.isDestroyed()) target.destroy()
  }
  const settle = (answer) => {
    if (asking === undefined) return
    const { resolve } = asking
    asking = undefined
    resolve(answer)
  }
  // One listener for the window's whole life: a listener per ask would take the answer twice.
  ipcMain.handle(SAVE, (event, text) => {
    if (event?.sender !== win?.webContents || asking === undefined) return { error: '' }
    const answer = asking.check(String(text ?? ''))
    if (answer.error !== undefined) return { error: answer.error }
    const { resolve } = asking
    asking = undefined
    setImmediate(() => { close() })
    resolve(answer.url)
    return { ok: true }
  })
  ipcMain.on(CANCEL, (event) => {
    if (event?.sender !== win?.webContents || asking === undefined) return
    const { resolve } = asking
    asking = undefined
    close()
    resolve(undefined)
  })
  return {
    ask({ value = '', check, parent, dark = false }) {
      return new Promise((resolve) => {
        // One window only: a second ask brings the open one to the front.
        if (win !== undefined) { win.show(); win.focus(); resolve(undefined); return }
        asking = { resolve, check }
        const text = labels()
        win = new BrowserWindow({
          width: 520,
          height: 236,
          useContentSize: true,
          resizable: false,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          show: false,
          title: text.remoteTitle,
          backgroundColor: dark ? '#1c1c1e' : '#f7f7f8',
          ...(parent === undefined ? {} : { parent, modal: true }),
          webPreferences: { sandbox: true, preload, contextIsolation: true },
        })
        const page = win
        page.once('closed', () => {
          if (win === page) win = undefined
          settle(undefined)
        })
        page.once('ready-to-show', () => { if (!page.isDestroyed()) page.show() })
        page.loadURL(addressPage(text, { value, dark })).catch((error) => {
          log.error('DS Bot: the address window did not load:', error)
          close()
          settle(undefined)
        })
      })
    },
  }
}

/** The page's copy: a data URL, so that nothing of it is read from the disk. */
function addressPage(labels, { value, dark }) {
  // Both strings go in as JSON, with their tags escaped: a pasted address cannot end the script.
  const json = (text) => JSON.stringify(text).replaceAll('<', '\\u003c')
  const initial = json(value)
  const errors = json({ address: labels.remoteBadAddress, scheme: labels.remoteBadScheme })
  const theme = dark ? 'dark' : 'light'
  const style = `
    :root { color-scheme: ${theme}; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 18px 20px; font: 13px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: ${dark ? '#1c1c1e' : '#f7f7f8'}; color: ${dark ? '#f2f2f7' : '#1c1c1e'}; user-select: none; }
    h1 { margin: 0 0 6px; font-size: 15px; font-weight: 600; }
    p { margin: 0 0 10px; color: ${dark ? '#a1a1a8' : '#6b6b70'}; }
    input { width: 100%; padding: 8px 10px; font: inherit; color: inherit; border-radius: 8px;
      border: 1px solid ${dark ? '#3a3a3e' : '#d6d6db'}; background: ${dark ? '#2c2c2e' : '#ffffff'}; }
    input:focus { outline: 2px solid ${dark ? '#5b8cff' : '#2f6bff'}; outline-offset: -1px; }
    .error { min-height: 16px; margin: 6px 0 0; color: ${dark ? '#ff8a80' : '#c0362c'}; }
    .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 2px; }
    button { font: inherit; padding: 6px 14px; border-radius: 8px; cursor: pointer;
      border: 1px solid ${dark ? '#3a3a3e' : '#d6d6db'}; background: ${dark ? '#2c2c2e' : '#ffffff'}; color: inherit; }
    button.primary { border-color: transparent; background: ${dark ? '#0a84ff' : '#0b63ff'}; color: #ffffff; }
    button.quiet { border-color: transparent; background: transparent; color: ${dark ? '#8e8e93' : '#6b6b70'}; }
    button:disabled { opacity: 0.5; cursor: default; }
  `
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>${escapeHtml(labels.remoteTitle)}</title><style>${style}</style></head>
<body>
<h1>${escapeHtml(labels.remoteTitle)}</h1>
<p>${escapeHtml(labels.remoteHint)}</p>
<input id="address" type="text" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="https://dsh.example.com/?token=…">
<p class="error" id="error" role="alert"></p>
<div class="row">
  <button class="quiet" id="cancel" type="button">${escapeHtml(labels.cancel)}</button>
  <button class="quiet" id="local" type="button">${escapeHtml(labels.remoteUseLocal)}</button>
  <button class="primary" id="connect" type="button">${escapeHtml(labels.remoteConnect)}</button>
</div>
<script>
  const bridge = window.dsBotRemote
  const field = document.getElementById('address')
  const error = document.getElementById('error')
  const connect = document.getElementById('connect')
  const busy = (on) => { connect.disabled = on; field.disabled = on }
  field.value = ${initial}
  // What the main process says is wrong with an address, in the app's own words.
  const wrong = ${errors}
  field.focus()
  field.select()
  const submit = async (text) => {
    busy(true)
    error.textContent = ''
    try {
      const answer = await bridge.save(text)
      if (answer && answer.error) { error.textContent = wrong[answer.error] ?? ''; busy(false); field.focus() }
    } catch (e) {
      error.textContent = String(e && e.message ? e.message : e)
      busy(false)
    }
  }
  connect.addEventListener('click', () => { void submit(field.value) })
  document.getElementById('local').addEventListener('click', () => { void submit('') })
  document.getElementById('cancel').addEventListener('click', () => { bridge.cancel() })
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); void submit(field.value) }
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); bridge.cancel() }
  })
</script>
</body></html>`)}`
}

const escapeHtml = (text) => String(text ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
