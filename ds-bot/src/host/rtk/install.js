// Keeping one rtk binary for the whole team. rtk prints a compact form of a command's output
// (see wrap.js); nothing here is needed for a machine that already has `rtk` on PATH.
//
// The binary is the Apache-2.0 edition (`rtk-oss-*`): the default download adds a BUSL-1.1
// engine, which DS Bot has no use for and cannot ship. Downloads are pinned by version and
// checked against the release's own checksums.txt before anything is unpacked, and the
// unpacked archive must carry exactly one file, `rtk`. Every failure is silent: without a
// binary the wrapper is the identity, so a machine with no network keeps working.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const RELEASES = 'https://github.com/rtk-ai/rtk/releases'
const DOWNLOAD_TIMEOUT_MS = 90_000
const BINARY = process.platform === 'win32' ? 'rtk.exe' : 'rtk'

// The release asset per platform and architecture. Linux ships musl builds, which run on
// every distribution; aarch64 also has a gnu build as a fallback.
const TARGETS = {
  linux: { x64: ['x86_64-unknown-linux-musl'], arm64: ['aarch64-unknown-linux-musl', 'aarch64-unknown-linux-gnu'] },
  darwin: { x64: ['x86_64-apple-darwin'], arm64: ['aarch64-apple-darwin'] },
  win32: { x64: ['x86_64-pc-windows-msvc'], arm64: ['x86_64-pc-windows-msvc'] },
}

/**
 * The release asset for a platform and architecture, tried in order.
 * @param {string} platform - process.platform
 * @param {string} arch - process.arch
 * @returns {string[]} asset names, most preferred first
 */
export function assetNames(platform, arch) {
  const targets = TARGETS[platform]?.[arch] ?? []
  const extension = platform === 'win32' ? 'zip' : 'tar.gz'
  return targets.map(target => `rtk-oss-${target}.${extension}`)
}

/**
 * The sha256 a checksums.txt line records for an asset, as rtk publishes it
 * (`<hex>  <asset>`).
 * @param {string} text - checksums.txt contents
 * @param {string} asset - asset name
 * @returns {string | undefined} the hex digest, lowercased
 */
export function checksumOf(text, asset) {
  for (const line of String(text ?? '').split('\n')) {
    const [digest, name] = line.trim().split(/\s+/)
    if (name === asset && /^[a-f0-9]{64}$/i.test(digest ?? '')) return digest.toLowerCase()
  }
  return undefined
}

/**
 * The release tag a `/releases/latest` redirect names.
 * @param {string} location - the Location header, or a release page URL
 * @returns {string | undefined} a tag such as `v1.2.1`
 */
export function tagOf(location) {
  const match = /\/tag\/([A-Za-z0-9._+-]+)\s*$/.exec(String(location ?? '').trim())
  return match?.[1]
}

const versionOrder = (a, b) => {
  const parts = value => value.replace(/^v/, '').split(/[.-]/).map(part => (/^\d+$/.test(part) ? Number(part) : part))
  const left = parts(a)
  const right = parts(b)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const one = left[index] ?? 0
    const other = right[index] ?? 0
    if (one === other) continue
    if (typeof one === 'number' && typeof other === 'number') return other - one
    return String(other).localeCompare(String(one))
  }
  return 0
}

/**
 * The newest installed rtk under `dir`, whatever version installed it.
 * @param {string} dir - the tools folder
 * @returns {string | undefined} the binary's path, when one is installed and runs
 */
export function managedBinary(dir) {
  let versions
  try {
    versions = readdirSync(dir)
  } catch {
    // Nothing installed yet, or a folder this process may not read.
    return undefined
  }
  for (const version of versions.sort(versionOrder)) {
    const binary = join(dir, version, BINARY)
    if (existsSync(binary)) return binary
  }
  return undefined
}

/**
 * Download and unpack rtk under `dir`, once.
 * @param {{dir: string, fetchImpl?: typeof fetch, log?: (message: string) => void, version?: string}} options
 * @returns {Promise<string | undefined>} the installed binary, or undefined on any failure
 */
export async function installRtk({ dir, fetchImpl = fetch, log = () => {}, version }) {
  const assets = assetNames(process.platform, process.arch)
  if (assets.length === 0) return undefined
  const tag = version?.trim() || await latestTag(fetchImpl)
  if (tag === undefined) return undefined
  const existing = join(dir, tag, BINARY)
  if (existsSync(existing)) return existing
  let work
  try {
    const checksums = await download(fetchImpl, `${RELEASES}/download/${tag}/checksums.txt`)
    const asset = assets.find(name => checksumOf(checksums.toString('utf8'), name) !== undefined)
    if (asset === undefined) {
      log(`ds-bot: rtk ${tag} has no build for ${process.platform} ${process.arch}`)
      return undefined
    }
    const archive = await download(fetchImpl, `${RELEASES}/download/${tag}/${asset}`)
    const expected = checksumOf(checksums.toString('utf8'), asset)
    if (createHash('sha256').update(archive).digest('hex') !== expected) {
      log(`ds-bot: rtk ${tag} did not match its checksum; not installed`)
      return undefined
    }
    work = await mkdtemp(join(tmpdir(), 'ds-bot-rtk-'))
    const file = join(work, asset)
    await writeFile(file, archive)
    await unpack(file, work)
    const binary = join(work, BINARY)
    if (!existsSync(binary)) throw new Error(`no ${BINARY} in ${asset}`)
    // The unpacked binary usually sits on another filesystem than the team's data folder
    // (/tmp in a container, the data volume beside it), so it is copied into the target
    // folder first and renamed there: the rename stays atomic and never crosses devices.
    await mkdir(join(dir, tag), { recursive: true })
    const staging = `${existing}.${String(process.pid)}.tmp`
    await copyFile(binary, staging)
    await chmod(staging, 0o755)
    await rename(staging, existing)
    return existing
  } catch (error) {
    log(`ds-bot: rtk was not installed: ${error.message ?? error}`)
    return undefined
  } finally {
    if (work !== undefined) await rm(work, { recursive: true, force: true })
  }
}

async function latestTag(fetchImpl) {
  const response = await fetchImpl(`${RELEASES}/latest`, { redirect: 'manual', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  const tag = tagOf(response.headers.get('location'))
  if (tag !== undefined) return tag
  const page = await fetchImpl(`${RELEASES}/latest`, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  return tagOf(page.url)
}

async function download(fetchImpl, url) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`${url} answered ${String(response.status)}`)
  return Buffer.from(await response.arrayBuffer())
}

// The archive is unpacked by the system tar, which reads both tar.gz and the zip the Windows
// build ships. Entries are listed first so an absolute path or a `..` component is refused
// before anything is written.
async function unpack(file, into) {
  const listed = await run('tar', ['-tf', file], { maxBuffer: 16 * 1024 * 1024 })
  for (const entry of listed.stdout.split('\n').filter(Boolean)) {
    if (entry.startsWith('/') || /(^|[/\\])\.\.([/\\]|$)/.test(entry)) throw new Error(`unsafe path in archive: ${entry}`)
  }
  await run('tar', ['-xf', file, '-C', into], { maxBuffer: 16 * 1024 * 1024 })
}

export { RELEASES }
