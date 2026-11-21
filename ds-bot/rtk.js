// Shell output through rtk (https://github.com/rtk-ai/rtk) for every command this profile
// runs. The seam is the executor's `resolve`, where a call's source is fixed before
// anything runs: only the command text is rewritten, so workdir, timeout, environment,
// exit code, background jobs and sandbox confinement stay the executor's own. A command
// rtk has no filter for, and every command on a machine without rtk, runs unchanged
// (src/host/rtk/wrap.js).
//
// DS Bot installs the Apache-2.0 edition of rtk itself when it can
// (src/host/rtk/install.js); a machine with `rtk` on PATH is left alone, and DS_BOT_RTK=0
// or `config.enabled: false` turns the whole thing off.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { dshHomeOf } from './src/host/folders.js'
import { installRtk, managedBinary } from './src/host/rtk/install.js'
import { wrapCommand } from './src/host/rtk/wrap.js'

export const name = 'ds-bot-rtk'
export const inject = ['shell']

// A binary that appears on PATH after boot (the user installs it) is picked up within this
// long, so a probe never runs on every command.
const PATH_CHECK_MS = 60_000

const onPath = () => {
  try {
    return spawnSync('rtk', ['--version'], { stdio: 'ignore', timeout: 5_000 }).status === 0
  } catch {
    return false
  }
}

export function apply(ctx, config = {}) {
  if (config.enabled === false || process.env.DS_BOT_RTK === '0') return
  const shell = ctx.shell
  if (typeof shell?.resolve !== 'function') return
  const warn = message => ctx.logger?.warn?.('%s', message)
  const dir = config.dir ?? join(dshHomeOf(process.env.DSH_HOME), 'bot', 'tools', 'rtk')
  let binary = managedBinary(dir)
  let checkedAt = 0

  const current = () => {
    if (binary !== undefined && (binary === 'rtk' || existsSync(binary))) return binary
    binary = undefined
    const now = Date.now()
    if (now - checkedAt < PATH_CHECK_MS) return undefined
    checkedAt = now
    if (onPath()) binary = 'rtk'
    return binary
  }

  if (config.install !== false && binary === undefined && !onPath()) {
    void installRtk({ dir, log: warn, version: config.version })
      .then(installed => {
        if (installed === undefined) return
        binary = installed
        checkedAt = 0
      })
      .catch(error => warn(`ds-bot: rtk was not installed: ${error.message ?? error}`))
  }

  const resolve = shell.resolve
  const resolveWithRtk = function resolveWithRtk(request) {
    const spec = resolve.call(this, request)
    const source = spec?.command
    if (typeof source !== 'string') return spec
    const rtk = current()
    if (rtk === undefined) return spec
    const command = wrapCommand(source, rtk)
    return command === source ? spec : { ...spec, command }
  }
  shell.resolve = resolveWithRtk
  ctx.effect(() => () => {
    if (shell.resolve === resolveWithRtk) shell.resolve = resolve
  })
}
