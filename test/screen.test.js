import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fmt, displayScale, MM_PER_IN, clock, HELP, HELP_SECTIONS, PANE_ROWS, paneFrom } from '../src/ui/screen.js'
import { wireLine, HAAS_COLLISIONS } from '../src/grbl.js'

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

test('cycle time reads as a control clock, and rolls over properly', () => {
  assert.equal(clock(0), '00:00:00')
  assert.equal(clock(null), '00:00:00')
  assert.equal(clock(999), '00:00:00')      // truncate, never round a second up
  assert.equal(clock(61_000), '00:01:01')
  assert.equal(clock(3_599_000), '00:59:59')
  assert.equal(clock(3_661_000), '01:01:01')
})

// The g-code list is only worth having if every line of it is true, and the two
// ways it can quietly stop being true are a link pasted from somewhere else and
// a code listed twice with two different descriptions. Every host below was
// fetched and its anchors read off the page; a new host appearing here means
// someone added a reference nobody checked.
const REFERENCE_HOSTS = ['linuxcnc.org', 'github.com']

test('every HELP reference points at a host whose anchors were verified', () => {
  for (const [label, , url] of HELP) {
    if (!url) continue
    const u = new URL(url)                        // throws on a malformed link
    assert.equal(u.protocol, 'https:', `${label} link is not https`)
    assert.ok(REFERENCE_HOSTS.includes(u.hostname), `${label} links to ${u.hostname}`)
    // A code has to land on its own section. Dropping a student on the top of
    // a 60-code page and leaving them to scroll is not a reference.
    if (/^[GM]\d/.test(label)) assert.ok(u.hash, `${label} links to a page, not a section`)
  }
})

test('no g-code or m-code is listed twice, and every line fits the pane', () => {
  const codes = HELP.map(([label]) => label).filter(l => /^[GM]\d/.test(l))
  assert.equal(new Set(codes).size, codes.length, 'a code is listed twice')
  assert.ok(codes.length > 60, 'the code list lost most of its entries')

  for (const [label, text] of HELP) {
    assert.ok(label.length <= 14, `label "${label}" runs into the text column`)
    // Entities are one glyph on screen however many characters they are here.
    assert.ok(label.padEnd(14).length + text.replace(/&#\d+;/g, 'x').length <= 70,
      `"${label}" line is wider than the pane`)
  }
})

// The drift this guards against is the one a student pays for: HELP said M50 was
// feed override control, the block ran, and an override they never touched went
// off. HELP and the wire read the same table now, and this proves it stays that
// way for codes added later too — not just the ones known to collide today.
test('every code HELP says this machine RUNS survives the wire', () => {
  const runs = HELP.slice(HELP_SECTIONS[1], HELP_SECTIONS[3])
  const codes = runs.flatMap(([label]) => label.split(/\s+/)).filter(c => /^[GM][\d.]+$/.test(c))
  assert.ok(codes.length > 40, 'the runnable code list lost most of its entries')
  for (const code of codes) {
    assert.doesNotThrow(() => wireLine(code, {}),
      `HELP lists ${code} as runnable, but the wire refuses it`)
  }
})

test('every colliding code is on the refused list, and named there', () => {
  const refused = HELP.slice(HELP_SECTIONS[3]).map(([label]) => label)
  for (const [label] of HAAS_COLLISIONS) {
    assert.ok(refused.includes(label), `${label} collides but HELP never says so`)
  }
})

test('the section jumps land on section starts, in order', () => {
  assert.equal(HELP_SECTIONS[0], 0)
  assert.deepEqual(HELP_SECTIONS, [...HELP_SECTIONS].sort((a, b) => a - b))
  for (const i of HELP_SECTIONS) assert.match(HELP[i][1], /^── /)
})

// The bug: PARAMETER showed 8 rows and PAGE DOWN stepped 12, so four settings
// scrolled by between screens and were never on one. A page step may be no
// larger than the window it turns.
test('paging a pane shows every row on the way past', () => {
  for (const rows of [PANE_ROWS, PANE_ROWS - 1]) {
    const total = 40
    const seen = new Set()
    for (let row = 0; ; row = Math.min(total - 1, row + rows)) {
      const from = paneFrom(row, total, rows)
      for (let i = 0; i < rows; i++) seen.add(from + i)
      if (row === total - 1) break
    }
    assert.equal(seen.size, total, `a ${rows}-row pane skipped a row paging by ${rows}`)
  }
})
