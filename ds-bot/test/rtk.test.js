import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { assetNames, checksumOf, installRtk, managedBinary, tagOf } from '../src/host/rtk/install.js'
import { quoteBinary, RTK_COMMANDS, wrapCommand } from '../src/host/rtk/wrap.js'

const dir = () => mkdtempSync(join(tmpdir(), 'ds-bot-rtk-test-'))

test('a simple command of a tool rtk filters is routed', () => {
  assert.equal(wrapCommand('git status', 'rtk'), 'rtk git status')
  assert.equal(wrapCommand('cargo build --release', 'rtk'), 'rtk cargo build --release')
  assert.equal(wrapCommand('  npm test  ', 'rtk'), 'rtk npm test  ')
  assert.equal(wrapCommand('ls', '/opt/homebrew/bin/rtk'), '/opt/homebrew/bin/rtk ls')
})

test('anything the shell would read as more than one command passes through', () => {
  for (const command of [
    'git status | head',
    'git log && git status',
    'npm test; echo done',
    'cargo build > out.txt',
    'git log $(pwd)',
    'git status &',
    'echo `date`',
    'FOO=1 git status',
    '(git status)',
    'git status\nls',
  ]) {
    assert.equal(wrapCommand(command, 'rtk'), command, command)
  }
})

test('a command rtk has no filter for, or an empty one, passes through', () => {
  for (const command of ['echo hi', './git status', 'rtk git status', 'GIT status', '']) {
    assert.equal(wrapCommand(command, 'rtk'), command, command)
  }
  assert.equal(wrapCommand('   ', 'rtk'), '   ')
})

test('without a binary nothing is routed', () => {
  assert.equal(wrapCommand('git status', undefined), 'git status')
  assert.equal(wrapCommand('git status', ''), 'git status')
})

test('a binary path with spaces is quoted for the shell', () => {
  assert.equal(quoteBinary('rtk'), 'rtk')
  assert.equal(quoteBinary('/usr/local/bin/rtk'), '/usr/local/bin/rtk')
  assert.equal(quoteBinary('/Applications/My Tools/rtk'), '"/Applications/My Tools/rtk"')
  assert.equal(quoteBinary('C:\\Users\\name\\.dsh\\bot\\tools\\rtk\\v1.2.1\\rtk.exe'), 'C:\\Users\\name\\.dsh\\bot\\tools\\rtk\\v1.2.1\\rtk.exe')
  assert.equal(wrapCommand('git log', '/Applications/My Tools/rtk'), '"/Applications/My Tools/rtk" git log')
})

test('every routed name is one rtk knows', () => {
  for (const name of RTK_COMMANDS) assert.equal(wrapCommand(`${name} --version`, 'rtk'), `rtk ${name} --version`)
})

test('the release asset is the Apache-2.0 build for this platform', () => {
  assert.deepEqual(assetNames('linux', 'x64'), ['rtk-oss-x86_64-unknown-linux-musl.tar.gz'])
  assert.deepEqual(assetNames('linux', 'arm64'), ['rtk-oss-aarch64-unknown-linux-musl.tar.gz', 'rtk-oss-aarch64-unknown-linux-gnu.tar.gz'])
  assert.deepEqual(assetNames('darwin', 'arm64'), ['rtk-oss-aarch64-apple-darwin.tar.gz'])
  assert.deepEqual(assetNames('win32', 'x64'), ['rtk-oss-x86_64-pc-windows-msvc.zip'])
  assert.deepEqual(assetNames('sunos', 'x64'), [])
})

test('the checksum line for the asset is read, and only that line', () => {
  const digest = 'b'.repeat(64)
  const text = `${'a'.repeat(64)}  rtk-oss-x86_64-apple-darwin.tar.gz\n${digest}  rtk-oss-aarch64-apple-darwin.tar.gz\n`
  assert.equal(checksumOf(text, 'rtk-oss-aarch64-apple-darwin.tar.gz'), digest)
  assert.equal(checksumOf(text, 'rtk-oss-x86_64-pc-windows-msvc.zip'), undefined)
  assert.equal(checksumOf('not a digest  rtk-oss-aarch64-apple-darwin.tar.gz', 'rtk-oss-aarch64-apple-darwin.tar.gz'), undefined)
  assert.equal(checksumOf(undefined, 'rtk-oss-aarch64-apple-darwin.tar.gz'), undefined)
})

test('the tag is read from a release redirect', () => {
  assert.equal(tagOf('https://github.com/rtk-ai/rtk/releases/tag/v1.2.1'), 'v1.2.1')
  assert.equal(tagOf('https://github.com/rtk-ai/rtk/releases/tag/v0.51.0\n'), 'v0.51.0')
  assert.equal(tagOf('https://github.com/rtk-ai/rtk/releases/latest'), undefined)
  assert.equal(tagOf(undefined), undefined)
})

test('the newest installed version is the one used', () => {
  const tools = dir()
  assert.equal(managedBinary(tools), undefined)
  for (const version of ['v1.2.1', 'v1.10.0', 'v1.9.9']) {
    mkdirSync(join(tools, version), { recursive: true })
    writeFileSync(join(tools, version, process.platform === 'win32' ? 'rtk.exe' : 'rtk'), '')
  }
  assert.equal(managedBinary(tools), join(tools, 'v1.10.0', process.platform === 'win32' ? 'rtk.exe' : 'rtk'))
})

test('a download that fails installs nothing and says so', async () => {
  const tools = dir()
  const said = []
  const failing = async url => ({ ok: false, status: 404, url: String(url), headers: new Headers() })
  assert.equal(await installRtk({ dir: tools, fetchImpl: failing, log: message => said.push(message), version: 'v1.2.1' }), undefined)
  assert.equal(said.length, 1)
  assert.match(said[0], /rtk was not installed/)
  assert.equal(managedBinary(tools), undefined)
})

test('an archive that does not match its checksum is not unpacked', async () => {
  const tools = dir()
  const said = []
  const asset = assetNames(process.platform, process.arch)[0]
  if (asset === undefined) return
  const fetchImpl = async url => ({
    ok: true,
    status: 200,
    url: String(url),
    headers: new Headers(),
    arrayBuffer: async () => Buffer.from(String(url).endsWith('checksums.txt') ? `${'c'.repeat(64)}  ${asset}\n` : 'not the archive'),
  })
  assert.equal(await installRtk({ dir: tools, fetchImpl, log: message => said.push(message), version: 'v1.2.1' }), undefined)
  assert.match(said.join('\n'), /did not match its checksum/)
  assert.equal(managedBinary(tools), undefined)
})
