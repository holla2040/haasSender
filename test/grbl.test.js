import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseStatus, parseFeedback, rxBufferFromOpt, Streamer, prepare, parseONumber, wireProgram, WCS, setWorkOffset, distanceToGo } from '../src/grbl.js'

// Captured verbatim from the ClearCore at 192.168.0.113.
const REAL_STATUS =
  '<Idle|MPos:111.470,-192.628,5.000,0.000|Bf:100,1023|Ln:187756|FS:0,0|Ov:100,100,100>'

test('parseStatus reads a real grblHAL report', () => {
  const s = parseStatus(REAL_STATUS)
  assert.equal(s.state, 'Idle')
  assert.deepEqual(s.MPos, [111.470, -192.628, 5.000, 0.000])
  assert.deepEqual(s.bf, { blocks: 100, bytes: 1023 })
  assert.equal(s.line, 187756)
  assert.equal(s.feed, 0)
  assert.equal(s.spindle, 0)
  assert.deepEqual(s.ov, { feed: 100, rapid: 100, spindle: 100 })
})

test('parseStatus handles sub-states and optional fields', () => {
  const s = parseStatus('<Hold:0|MPos:1,2,3,4|WCO:0,0,0,0|Pn:XYZ|A:SFM>')
  assert.equal(s.state, 'Hold')
  assert.equal(s.sub, 0)
  assert.deepEqual(s.WCO, [0, 0, 0, 0])
  assert.equal(s.pins, 'XYZ')
  assert.equal(s.accessory, 'SFM')
  assert.equal(parseStatus('ok'), null)
})

test('parseFeedback splits coordinate reports and probe flags', () => {
  assert.deepEqual(parseFeedback('[G54:1,2,3,4]'), { kind: 'G54', value: [1, 2, 3, 4] })
  assert.deepEqual(parseFeedback('[G59.3:0,0,0,0]'), { kind: 'G59.3', value: [0, 0, 0, 0] })
  assert.deepEqual(parseFeedback('[TLO:0,0,0,0]'), { kind: 'TLO', value: [0, 0, 0, 0] })
  assert.deepEqual(parseFeedback('[PRB:0,0,-0.152,0:1]'),
    { kind: 'PRB', value: [0, 0, -0.152, 0], ok: true })
  // Modal state stays a string.
  assert.equal(parseFeedback('[GC:G1 G54 G90 M5]').value, 'G1 G54 G90 M5')
})

test('rxBufferFromOpt pulls the buffer size out of the real $I option string', () => {
  assert.equal(rxBufferFromOpt('VNML,100,1024,4,0'), 1024)
  assert.equal(rxBufferFromOpt('garbage'), null)
})

const TAPE = [
  '%',
  'O1234 (FACE THE TOP)',
  'G21 G90        ',
  '',
  '(SETUP: X<0 SIDE)',
  'G1 X10 (move) Y20',
  '/G0 Z50',
  'M30 ; end',
  '%'
].join('\n')

test('prepare strips comments, blanks, the tape wrapper and the O-number', () => {
  assert.deepEqual(prepare(TAPE), [
    { n: 3, text: 'G21 G90' },
    { n: 6, text: 'G1 X10  Y20' },
    // The slash is kept: the program display shows the file as written, and
    // whether the block runs is the front panel's business, not the parser's.
    { n: 7, text: '/G0 Z50', del: true },
    { n: 8, text: 'M30' }
  ])
})

// The switch is off at power-up on a real machine, so a `/` block runs — without
// its slash. Dropping them unconditionally is that switch jammed on.
test('BLOCK DELETE decides whether a slashed block runs', () => {
  const lines = prepare(TAPE)
  assert.deepEqual(wireProgram(lines, { blockDelete: false }).wire,
    ['G21 G90', 'G1 X10 Y20', 'G0 Z50', 'M30'])
  assert.deepEqual(wireProgram(lines, { blockDelete: true }).wire,
    ['G21 G90', 'G1 X10 Y20', 'M30'])
})

// A switch that removes a block must not slide the running-block highlight off
// the row it belongs to, so the wire list carries where each line came from.
test('wireProgram reports which source row each wire line came from', () => {
  const lines = prepare(TAPE)
  assert.deepEqual(wireProgram(lines, {}).rows, [0, 1, 2, 3])
  assert.deepEqual(wireProgram(lines, { blockDelete: true }).rows, [0, 1, 3])
})

test('DRY RUN suppresses spindle and coolant on, but never the offs', () => {
  const lines = prepare(['M3 S1000', 'M8', 'G1 X1 M3', 'M9', 'M5', 'M30'].join('\n'))
  // `S1000` survives on its own, deliberately. A speed with no M3 spins nothing,
  // and it keeps the modal state the program set — so leaving dry run and running
  // the same program for real behaves identically. Only the M-codes are the switch.
  assert.deepEqual(wireProgram(lines, { dryRun: true }).wire,
    ['S1000', 'G1 X1', 'M9', 'M5', 'M30'])
  assert.deepEqual(wireProgram(lines, { dryRun: false }).wire,
    ['M3 S1000', 'M8', 'G1 X1 M3', 'M9', 'M5', 'M30'])
})

test('OPTION STOP decides whether M01 reaches the machine, and M30 is untouched', () => {
  const lines = prepare(['G1 X1', 'M01', 'G1 X2', 'M30'].join('\n'))
  assert.deepEqual(wireProgram(lines, { optionStop: true }).wire, ['G1 X1', 'M01', 'G1 X2', 'M30'])
  assert.deepEqual(wireProgram(lines, { optionStop: false }).wire, ['G1 X1', 'G1 X2', 'M30'])
})

test('parseONumber finds the program name, and admits when there is none', () => {
  assert.equal(parseONumber(TAPE), 'O01234')
  assert.equal(parseONumber('O5\nG0 X0'), 'O00005')
  assert.equal(parseONumber('\n\n%\n  o42 \nG0'), 'O00042')
  // A CAM post that never expected control memory. Do not invent a number.
  assert.equal(parseONumber('G21 G90\nG0 X0'), null)
  assert.equal(parseONumber('(O1234 IS IN A COMMENT)\nG0'), null)
})

// --------------------------------------------------------------- the real check

/**
 * Drive the streamer through a whole program while acking every line, and assert
 * the two properties that matter: we never overfill the controller's RX buffer,
 * and every line goes out exactly once, in order.
 */
test('Streamer never exceeds the RX buffer and sends every line exactly once', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `G1 X${i}.000 Y${i}.000 F500`)
  const RX = 128

  const sent = []
  let highWater = 0
  const s = new Streamer((wire) => { sent.push(wire) }, RX)

  s.start(lines)

  // Ack one line at a time, checking the invariant after every pump.
  let guard = 0
  while (!s.done) {
    assert.ok(++guard < 10000, 'streamer failed to converge')
    highWater = Math.max(highWater, s.inFlight)
    assert.ok(s.inFlight < RX, `in-flight ${s.inFlight} reached buffer size ${RX}`)
    s.onLine('ok')
  }

  assert.equal(sent.length, lines.length)
  assert.deepEqual(sent.map(w => w.trimEnd()), lines)
  // Sanity: it should actually be pipelining, not sending one line at a time.
  assert.ok(highWater > RX / 2, `expected real pipelining, high water was ${highWater}`)
})

// One CYCLE START, one block — and it must be one, not two, and not one per ack.
test('SINGLE BLOCK sends exactly one block per release', () => {
  const sent = []
  const s = new Streamer(w => sent.push(w.trimEnd()), 1024)
  s.singleBlock = true
  s.start(['G0 X1', 'G0 X2', 'G0 X3'])

  assert.deepEqual(sent, [], 'nothing goes out until CYCLE START')

  s.release()
  assert.deepEqual(sent, ['G0 X1'])
  s.release()
  assert.deepEqual(sent, ['G0 X1'], 'a second press must not run ahead of the ack')

  s.onLine('ok')                       // block 1 accepted; the release is waiting
  assert.deepEqual(sent, ['G0 X1', 'G0 X2'])

  s.onLine('ok')
  assert.deepEqual(sent, ['G0 X1', 'G0 X2'], 'an ack alone does not advance')
  s.release()
  assert.deepEqual(sent, ['G0 X1', 'G0 X2', 'G0 X3'])
})

test('Streamer halts on error and remembers which line failed', () => {
  const s = new Streamer(() => {}, 128)
  s.start(['G0 X1', 'BOGUS', 'G0 X2'])

  s.onLine('ok')            // line 1 accepted
  s.onLine('error:20')      // line 2 rejected

  assert.equal(s.running, false)
  assert.equal(s.error.code, 20)
  assert.equal(s.error.line, 2)
  assert.match(s.error.text, /Unsupported or invalid g-code/)
})

test('Streamer tolerates a stray ok from a manual command', () => {
  const s = new Streamer(() => {}, 128)
  s.start(['G0 X1'])
  s.onLine('ok')
  assert.equal(s.done, true)
  s.onLine('ok')            // stray — must not corrupt the counters
  assert.equal(s.acked, 1)
  assert.equal(s.inFlight, 0)
})

test('Streamer refuses a line longer than the buffer instead of stalling forever', () => {
  const long = 'G1 ' + 'X1.000 '.repeat(30)   // 213 bytes, buffer is 32
  const sent = []
  const s = new Streamer(w => sent.push(w), 32)
  s.start([long, 'G0 X0'])

  assert.equal(sent.length, 0)
  assert.equal(s.running, false)
  assert.equal(s.error.code, 11)
  assert.equal(s.error.line, 1)
  assert.match(s.error.text, /longer than the controller's 32-byte buffer/)
})

// The G154 P1-P3 mapping was measured on the ClearCore, not read off a datasheet:
// `G10 L2 P7 X1.234` moved G59.1 and `P9 Y5.678` moved G59.3. Lock it in — a
// wrong P-number silently writes a work zero into the wrong coordinate system.
test('the offset table maps HAAS names onto the P-numbers the board honours', () => {
  assert.equal(WCS.length, 9)
  assert.deepEqual(WCS.map(w => w.p), [1, 2, 3, 4, 5, 6, 7, 8, 9])
  assert.deepEqual(WCS.find(w => w.name === 'G154 P1'), { name: 'G154 P1', report: 'G59.1', p: 7 })
  assert.deepEqual(WCS.find(w => w.name === 'G154 P3'), { name: 'G154 P3', report: 'G59.3', p: 9 })
  // Every name the board reports under is one $# actually sends.
  assert.deepEqual(WCS.map(w => w.report),
    ['G54', 'G55', 'G56', 'G57', 'G58', 'G59', 'G59.1', 'G59.2', 'G59.3'])
})

test('setWorkOffset writes one axis, at a precision worth having', () => {
  assert.equal(setWorkOffset(3, 'X', 20), 'G10 L2 P3 X20.0000')
  assert.equal(setWorkOffset(7, 'Z', -12.5), 'G10 L2 P7 Z-12.5000')
  // 30 mm in inches — the value PART ZERO SET sends when the control is in G20.
  assert.equal(setWorkOffset(4, 'Y', 30 / 25.4), 'G10 L2 P4 Y1.1811')
})

// DIST TO GO is computed, not reported, so the important half is knowing when it
// cannot be computed. A plausible wrong number here is worse than dashes: it is
// the readout an operator uses to judge whether to reach into the machine.
test('distanceToGo admits when the block does not say', () => {
  const at = { mpos: [10, 0, 0, 0] }
  assert.equal(distanceToGo('M8', at), null, 'no axis words is not a move')
  assert.equal(distanceToGo('', at), null)
  assert.equal(distanceToGo(null, at), null)
  assert.equal(distanceToGo('G1 X50', { ...at, absolute: false }), null,
    'incremental target depends on where the move began')
})

test('distanceToGo measures from the work offset, in the report unit', () => {
  assert.deepEqual(distanceToGo('G1 X50 F600', { mpos: [10, 0, 0, 0] }), [40, 0, 0, 0])
  // A work offset shifts the target onto the machine's own axis.
  assert.deepEqual(distanceToGo('G0 X50', { mpos: [10, 0, 0, 0], wco: [5, 0, 0, 0] }),
    [45, 0, 0, 0])
  // An inch program against a millimetre report: 2" is 50.8 mm.
  assert.deepEqual(distanceToGo('G1 X2', { mpos: [0.8, 0, 0, 0], scale: 25.4 }),
    [50, 0, 0, 0])
  // Only the axes the block names move; the rest are already there.
  assert.deepEqual(distanceToGo('G1 Y-3', { mpos: [7, 1, 0, 0] }), [0, -4, 0, 0])
})

test('distanceToGo does not mistake a letter inside another word for an axis', () => {
  // The Z here belongs to nothing — there is no number after it — and the X in
  // G91.1 is not an axis word either.
  assert.equal(distanceToGo('G17 G40 G49', { mpos: [0, 0, 0, 0] }), null)
  assert.deepEqual(distanceToGo('G53 X10', { mpos: [0, 0, 0, 0] }), [10, 0, 0, 0])
})
