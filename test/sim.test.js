import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VirtualGrbl } from '../src/sim.js'
import { Streamer, parseStatus, prepare } from '../src/grbl.js'

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
  assert.equal(m.mpos[0], 0)
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

test('M0 and M6 hold like the machine; cycle start resumes', () => {
  const { m, write, run } = bench()
  write('T2 M6\nG0 X1\n'); run(2)
  assert.equal(m.state, 'Hold')
  assert.equal(m.tool, 2)
  m.realtime(0x7E); run(5)
  assert.equal(m.mpos[0], 1)
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
