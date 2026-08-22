import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VirtualGrbl, toolPath } from '../src/sim.js'
import { Streamer, parseStatus, prepare, HAAS_COLLISIONS } from '../src/grbl.js'

/**
 * A simulator wired to collect its output, with timers left off so tests drive it.
 * `write` and `run` drain the outbox the way the real interval loop does.
 */
function bench (opts) {
  const out = []
  const m = new VirtualGrbl(opts)
  m.onLine(l => out.push(l))
  return {
    m,
    out,
    write: (s) => { m.write(s); m.drain() },
    run: (secs, step = 0.02) => {
      for (let t = 0; t < secs; t += step) { m.tick(step); m.drain() }
    }
  }
}

test('acknowledges each line and moves at the programmed feedrate', () => {
  const { m, out, write, run } = bench()
  write('G21 G90\nG1 X60 F600\n')             // 600 mm/min == 10 mm/s
  assert.equal(out.filter(l => l === 'ok').length, 2)

  run(3)
  assert.ok(Math.abs(m.mpos[0] - 30) < 0.5, `expected ~30 mm after 3 s, got ${m.mpos[0]}`)
  assert.equal(m.state, 'Run')

  run(4)
  assert.ok(Math.abs(m.mpos[0] - 60) < 1e-6, `expected to land on 60, got ${m.mpos[0]}`)
  assert.equal(m.state, 'Idle')
})

test('G91 is relative and G20 converts inches to millimetres', () => {
  const { m, write, run } = bench()
  write('G91 G20\nG1 X1 F600\n')              // one inch
  run(10)
  assert.ok(Math.abs(m.mpos[0] - 25.4) < 1e-6, `got ${m.mpos[0]}`)
})

test('status report parses back with our own parser and tracks state', () => {
  const { m, write, run } = bench()
  write('G1 X10 F600\n')
  run(0.5)

  const s = parseStatus(m.statusReport())
  assert.equal(s.state, 'Run')
  assert.equal(s.MPos.length, 4)
  assert.ok(s.MPos[0] > 0 && s.MPos[0] < 10)
  assert.ok(s.bf.blocks <= 100)
  assert.equal(s.feed, 600)
})

test('feed hold stops motion and cycle start resumes it', () => {
  const { m, write, run } = bench()
  write('G1 X100 F600\n')
  run(1)
  const parked = m.mpos[0]

  m.realtime(0x21)                             // !
  assert.equal(m.state, 'Hold')
  run(2)
  assert.equal(m.mpos[0], parked, 'must not move while held')

  m.realtime(0x7E)                             // ~
  assert.equal(m.state, 'Run')
  run(1)
  assert.ok(m.mpos[0] > parked)
})

test('feed override scales speed and 0x90 restores 100%', () => {
  const { m, write, run } = bench()
  write('G1 X400 F600\n')
  m.realtime(0x92); m.realtime(0x92)           // -10% twice => 80%
  assert.equal(m.ov.feed, 80)
  run(1)
  assert.ok(Math.abs(m.mpos[0] - 8) < 0.5, `expected ~8 mm at 80%, got ${m.mpos[0]}`)

  m.realtime(0x90)
  assert.equal(m.ov.feed, 100)
})

test('soft limit raises an alarm and locks out g-code until $X', () => {
  const { m, out, write } = bench({ maxTravel: [50, 50, 50, 50] })
  write('G1 X100 F600\n')
  assert.ok(out.includes('ALARM:2'))
  assert.equal(m.state, 'Alarm')

  out.length = 0
  write('G1 X10 F600\n')
  assert.ok(out.includes('error:9'), 'g-code must be locked out during alarm')

  write('$X\n')
  assert.equal(m.state, 'Idle')
  assert.equal(m.alarm, null)
})

test('jog moves and 0x85 cancels it', () => {
  const { m, write, run } = bench()
  write('$J=G91 F1000 X50\n')
  assert.equal(m.state, 'Jog')
  run(0.5)
  assert.ok(m.mpos[0] > 0)

  m.realtime(0x85)
  assert.equal(m.state, 'Idle')
  const parked = m.mpos[0]
  run(1)
  assert.equal(m.mpos[0], parked)
})

test('$# reports nine coordinate systems, matching the real board', () => {
  const { out, write } = bench()
  write('$#\n')
  const kinds = out.filter(l => l[0] === '[').map(l => l.slice(1, l.indexOf(':')))
  assert.deepEqual(kinds.slice(0, 9),
    ['G54', 'G55', 'G56', 'G57', 'G58', 'G59', 'G59.1', 'G59.2', 'G59.3'])
  assert.ok(kinds.includes('TLO'))
  assert.ok(kinds.includes('PRB'))
})

test('a settings write is remembered, and $$ is the only way to see it', () => {
  const { m, out, write } = bench({ maxTravel: [500, 400, 300, 360] })
  write('$30=5000\n$130=250\n')
  // Bare oks, no echo — which is exactly why the client has to re-read $$.
  assert.deepEqual(out, ['ok', 'ok'])

  out.length = 0
  write('$$\n')
  assert.ok(out.includes('$30=5000'), `$$ still reports the old $30: ${out}`)
  assert.ok(out.includes('$130=250'), `$$ still reports the old $130: ${out}`)

  assert.equal(m.maxTravel[0], 250)

  // Junk must not reach the envelope. NaN there makes `Math.abs(v) > bound` false
  // for every v, silently switching the axis's soft limit off for good. This has
  // to be checked BEFORE the alarm below: exec() locks out everything but $X/$H
  // once the machine is in alarm, so a write tried afterwards never arrives and
  // the assertion would pass without proving anything.
  write('$130=abc\n')
  assert.equal(m.maxTravel[0], 250, 'a garbage $130 overwrote the soft limit')

  // $130 is the soft-limit envelope, not just a number $$ prints back.
  out.length = 0
  write('G21 G90\nG1 X300 F600\n')
  assert.ok(out.some(l => l.startsWith('ALARM')), `X300 is past the new limit: ${out}`)
})

test('output is never delivered on the caller stack', () => {
  // The regression that blew the stack: a synchronous ok let pump() re-enter itself
  // once per line. A real controller answers over a wire and never can.
  const { m, out } = bench()
  m.write('G1 X10 F600\n')
  assert.equal(out.length, 0, 'nothing should be delivered before drain()')
  m.drain()
  assert.ok(out.includes('ok'))
})

test('M-codes take effect when the block executes, not when it is parsed', () => {
  // The regression: the whole program is buffered in milliseconds, so applying
  // M3/M5 at parse time meant the M5 on the last line stopped the spindle before
  // the first cut had started. A real control's parser runs ahead of the table.
  const { m, write, run } = bench()
  write(['G21 G90', 'M3 S2400', 'G1 X40 F600', 'M5', 'M30'].join('\n') + '\n')

  assert.equal(m.spindle, 0, 'nothing should have executed yet')

  run(0.2)
  assert.equal(m.spindleDir, 1, 'spindle should be running once M3 reaches the front')
  assert.equal(m.spindle, 2400)

  run(2)
  assert.equal(m.spindle, 2400, 'still cutting — M5 has not been reached')
  assert.ok(m.mpos[0] > 0 && m.mpos[0] < 40)

  run(4)
  assert.equal(m.mpos[0], 40)
  assert.equal(m.spindleDir, 0, 'M5 runs after the move completes')
  assert.equal(m.spindle, 0)
})

test('coolant is deferred the same way and reported in the accessory field', () => {
  const { m, write, run } = bench()
  write('M8\nG1 X10 F600\nM9\n')
  run(0.2)
  assert.equal(m.flood, true)
  assert.match(m.statusReport(), /\|A:F/)
  run(3)
  assert.equal(m.flood, false)
})

// ------------------------------------------------------- the Phase 1 exit test

test('a whole program streams to the simulator and the machine ends where it should', () => {
  const program = `
    (facing pass)
    G21 G90 G54
    G0 X0 Y0 Z5
    G1 Z-1 F300
    G1 X50 F800
    G1 Y20
    G1 X0
    G1 Y0
    G0 Z5
    M30
  `
  const { m } = bench()
  const lines = prepare(program).map(l => l.text)

  const s = new Streamer(wire => m.write(wire), 1024)
  m.onLine(line => s.onLine(line))
  s.start(lines)

  let guard = 0
  while ((!s.done || m.current || m.queue.length) && guard++ < 20000) {
    m.tick(0.02)
    m.drain()
  }

  assert.ok(s.done, 'every line should have been acknowledged')
  assert.equal(s.error, null)
  assert.equal(m.state, 'Idle')
  assert.deepEqual(m.mpos.map(v => Number(v.toFixed(3))), [0, 0, 5, 0])
})

// ------------------------------------------------- fidelity-report regressions

test('a mid-line G91 no longer doubles the axes the block does not mention', () => {
  const { m, write, run } = bench()
  write('G0 X3 Y7\n'); run(5)
  write('G91 G0 X5\n'); run(5)                   // was [8,14] — C4 in the report
  assert.deepEqual(m.mpos.slice(0, 2), [8, 7])
  write('G90 G28 G91 Z0\n'); run(5)              // the manual's program ending
  assert.equal(m.mpos[0], 8, 'named-axis G28 must leave X alone')
  assert.equal(m.mpos[2], 0)
})

test('offset and TLO writes write, they do not move the machine', () => {
  const { m, write, run } = bench()
  write('G10 L2 P1 X-250\nG43.1 Z-50\n'); run(3)
  assert.equal(m.mpos[0], 0)
  assert.equal(m.offsets[0][0], -250)
  assert.equal(m.tloZ, -50)
})

test('the native tool table: G10 L1 feeds G43 H, and the offset moves Z', () => {
  const { m, write, run } = bench()
  write('G10 L1 P3 Z-20\nG43 H3\nG1 Z50 F600\n'); run(60)
  assert.equal(m.tloZ, -20)
  assert.ok(Math.abs(m.mpos[2] - 30) < 1e-6, `Z50 with TLO -20 must land at 30, got ${m.mpos[2]}`)
})

test('G81 drills and retracts; unsupported codes answer error:20, unused words error:36', () => {
  const { m, out, write, run } = bench()
  write('G0 Z5\n'); run(5)
  write('G81 Z-1.5 R0.1 F600\n'); run(30)
  assert.ok(Math.abs(m.mpos[2] - 5) < 1e-6, `G98 return to initial Z, got ${m.mpos[2]}`)
  write('G41 D1\nM39\nG1 X5 F100 Q5\n')
  assert.deepEqual(out.filter(l => l.startsWith('error:')), ['error:20', 'error:20', 'error:36'])
})

// The simulator was already the honest one here — its allowlist never ran these.
// This pins that down so the classroom seat and the wire cannot drift apart: the
// codes the sender refuses to send are the codes the sim refuses to run, and a
// refusal leaves the machine exactly as it found it.
test('the codes the wire refuses, the simulator refuses too, and changes nothing', () => {
  const { m, out, write, run } = bench()
  write('M3 S1000\nM8\nT3 M6\n'); run(5)
  m.realtime(0x7E); run(5)                        // clear the M6 hold
  const before = {
    ov: { ...m.ov }, spindle: m.spindle, dir: m.spindleDir, flood: m.flood,
    mist: m.mist, tool: m.tool, tloZ: m.tloZ, state: m.state, mpos: [...m.mpos]
  }
  out.length = 0

  // A real block per entry — a label like "M70-M73" is not one a parser can read,
  // and deriving blocks from the labels made this pass on malformed input instead
  // of on the collision. The key list is checked against the table below, so a
  // collision added without a block here fails rather than going untested.
  const BLOCKS = {
    'M48 M49': 'M48',
    'M50 M51 M53': 'M51 P0',
    M60: 'M60',
    M61: 'M61 Q5',
    'M70-M73': 'M70',
    'G28.1 G30.1': 'G28.1',
    'G10 L11': 'G10 L11 P5 Z2.5',
    'G10 L1 with R': 'G10 L1 P5 R2.5'
  }
  assert.deepEqual(Object.keys(BLOCKS).sort(), HAAS_COLLISIONS.map(([l]) => l).sort(),
    'a collision has no representative block here')

  const blocks = Object.values(BLOCKS)
  for (const code of blocks) write(code + '\n')
  run(10)

  assert.deepEqual(out.filter(l => l.startsWith('error:')), blocks.map(() => 'error:20'),
    `every refused code must answer error:20, got ${out.join(' ')}`)
  assert.deepEqual({
    ov: { ...m.ov }, spindle: m.spindle, dir: m.spindleDir, flood: m.flood,
    mist: m.mist, tool: m.tool, tloZ: m.tloZ, state: m.state, mpos: [...m.mpos]
  }, before, 'a refused code changed machine state')
})

test('M0 and M6 hold like the machine; cycle start resumes', () => {
  const { m, write, run } = bench()
  write('T2 M6\nG0 X1\n'); run(2)
  assert.equal(m.state, 'Hold')
  assert.equal(m.tool, 2)
  m.realtime(0x7E); run(5)
  assert.equal(m.mpos[0], 1)
})

test('HAAS G10 L10 writes H length from R and leaves tool radius unchanged', () => {
  const { m, write } = bench()
  m.tools.set(5, { z: -10, r: 7 })
  write('G10 L10 P5 R2.5\n')
  assert.deepEqual(m.tools.get(5), { z: 2.5, r: 7 })
  write('G20\nG10 L10 P5 R1.\n')
  assert.equal(m.tools.get(5).z, 25.4)
  assert.equal(m.tools.get(5).r, 7)
})

test('HAAS G28 homes named axes, cancels TLO, and leaves other axes alone', () => {
  const { m, write, run } = bench()
  m.mpos = [10, 20, 30, 40]
  m.tloZ = -25.4
  write('G91 G28 Z0\n'); run(30)
  assert.deepEqual(m.mpos, [10, 20, 0, 40])
  assert.equal(m.tloZ, 0)
  m.mpos = [1, 2, 3, 4]
  write('G28\n'); run(30)
  assert.deepEqual(m.mpos, [0, 0, 0, 0])
})

test('M00 stops spindle and coolant before hold; M30 also cancels TLO', () => {
  const { m, out, write, run } = bench()
  write('M3 S1000\nM7\nM8\nM0\n'); run(2)
  assert.deepEqual({ state: m.state, spindle: m.spindle, dir: m.spindleDir, flood: m.flood, mist: m.mist },
    { state: 'Hold', spindle: 0, dir: 0, flood: false, mist: false })
  m.realtime(0x7E); run(1)
  m.tools.set(1, { z: -25.4 })
  write('G43 H1\nM3 S900\nM8\nM30\n'); run(2)
  assert.deepEqual({ state: m.state, spindle: m.spindle, dir: m.spindleDir, flood: m.flood, mist: m.mist, tlo: m.tloZ },
    { state: 'Idle', spindle: 0, dir: 0, flood: false, mist: false, tlo: 0 })
  assert.ok(out.includes('[MSG:HAAS:M30]'))
})

test('$S holds after every block; $B decides slashed blocks; Pn reports both', () => {
  const { m, write, run } = bench()
  write('$S\nG0 X1\nG0 X2\n'); run(10)
  assert.equal(m.state, 'Hold')
  assert.equal(m.mpos[0], 1)
  m.realtime(0x7E); run(10)
  assert.equal(m.mpos[0], 2)
  m.realtime(0x7E); run(1)                       // clear the tail hold before $B
  write('$S\n$B\n/G0 X9\n'); run(5)
  assert.equal(m.mpos[0], 2)                     // skipped under $B
  assert.match(m.statusReport(), /\|Pn:L/)
})

test('a streamed M01 holds in the firmware and CYCLE START resumes — the cutover flow', () => {
  const { m, write, run } = bench()
  // Option stop ON = the disable flag CLEAR, so a fresh sim already honours M01.
  const program = ['G0 X1', 'M01', 'G0 X2']
  const streamer = new Streamer((w) => write(w), 1024)
  streamer.start(program)
  run(5)
  assert.equal(m.state, 'Hold', 'M01 must hold with option stop on')
  assert.ok(Math.abs(m.mpos[0] - 1) < 1e-6)
  m.realtime(0x7E); run(5)                     // CYCLE START's resume byte
  assert.equal(m.mpos[0], 2)
  assert.equal(m.state, 'Idle')
  // And with the switch off ($O sets the disable flag) M01 is the firmware's no-op.
  const b2 = bench()
  b2.write('$O\n')
  const s2 = new Streamer((w) => b2.write(w), 1024)
  s2.start(program)
  b2.run(5)
  assert.equal(b2.m.state, 'Idle')
  assert.equal(b2.m.mpos[0], 2)
})

test('G51 is MACH3-style like the board: axis words are factors, about work zero', () => {
  const { m, write, run } = bench()
  write('G51 X2\nG0 X10\n'); run(10)
  assert.equal(m.mpos[0], 20)                    // bench-verified 2026-08-07
  write('G50\nG0 X10\n'); run(10)
  assert.equal(m.mpos[0], 10)
  const b2 = bench()
  b2.write('G51 X0 Y0 P2\n')                     // HAAS centre+P form: unused P
  assert.equal(b2.out.filter(l => l.startsWith('error:')).pop(), 'error:36')
})

test('$# prints all 32 tool rows, zeros included, exactly like the board', () => {
  const { out, write } = bench()
  write('G10 L1 P3 Z-20\n$#\n')
  const rows = out.filter(l => l.startsWith('[T:'))
  assert.equal(rows.length, 32)
  assert.ok(rows[2].startsWith('[T:3|0.000,0.000,-20.000'))
  assert.ok(rows[0].startsWith('[T:1|0.000,0.000,0.000'), 'unset tools print as zero rows')
})

import { readFileSync } from 'node:fs'
import { wireProgram } from '../src/grbl.js'

test('the cross-environment fixture runs identically on the sim seat', () => {
  // The same file runs three ways: here (streamed+expanded), bench-streamed,
  // and $F= DNC where the board's own M97/M98 take over. Same end state is
  // the pass bar for all three.
  const main = prepare(readFileSync(new URL('./fixtures/O0100.nc', import.meta.url), 'utf8'))
  const sub = prepare(readFileSync(new URL('./fixtures/O0200.nc', import.meta.url), 'utf8'))
  const { wire } = wireProgram(main, {
    caps: { runSwitches: true, toolTable: true },
    getProgram: (n) => n === 200 ? sub : null
  })
  const { m, write, run } = bench()
  for (const line of wire) {
    write(line + '\n')
    run(20)
    if (m.state === 'Hold') { m.realtime(0x7E); run(20) }   // the M6 pause
  }
  run(60)
  assert.equal(m.state, 'Idle')
  // The DNC leg on the real board ended exactly here (2026-08-07):
  // X two M97 passes, Y the M98 sub, and Z at 10 - 25.4 because a same-block
  // G49 does not lift the offset from its own move.
  assert.deepEqual(m.mpos.map(v => Number(v.toFixed(3))), [10, 2, -15.4, 0])
})

test('G86 bores, stops the spindle at the bottom, and requires P like the board', () => {
  const a = bench()
  a.write('M3 S1000\nG0 Z5\nG86 Z-2 R1 F500\n')
  assert.equal(a.out.filter(l => l.startsWith('error:')).pop(), 'error:28')
  const b = bench()
  b.write('M3 S1000\nG0 Z5\nG86 P0 Z-2 R1 F500\n'); b.run(30)
  assert.equal(b.m.state, 'Idle')
  assert.equal(b.m.spindleDir, 0, 'spindle stopped at the bottom')
  assert.ok(Math.abs(b.m.mpos[2] - 5) < 1e-6, 'rapid retract to initial Z')
})

test('the chip conveyor and TSC M-codes work like the bench board', () => {
  const { m, write, run } = bench()
  write('M31\n'); run(0.2)
  assert.equal(m.chipFwd, true)
  write('M33\n'); run(0.2)
  assert.equal(m.chipFwd, false)
  write('M88\n'); run(0.2)
  assert.equal(m.mist, true, 'TSC rides the mist bit — A:M on the wire')
  assert.match(m.statusReport(), /\|A:.*M/)
  write('M89\n'); run(0.2)
  assert.equal(m.mist, false)
})

test('a reset in motion alarms, a second reset does not clear it, $X does', () => {
  const { m, out, write, run } = bench()
  write('G21 G90\nG1 X60 F600\n')
  run(1)
  assert.equal(m.state, 'Run')

  out.length = 0
  m.realtime(0x18); m.drain()                 // RESET mid-cut
  assert.equal(m.state, 'Alarm')
  assert.ok(out.includes('ALARM:3'), out.join('|'))

  m.realtime(0x18); m.drain()                 // and again — grbl stays locked
  assert.equal(m.state, 'Alarm')
  write('G0 X0\n')
  assert.ok(out.includes('error:9'), 'g-code must stay locked out')

  write('$X\n')
  assert.equal(m.state, 'Idle')
  assert.equal(m.alarm, null)
})

/** Every point of the block's path, which is what the plot draws and the tool travels. */
const pathOf = (m) => m.queue.at(-1).path.map(s => s.target)

test('G2 traces the arc it was given, not the chord across it', () => {
  const { m, write, run } = bench()
  write('G21 G90 G17\nG0 X0 Y0\nG1 F600\nG2 X25 Y25 I25 J0\n')

  const pts = pathOf(m)
  assert.ok(pts.length > 20, `expected a segmented arc, got ${pts.length} point(s)`)
  for (const [x, y] of pts) {
    assert.ok(Math.abs(Math.hypot(x - 25, y - 0) - 25) < 0.02, `(${x},${y}) is off the circle`)
  }
  // Clockwise from the west point goes over the top, so the arc bulges into +Y.
  assert.ok(pts.some(([x, y]) => y > 17 && x < 10), 'arc does not bulge the right way')
  assert.deepEqual(pts.at(-1).slice(0, 2), [25, 25])

  run(30)
  assert.ok(Math.hypot(m.mpos[0] - 25, m.mpos[1] - 25) < 1e-6, `landed at ${m.mpos}`)
})

test('an arc with no axis words is a full circle, and R says which way round', () => {
  const { m, write } = bench()
  write('G21 G90 G17\nG1 F600\nG2 I25\n')          // full circle about X+25
  const pts = pathOf(m)
  assert.ok(Math.max(...pts.map(p => p[0])) > 49.9, 'circle never reaches the far side')
  assert.ok(Math.abs(pts.at(-1)[0]) < 1e-6 && Math.abs(pts.at(-1)[1]) < 1e-6, 'must close on the start')

  const b2 = bench()
  b2.write('G21 G90 G17\nG1 F600\nG2 X50 Y0 R25\n')  // semicircle over the top
  assert.ok(pathOf(b2.m).some(([, y]) => y > 24.9), 'R25 semicircle should reach +Y25')

  const b3 = bench()
  b3.write('G21 G90 G17\nG1 F600\nG3 X50 Y0 R25\n')  // the other way
  assert.ok(pathOf(b3.m).some(([, y]) => y < -24.9), 'G3 should go under')
})

test('the board\'s arc errors: no offsets, an impossible radius, a bad endpoint', () => {
  const { out, write } = bench()
  write('G21 G90 G17 G1 F600\n')
  out.length = 0
  write('G2 X10 Y10\n')
  assert.ok(out.includes('error:35'), out.join('|'))
  out.length = 0
  write('G2 X50 Y0 R10\n')                          // 20 mm of diameter, 50 mm away
  assert.ok(out.includes('error:34'), out.join('|'))
  out.length = 0
  write('G2 X50 Y0 I5 J0\n')                        // endpoint nowhere near the circle
  assert.ok(out.includes('error:33'), out.join('|'))
})

test('the graphics plot is the program, drawn from the planner without ticking', () => {
  const { pts, err, blocks } = toolPath([
    'G21 G90 G17', 'G0 X10 Y10', 'G1 F600 X30', 'G2 X40 Y20 I0 J10', 'G0 X0 Y0'
  ])
  assert.equal(err, null)
  assert.equal(blocks, 5)   // every block is planned, motion or not

  assert.deepEqual(pts[0], [0, 0, true])                    // starts at machine zero
  assert.deepEqual(pts[1], [10, 10, true])                  // the rapid in
  assert.ok(pts.some(p => p[0] === 30 && p[1] === 10 && !p[2]), 'the cut is a feed move')
  // The arc is many points, all on its circle, and none of them rapid.
  const arc = pts.filter(p => !p[2] && p[0] > 30)
  assert.ok(arc.length > 10, `arc drew ${arc.length} points`)
  for (const [x, y] of arc) assert.ok(Math.abs(Math.hypot(x - 30, y - 20) - 10) < 0.02)
  assert.deepEqual(pts.at(-1), [0, 0, true])                // and the rapid out
})

test('a plot stops where the machine would have: bad block, or off the table', () => {
  const bad = toolPath(['G21 G90', 'G0 X10 Y10', 'G1 X20 F0', 'G1 X50'])
  assert.equal(bad.err, 'error:22')                          // no feedrate
  assert.ok(bad.pts.every(p => p[0] <= 10), 'nothing past the rejected block')

  const off = toolPath(['G21 G90', 'G0 X10', 'G0 X400'], { maxTravel: [100, 100, 100, 100] })
  assert.equal(off.err, 'ALARM:2')
  assert.deepEqual(off.pts.at(-1), [10, 0, true])
})
