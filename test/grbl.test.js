import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseStatus, parseFeedback, rxBufferFromOpt, Streamer, prepare } from '../src/grbl.js'

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

test('prepare strips comments, blanks and block-deletes but keeps line numbers', () => {
  const got = prepare([
    'G21 G90        ',
    '',
    '(SETUP: X<0 SIDE)',
    'G1 X10 (move) Y20',
    '/G0 Z50',
    'M30 ; end'
  ].join('\n'))
  assert.deepEqual(got, [
    { n: 1, text: 'G21 G90' },
    { n: 4, text: 'G1 X10  Y20' },
    { n: 6, text: 'M30' }
  ])
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
