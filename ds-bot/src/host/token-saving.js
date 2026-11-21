// Whether billion-context (mounted by cordis.patch.yml) owns compression in this process.
// It compresses a Session's model traffic itself and declares that on the process, because
// the compaction gate and the compression plugin are separate entries with no shared module
// state. A DSH checkpoint would shadow the raw history it compresses from, so while this is
// true DS Bot writes none: the context steward only moves to a fresh part, and its one-off
// requests are not declared as compactions, which billion-context refuses. The key is
// billion-context's own (src/agent/dsh-compaction-disable.ts, #3662).
const BILI_VERDICT = '__BILI_DSH_COMPACTION_VERDICT__'

export const biliOwnsCompression = () => globalThis[BILI_VERDICT] === 'active'
