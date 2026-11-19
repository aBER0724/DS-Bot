// A remote DSH Web (DS_BOT_REMOTE): the window shows that machine's team, this machine starts no
// Host and picks no place, and the tray's 「远程 DSH Web…」 keeps another address for the next
// start. The Electron parts are test doubles: no display, no DSH, no data of the user.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { before, test } from 'node:test'
import { paths, state } from './helpers/fake-electron.mjs'
import { state as hostState } from './helpers/fake-host-process.mjs'
import { startApp, trayMenu, waitFor, window } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

const address = 'http://127.0.0.1:3080/?token=secret'
const kept = () => JSON.parse(readFileSync(join(paths.userData, 'remote.json'), 'utf8'))
// The address window is the app's own page on a data URL; the team and start windows load http.
const addressWindow = () => state.windows.filter(win => String(win.url ?? '').startsWith('data:text/html')).at(-1)

process.env.DS_BOT_REMOTE = address

await installHooks()

before(async () => { await startApp() })

test('the window opens the remote DSH Web on its launch address, and no Host runs here', async () => {
  await waitFor(() => window() !== undefined, 'build the team window')
  const win = window()
  await waitFor(() => win.loaded.length > 0, 'reach the remote DSH Web')
  assert.equal(win.loaded[0], address, 'the first page carries the launch token')
  assert.equal(hostState.starts, 0, 'the remote machine runs the Host, not this one')
  // The page belongs to the remote origin, which every IPC check of the app passes on.
  assert.ok(win.options.webPreferences.additionalArguments.includes('--ds-bot-origin=http://127.0.0.1:3080'))
})

test('Settings is told where the data is, and that nothing moves it from here', () => {
  const win = window()
  win.webContents.mainFrame.url = win.url
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame }
  assert.deepEqual(state.ipc.get('ds-bot:data-location')(event), { path: 'http://127.0.0.1:3080', fixed: true })
  assert.equal(state.ipc.get('ds-bot:move-data')(event, undefined), false, 'no data of this machine to move')
})

test('the tray takes another address: a typo stays in the window, a good one starts the app again', async () => {
  await waitFor(() => state.tray !== undefined, 'build the tray')
  const entry = trayMenu().find(row => row.label === 'Remote DSH Web…')
  assert.ok(entry !== undefined, 'the tray offers the address')
  const before = state.windows.length
  entry.click()
  await waitFor(() => state.windows.length > before, 'open the address window')
  const page = addressWindow()
  assert.ok(page !== undefined)
  // What the page's own field sends, once per click of 〔连接〕.
  const send = text => Promise.resolve(state.ipc.get('ds-bot:remote-address')({ sender: page.webContents }, text))

  assert.deepEqual(await send('dsh.example.com'), { error: 'address' })
  assert.equal(state.relaunches.length, 0, 'a typo starts nothing again')
  assert.equal(state.quits, 0)

  assert.deepEqual(await send('https://dsh.example.com/?token=fresh'), { ok: true })
  await waitFor(() => state.relaunches.length === 1, 'start the app again on the new address')
  assert.deepEqual(kept(), { url: 'https://dsh.example.com/?token=fresh' })
  assert.ok(state.quits >= 1, 'the old app leaves before the new one starts')
})
