import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fmt, displayScale, MM_PER_IN, clock, remain, HELP, HELP_SECTIONS, PANE_ROWS, PROGRAM_ROWS, paneFrom, lineNumber } from '../src/ui/screen.js'
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

// REMAIN is an estimate, and the thing an estimate must never do is dress a
// guess it does not have as 00:00:00 — a machine that says zero minutes left is
// making a claim about the job.
test('REMAIN counts the estimate down, and shows nothing when there is none', () => {
  assert.equal(remain({ cycleMs: 0 }), '—')                             // no cycle running
  assert.equal(remain({ job: { dnc: true }, cycleMs: 0 }), '—')         // running off the card
  assert.equal(remain({ job: { estMs: 61_000 }, cycleMs: 0 }), '00:01:01')
  assert.equal(remain({ job: { estMs: 61_000 }, cycleMs: 60_000 }), '00:00:01')
  // Past the estimate it holds at zero: the job is slower than Setting 1001 says.
  assert.equal(remain({ job: { estMs: 61_000 }, cycleMs: 90_000 }), '00:00:00')
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
  for (const rows of [PANE_ROWS, PANE_ROWS - 1, PROGRAM_ROWS]) {
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

// The PROGRAM listing used a fixed four-rows-above offset and never clamped at
// the tail, so END on a long program showed the last line with fifteen blanks
// under it. A window at the end must still be a full window.
test('the last page of a listing is a full page, not a stub', () => {
  const total = 300
  assert.equal(paneFrom(total - 1, total, PROGRAM_ROWS), total - PROGRAM_ROWS)
  assert.equal(paneFrom(0, total, PROGRAM_ROWS), 0)
  // A program shorter than the pane has nowhere to scroll to.
  assert.equal(paneFrom(2, 3, PROGRAM_ROWS), 0)
})

// Setting 1000 puts a number beside every line the PROGRAM pane draws, and the
// one way it can be wrong is the cheap way: numbering the WINDOW instead of the
// FILE. Scrolled to the middle of a program that would read 1..16 forever,
// renaming every block on screen each time the window moved. This walks the
// window the way the pane does and holds the number to the line it belongs to.
test('program line numbers count the file, not the window', () => {
  const total = 400
  const lines = Array.from({ length: total }, (_, i) => `N${i + 1} G1 X${i}`)

  for (const cur of [0, 1, 8, 47, 200, total - 2, total - 1]) {
    const from = paneFrom(cur, total, PROGRAM_ROWS)
    const slice = lines.slice(from, from + PROGRAM_ROWS)
    assert.equal(slice.length, PROGRAM_ROWS, `cur ${cur}: a short page means a blank tail`)

    slice.forEach((text, i) => {
      // The number the pane would draw must name the line drawn beside it.
      const shown = lineNumber(from, i, total)
      assert.equal(text, `N${Number(shown)} G1 X${Number(shown) - 1}`)
      // Width is the program's, not the page's, so the column never shifts.
      assert.equal(shown.length, 3, `cur ${cur}: column width moved`)
    })
  }

  assert.equal(lineNumber(0, 0, 400), '  1')
  assert.equal(lineNumber(0, 8, 400), '  9')
  assert.equal(lineNumber(384, 15, 400), '400')
  // A one-page program does not pad to a width it never reaches.
  assert.equal(lineNumber(0, 0, 9), '1')
})
