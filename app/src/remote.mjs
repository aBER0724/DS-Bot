// The DSH Web that the app shows instead of its own Host. The address comes from DS_BOT_REMOTE or
// from the one the user filled in at the tray's 「远程 DSH Web…」; either way it carries the launch
// token the remote `dsh web` printed, and the app keeps no data folder and starts no Host of its
// own then. The design and its limits are in docs/plans/2026-11-17-desktop-remote.md.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Whether a remote DSH Web was asked for at all, without reading the address. */
export const remoteWanted = (value = process.env.DS_BOT_REMOTE) => String(value ?? '').trim() !== ''

/**
 * @param {string | undefined} value the address of the remote DSH Web, DS_BOT_REMOTE by default
 * @returns {{ url: string, root: string, origin: string } | undefined} the page to load with its
 *   launch token, the plain address the later windows load, and the origin the page belongs to
 * @throws {Error & { code: 'address' | 'scheme' }} when the address is not an http(s) URL, so that
 *   the start and the address window say what is wrong instead of opening the app's own Host. The
 *   message is for the log; `code` picks the sentence the window shows.
 */
export function remoteOf(value = process.env.DS_BOT_REMOTE) {
  const text = String(value ?? '').trim()
  if (text === '') return undefined
  let url
  try {
    url = new URL(text)
  } catch (error) {
    throw Object.assign(new Error(`The remote address is not an address: ${text}`, { cause: error }), { code: 'address' })
  }
  // DSH Web speaks http and https; another scheme is a typo, not a fallback.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw Object.assign(new Error(`The remote address must start with http:// or https://: ${text}`), { code: 'scheme' })
  const launch = url.toString()
  // The launch token in this address is good for one load: it becomes the Host's cookie, and the
  // later windows use the plain address. A mount under a path keeps that path.
  url.search = ''
  url.hash = ''
  return { url: launch, root: url.toString(), origin: url.origin }
}

/** The address the user filled in, or undefined when the app shows its own Host. */
export function readRemote(file) {
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    return typeof saved?.url === 'string' ? saved.url : undefined
  } catch {
    return undefined
  }
}

/** Keeps `url` for the next start; no address means the app's own Host again. False when unwritten. */
export function saveRemote(file, url) {
  const text = String(url ?? '').trim()
  try {
    if (text === '') {
      rmSync(file, { force: true })
      return true
    }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(`${file}.tmp`, `${JSON.stringify({ url: text })}\n`)
    renameSync(`${file}.tmp`, file)
    return true
  } catch (error) {
    console.error('DS Bot: the remote address was not saved:', error)
    return false
  }
}
