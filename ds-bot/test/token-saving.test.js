import assert from 'node:assert/strict'
import { test } from 'node:test'
import { biliOwnsCompression } from '../src/host/token-saving.js'

const KEY = '__BILI_DSH_COMPACTION_VERDICT__'

test('compression belongs to billion-context only while it says so', (t) => {
  t.after(() => { delete globalThis[KEY] })
  delete globalThis[KEY]
  assert.equal(biliOwnsCompression(), false)
  globalThis[KEY] = 'active'
  assert.equal(biliOwnsCompression(), true)
  for (const other of ['', 'idle', 'ACTIVE', undefined]) {
    globalThis[KEY] = other
    assert.equal(biliOwnsCompression(), false, String(other))
  }
})
