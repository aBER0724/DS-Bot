// The address of a remote DSH Web: what DS_BOT_REMOTE and the field of 「远程 DSH Web…」 mean,
// and where the address is kept between starts. No Electron, no Host.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readRemote, remoteOf, remoteWanted, saveRemote } from '../src/remote.mjs'

const file = () => join(mkdtempSync(join(tmpdir(), 'ds-bot-remote-')), 'remote.json')

test('an empty address is the app\'s own Host', () => {
  assert.equal(remoteOf(undefined), undefined)
  assert.equal(remoteOf(''), undefined)
  assert.equal(remoteOf('   '), undefined)
  assert.equal(remoteWanted('  '), false)
  assert.equal(remoteWanted('http://127.0.0.1:3080/'), true)
})

test('the launch address is used once and the plain address is the way back', () => {
  assert.deepEqual(remoteOf('http://127.0.0.1:3080/?token=secret'), {
    url: 'http://127.0.0.1:3080/?token=secret',
    root: 'http://127.0.0.1:3080/',
    origin: 'http://127.0.0.1:3080',
  })
  // An address that is mounted under a path keeps it; only the token and the fragment go.
  assert.deepEqual(remoteOf('https://dsh.example.com/team/?token=secret#top'), {
    url: 'https://dsh.example.com/team/?token=secret#top',
    root: 'https://dsh.example.com/team/',
    origin: 'https://dsh.example.com',
  })
  // An address without a token is the same page twice: no separate launch address.
  assert.deepEqual(remoteOf('http://127.0.0.1:3080'), {
    url: 'http://127.0.0.1:3080/',
    root: 'http://127.0.0.1:3080/',
    origin: 'http://127.0.0.1:3080',
  })
})

test('an address that is not http(s) says so instead of opening something else', () => {
  // The message is for the log; `code` picks the sentence the address window shows.
  assert.throws(() => remoteOf('dsh.example.com'), { message: /not an address/u, code: 'address' })
  assert.throws(() => remoteOf('file:///tmp/dsh'), { message: /must start with http:\/\/ or https:\/\//u, code: 'scheme' })
  assert.throws(() => remoteOf('ftp://dsh.example.com/'), { message: /must start with http:\/\/ or https:\/\//u, code: 'scheme' })
})

test('a kept address is read back, and no address is the app\'s own Host again', () => {
  const path = file()
  assert.equal(readRemote(path), undefined, 'a file that is not there asks nothing')
  assert.equal(saveRemote(path, 'http://127.0.0.1:3080/?token=secret'), true)
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { url: 'http://127.0.0.1:3080/?token=secret' })
  assert.equal(readRemote(path), 'http://127.0.0.1:3080/?token=secret')
  // 「改用本机」 takes the file away, so that nothing stale decides a later start.
  assert.equal(saveRemote(path, '  '), true)
  assert.equal(existsSync(path), false)
  assert.equal(readRemote(path), undefined)
})

test('a kept address that cannot be read is no address', () => {
  const path = file()
  writeFileSync(path, 'not json')
  assert.equal(readRemote(path), undefined)
  writeFileSync(path, JSON.stringify({ url: 42 }))
  assert.equal(readRemote(path), undefined)
})

test('the address is kept in a folder that is not there yet', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ds-bot-remote-')), 'deeper', 'remote.json')
  assert.equal(saveRemote(path, 'https://dsh.example.com/?token=secret'), true)
  assert.equal(readRemote(path), 'https://dsh.example.com/?token=secret')
})
