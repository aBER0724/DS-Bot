// The always-on half of billion-context's compaction gate: it provides the service the agent
// presets wait on before they resolve, and it stands DSH's own compaction down at load time
// while billion-context owns compression. Kept as its own entry, as billion-context ships it:
// turning the compression plugin off must leave this one running, or the presets never start.
export { apply, inject, name } from 'billion-context/dsh-compaction-gate'
