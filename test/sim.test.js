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
