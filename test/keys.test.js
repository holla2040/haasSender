import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GROUPS, VERIFIED, UNAVAILABLE, keyForChar } from '../src/keys.js'

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

// Typing on a real keyboard has to land on the same panel keys a finger would
// press — `$` especially, which is SHIFT+5 and the only way to reach `$X`.
test('a typed character maps to the panel key that types it', () => {
  assert.deepEqual(keyForChar('g'), { id: 'alpha-g', shift: false })
  assert.deepEqual(keyForChar('G'), { id: 'alpha-g', shift: false })
  assert.deepEqual(keyForChar('5'), { id: 'num-5', shift: false })
  assert.deepEqual(keyForChar('.'), { id: 'dot', shift: false })
  assert.deepEqual(keyForChar('-'), { id: 'minus', shift: false })
  assert.deepEqual(keyForChar(' '), { id: 'space', shift: false })
  assert.deepEqual(keyForChar('$'), { id: 'num-5', shift: true })
  assert.deepEqual(keyForChar('/'), { id: 'semicolon', shift: true })
  assert.equal(keyForChar('ArrowLeft'), null)      // the cursor keys keep theirs
  assert.equal(keyForChar('~'), null)
  // Every key it names is really on the panel, and every character it can return
  // is one the input bar accepts.
  for (const ch of [...'ABCXYZ0189.-; ()$%&@:!*\'?=#+/[]']) {
    const k = keyForChar(ch)
    assert.ok(k && ids.has(k.id), `no panel key types ${ch}`)
  }
})
