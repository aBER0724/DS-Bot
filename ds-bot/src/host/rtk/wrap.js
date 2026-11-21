// Routing a shell command through rtk (https://github.com/rtk-ai/rtk), which prints a
// compact form of the same command's output. The decision is pure: whether the command may
// be routed, and the exact source to run instead. Everything else about the call (workdir,
// timeout, environment, exit code, confinement) belongs to the executor and stays as it is.
//
// Wrapping is a best-effort saving, never a change of meaning, so three guards run in order:
// a command that is more than one simple command is left alone (a pipeline, a list, a
// redirection or a substitution would be re-read differently under rtk); only the tools rtk
// has a filter for are routed; and without a binary the source is returned unchanged.

// rtk takes one command and its arguments, so anything the shell would read as more than
// that disqualifies the command.
const SHELL_SYNTAX = /[|&;<>()`$\n]/
// `FOO=bar cmd` and a leading subshell are not a bare command name.
const LEADING_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

// The tools rtk ships a filter for (src/cmds in rtk); its subcommand is the tool's own name.
// A name rtk does not know would fail the command itself, so nothing else is routed.
const RTK_COMMANDS = new Set([
  'aws', 'cargo', 'curl', 'docker', 'dotnet', 'find', 'gh', 'git', 'glab', 'go', 'golangci-lint',
  'grep', 'jest', 'kubectl', 'ls', 'mvn', 'mypy', 'next', 'npm', 'npx', 'php', 'phpunit', 'pip',
  'playwright', 'pnpm', 'prisma', 'psql', 'pytest', 'rake', 'rg', 'rspec', 'rubocop', 'ruff',
  'terraform', 'tree', 'tsc', 'uv', 'vitest', 'wget',
])

// A path the shell reads as one word: letters, digits, and the separators both bash and
// PowerShell accept unquoted (`\` for a Windows path, which bash never sees here).
const SAFE_BINARY = /^[A-Za-z0-9_./:@%+\\-]+$/

/**
 * The executable name a shell command starts with, exactly as written: a name rtk does not
 * know in that spelling is not routed, so no command is rewritten into a different one.
 * @param {string} command - the shell source
 * @returns {string | undefined} the first token, or undefined when it is not a plain command
 */
function commandName(command) {
  const source = command.trimStart()
  if (source.length === 0 || source.startsWith('(')) return undefined
  const end = source.search(/\s/)
  return end === -1 ? source : source.slice(0, end)
}

/**
 * The binary as the shell should read it: bare when it needs no quoting, double-quoted
 * otherwise, which both bash and PowerShell accept.
 * @param {string} binary - absolute path or the name on PATH
 * @returns {string} the text to put in front of the command
 */
export function quoteBinary(binary) {
  return SAFE_BINARY.test(binary) ? binary : `"${binary.replaceAll('"', '\\"')}"`
}

/**
 * Route a command through rtk when it is one simple command of a tool rtk filters.
 * @param {string} command - the shell source the model asked to run
 * @param {string} [binary] - rtk's path or name; absent when no rtk is available
 * @returns {string} the source to run, the same text when it is not routed
 */
export function wrapCommand(command, binary) {
  if (typeof command !== 'string' || typeof binary !== 'string' || binary.length === 0) return command
  if (SHELL_SYNTAX.test(command)) return command
  const name = commandName(command)
  if (name === undefined || LEADING_ASSIGNMENT.test(name)) return command
  if (!RTK_COMMANDS.has(name)) return command
  // The rest of the source already carries its own spacing; only the name is replaced.
  const rest = command.trimStart().slice(name.length)
  return `${quoteBinary(binary)} ${name}${rest}`
}

export { RTK_COMMANDS }
