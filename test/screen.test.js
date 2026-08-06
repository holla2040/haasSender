import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fmt, displayScale, MM_PER_IN } from '../src/ui/screen.js'

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

// The bug this exists to stop: grbl reports position in the unit `$13` names and
// G20/G21 does not change that, so an inch display of a millimetre report has to
// convert. Verified on the ClearCore — `G20` is accepted and the next `MPos:`
// still arrives in millimetres.
test('an inch display of a millimetre report converts rather than reformats', () => {
  assert.equal(displayScale('MM', 'MM'), 1)
  assert.equal(displayScale('IN', 'IN'), 1)
  assert.equal(displayScale('MM', 'IN'), 1 / MM_PER_IN)
  assert.equal(displayScale('IN', 'MM'), MM_PER_IN)

  // 20 mm is 0.7874", not 20.0000".
  assert.equal(fmt(20 * displayScale('MM', 'IN'), true, false), '0.7874')
  assert.equal(fmt(1 * displayScale('IN', 'MM'), false, false), '25.400')
})
