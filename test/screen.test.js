import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fmt } from '../src/ui/screen.js'

// The staleness rule, at the only place it can silently regress. A readout that
// keeps showing its last value after the link drops is the same lie as a
// disconnected control reading 0.000 — the number must go away, not freeze.
test('a readout blanks when the link is stale and prints normally otherwise', () => {
  assert.equal(fmt(111.47, false, true), '—')
  assert.equal(fmt(0, false, true), '—')          // zero especially: it looks live
  assert.equal(fmt(111.47, false, false), '111.470')
  assert.equal(fmt(1.2345, true, false), '1.2345')
  assert.equal(fmt(undefined, false, false), '0.000')
})
