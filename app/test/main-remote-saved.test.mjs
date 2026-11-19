// The address that 「远程 DSH Web…」 kept: a later start shows that machine's team without
// DS_BOT_REMOTE, and 「改用本机」 takes the address away again. The Electron parts are test
// doubles: no display, no DSH, no data of the user.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { before, test } from 'node:test'
import { paths, state } from './helpers/fake-electron.mjs'
import { state as hostState } from './helpers/fake-host-process.mjs'
import { startApp, trayMenu, waitFor, window } from './helpers/app-harness.mjs'
import { installHooks } from './helpers/register.mjs'

const address = 'https://dsh.example.com/?token=saved'
const file = join(paths.userData, 'remote.json')

mkdirSync(paths.userData, { recursive: true })
writeFileSync(file, JSON.stringify({ url: address }))

await installHooks()

before(async () => { await startApp() })

test('a kept address is the one the next start opens, with no Host on this machine', async () => {
  await waitFor(() => window() !== undefined, 'build the team window')
  const win = window()
  await waitFor(() => win.loaded.length > 0, 'reach the remote DSH Web')
  assert.equal(win.loaded[0], address)
  assert.equal(hostState.starts, 0, 'the remote machine runs the Host, not this one')
})

test('「改用本机」 takes the address away and the app starts on its own Host again', async () => {
  await waitFor(() => state.tray !== undefined, 'build the tray')
  const count = state.windows.length
  trayMenu().find(row => row.label === 'Remote DSH Web…').click()
  await waitFor(() => state.windows.length > count, 'open the address window')
  const page = state.windows.at(-1)
  // The page's 〔改用本机〕 sends an empty address.
  assert.deepEqual(state.ipc.get('ds-bot:remote-address')({ sender: page.webContents }, ''), { ok: true })
  await waitFor(() => state.relaunches.length === 1, 'start the app again')
  assert.equal(existsSync(file), false, 'nothing decides the next start but the app\'s own Host')
  assert.ok(state.quits >= 1, 'the old app leaves before the new one starts')
})
