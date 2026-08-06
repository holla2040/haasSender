import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GROUPS, VERIFIED, UNAVAILABLE } from '../src/keys.js'

const ids = new Set(
  Object.values(GROUPS).flatMap(g => g.rows.flat()).map(k => k.id).filter(Boolean)
)

// A key claimed by an id that is not on the panel is invisible: no tint, no fade,
// no message, and nothing to notice. Typos here fail silently in the browser.
test('every key claimed by name really exists on the keyboard', () => {
  for (const id of VERIFIED) assert.ok(ids.has(id), `VERIFIED names a key not on the panel: ${id}`)
  for (const id of UNAVAILABLE.keys()) assert.ok(ids.has(id), `UNAVAILABLE names a key not on the panel: ${id}`)
})

// The two claims are opposites; a key that made both would draw as tinted and
// faded at once and tell a student two contradictory things.
test('no key is both working and impossible', () => {
  for (const id of UNAVAILABLE.keys()) {
    assert.ok(!VERIFIED.has(id), `${id} is tinted as working and faded as impossible`)
  }
})
