// billion-context (https://github.com/ranxianglei/billion-context, MIT) mounted as DS Bot's
// own entry: the profile loads plugins by the name its patch file gives, and this package is
// the one every profile already has. The plugin itself is unchanged; see
// docs/plans/2026-11-20-token-saving.md for why it is on by default and what that changes.
export { apply, inject, name } from 'billion-context'
