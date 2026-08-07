import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as grblNS from '../src/grbl.js'
import { wireLine, WireError, parseStatus, parseFeedback, rxBufferFromOpt, Streamer, prepare, parseONumber, parseOWord, wireProgram, toolsUsed, words, editBlock, modalGroups, WCS, setWorkOffset, distanceToGo } from '../src/grbl.js'

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

// What the control DISPLAYS: the file as written. Comments, slashes and the
// O-number line all stay, because that is what a HAAS shows and what a student
// edits. Only blanks and the tape wrapper go, because neither is a block.
test('prepare keeps the program as written, minus blanks and the tape wrapper', () => {
  assert.deepEqual(prepare(TAPE), [
    { n: 2, text: 'O1234 (FACE THE TOP)' },
    { n: 3, text: 'G21 G90' },
    { n: 5, text: '(SETUP: X<0 SIDE)' },
    { n: 6, text: 'G1 X10 (move) Y20' },
    { n: 7, text: '/G0 Z50', del: true },
    { n: 8, text: 'M30 ; end' }
  ])
})

// ...and what goes on the WIRE: no comments, no O-number, no comment-only blocks.
test('wireProgram sends code, not the notes around it', () => {
  assert.deepEqual(wireProgram(prepare(TAPE), {}).wire,
    ['G21 G90', 'G1 X10 Y20', 'G0 Z50', 'M30'])
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
  // Rows 0 and 2 are the O-number and a comment-only block: displayed, not sent.
  assert.deepEqual(wireProgram(lines, {}).rows, [1, 3, 4, 5])
  assert.deepEqual(wireProgram(lines, { blockDelete: true }).rows, [1, 3, 5])
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

// Two keys file a program by a number the operator typed: SELECT PROGRAM on the
// LIST page (§3.3.2) and ALTER at the head of the MDI page (§4.2.3 step 3). They
// share this so they cannot disagree about what a program number is. The strict
// end anchor is the point: `O10 G0 X5` is a block a student meant to RUN, and
// taking it for a program number would file the MDI page instead of running it.
test('parseOWord takes a typed program number and nothing else', () => {
  assert.equal(parseOWord('O10'), 'O00010')
  assert.equal(parseOWord('o 7 '), 'O00007')
  assert.equal(parseOWord('O00010'), 'O00010')
  assert.equal(parseOWord('O99999'), 'O99999')

  assert.equal(parseOWord('O10 G0 X5'), null)      // a block, not a number
  assert.equal(parseOWord('G0 X10'), null)
  assert.equal(parseOWord('O123456'), null)        // six digits is not a HAAS number
  assert.equal(parseOWord('O'), null)
  assert.equal(parseOWord(''), null)
  assert.equal(parseOWord(undefined), null)
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

// N_TOOLS 0 on the board, so the sender owns the tool table and turns HAAS
// `G43 H<n>` into grbl's dynamic `G43.1 Z<length>`. The value is the machine Z
// recorded by TOOL OFFSET MEASURE, sent as-is — verified on the ClearCore, where
// `G43.1 Z-10` put -10.000 into both [TLO:] and WCO, and G49 cleared it. No sign
// flip anywhere, which is one fewer thing to get backwards.
test('G43 H<n> becomes its own G43.1 block, so the Z words do not collide', () => {
  const lines = prepare(['G0 X0', 'G43 H1 Z50.', 'G1 Z-2 F100', 'G49'].join('\n'))
  const { wire, rows } = wireProgram(lines, { tools: { 1: -123.456 } })
  assert.deepEqual(wire, ['G0 X0', 'G43.1 Z-123.4560', 'Z50.', 'G1 Z-2 F100', 'G49'])
  // Both halves of the split point back at the line they came from, so the
  // running-block highlight still lands on the right row.
  assert.deepEqual(rows, [0, 1, 1, 2, 3])
})

test('a G43 on its own line leaves no empty block behind', () => {
  const lines = prepare(['G43 H2', 'G0 Z10'].join('\n'))
  assert.deepEqual(wireProgram(lines, { tools: { 2: -5 } }).wire, ['G43.1 Z-5.0000', 'G0 Z10'])
})

test('an unmeasured tool applies no offset, and G43.1 is left alone', () => {
  const lines = prepare(['G43 H7 Z1', 'G43.1 Z-9'].join('\n'))
  const { wire } = wireProgram(lines, { tools: {} })
  assert.deepEqual(wire, ['G43.1 Z0.0000', 'Z1', 'G43.1 Z-9'])
})

test('toolsUsed reports which offsets a program expects', () => {
  assert.deepEqual(toolsUsed(prepare(['G43 H1 Z5', 'G0 X1', 'G43 H03 Z5'].join('\n'))), [1, 3])
  assert.deepEqual(toolsUsed(prepare(['G0 X1', 'G49'].join('\n'))), [])
})

// ------------------------------------------------------- the word-level cursor

// Everything in EDIT stands on this. A tokeniser that splits X-1.5 into three
// pieces makes INSERT, ALTER and DELETE wrong in the same way, and the operator
// finds out by scrapping a part.
test('words() splits a block the way a HAAS cursor moves', () => {
  assert.deepEqual(words('G1 X-1.5 Y.25 F600'), ['G1', 'X-1.5', 'Y.25', 'F600'])
  assert.deepEqual(words('G01X10Y20'), ['G01', 'X10', 'Y20'], 'no spaces is still four words')
  assert.deepEqual(words('X+.5'), ['X+.5'])
  // A comment is one selectable thing, not five.
  assert.deepEqual(words('G0 X1 (ROUGH PASS) Y2'), ['G0', 'X1', '(ROUGH PASS)', 'Y2'])
  assert.deepEqual(words('M30 ; done'), ['M30', '; done'])
  // The block-delete slash is its own word, so the cursor can sit on it.
  assert.deepEqual(words('/G0 Z50'), ['/', 'G0', 'Z50'])
  assert.deepEqual(words(''), [])
  assert.deepEqual(words(null), [])
})

test('editBlock alters, inserts after, and deletes one word', () => {
  const b = 'G1 X10 Y20 F600'
  assert.equal(editBlock(b, 1, 'alter', 'X-5'), 'G1 X-5 Y20 F600')
  assert.equal(editBlock(b, 1, 'insert', 'Z3'), 'G1 X10 Z3 Y20 F600')
  assert.equal(editBlock(b, 1, 'delete'), 'G1 Y20 F600')
  // Insert past the end appends — what INSERT on an empty block must do.
  assert.equal(editBlock('', 0, 'insert', 'G0'), 'G0')
  assert.equal(editBlock('G0', 5, 'insert', 'X1'), 'G0 X1')
  // A slashed block keeps its slash tight against the block, as it was written.
  assert.equal(editBlock('/G0 Z50', 2, 'alter', 'Z10'), '/G0 Z10')
  assert.equal(editBlock('/G0 Z50', 0, 'delete'), 'G0 Z50')
})

// ------------------------------------------------------------- current commands

// Captured from the ClearCore, verbatim.
const REAL_MODAL = 'G0 G54 G17 G21 G90 G94 G49 G98 G50 M5 M9 T0 F600 S1000.'

test('modalGroups breaks a real $G string into named groups', () => {
  const g = modalGroups(REAL_MODAL)
  const by = Object.fromEntries(g.map(r => [r.group, r]))
  assert.equal(by.MOTION.code, 'G0')
  assert.equal(by.MOTION.meaning, 'rapid positioning')
  assert.equal(by.UNITS.meaning, 'millimetre')
  assert.equal(by.DISTANCE.meaning, 'absolute')
  assert.equal(by['TOOL LENGTH'].meaning, 'cancelled')
  assert.equal(by.SPINDLE.meaning, 'off')
  // The word-valued ones keep their value and need no gloss.
  assert.equal(by.FEED.code, 'F600')
  assert.equal(by.SPEED.code, 'S1000', 'grbl prints S1000. with a trailing dot')
  assert.equal(by.TOOL.code, 'T0')
  // Groups come out in reading order, not the order grbl happened to print them.
  assert.equal(g[0].group, 'MOTION')
})

// A page whose whole job is saying what is active must not silently drop a code
// it does not recognise.
test('modalGroups shows an unknown code rather than dropping it', () => {
  const g = modalGroups('G1 G61 G21')
  const odd = g.find(r => r.code === 'G61')
  assert.ok(odd, 'G61 must still appear')
  assert.match(odd.meaning, /not known to this control/)
  assert.equal(modalGroups('').length, 0)
  assert.equal(modalGroups(null).length, 0)
})

test('modalGroups maps the HAAS names onto the extended work offsets', () => {
  assert.equal(modalGroups('G59.1').find(r => r.group === 'WORK OFFSET').meaning,
    'G154 P1 on a HAAS')
})

// ------------------------------------------------- the HAAS dialect transform

test('wireLine: HAAS integer-P G04 is milliseconds, decimal-P is seconds', () => {
  assert.deepEqual(wireLine('G04 P500', {}), ['G04 P0.5'])
  assert.deepEqual(wireLine('G4 P10', {}), ['G4 P0.01'])
  assert.deepEqual(wireLine('G04 P10.', {}), ['G04 P10.'])   // decimal stays seconds
  assert.deepEqual(wireLine('G83 Z-1 R1 Q1 P500 F100', {}),  // canned-cycle P untouched
    ['G83 Z-1 R1 Q1 P500 F100'])
})

test('wireLine: HAAS spellings translate — G31, M16, G154 P1-3', () => {
  assert.deepEqual(wireLine('G31 Z-10 F50', {}), ['G38.2 Z-10 F50'])
  assert.deepEqual(wireLine('M16 T2', {}), ['M6 T2'])
  assert.deepEqual(wireLine('G154 P2', {}), ['G59.2'])
  assert.deepEqual(wireLine('G154 P44', {}), ['G154 P44'])   // P4+ errors on the board, honestly
})

test('wireLine: G43 H splits into G43.1 without a tool table, passes through with one', () => {
  assert.deepEqual(wireLine('G43 H3 Z50.', { tools: { 3: -20 } }),
    ['G43.1 Z-20.0000', 'Z50.'])
  assert.deepEqual(wireLine('G43 H3 Z50.', { tools: { 3: -20 }, caps: { toolTable: true } }),
    ['G43 H3 Z50.'])
})

test('with native run switches, M01 and slashed blocks ride the wire', () => {
  const lines = prepare('G0 X1\n/G0 X2\nM01\nG0 X3')
  const { wire } = wireProgram(lines, { caps: { runSwitches: true } })
  assert.deepEqual(wire, ['G0 X1', '/G0 X2', 'M01', 'G0 X3'])
})

// ------------------------------------------------------ subprogram expansion

const SUB_PROGRAM = `O00100
G0 X0
M97 P200 L2
M30
N200 G1 X5 F100
G1 X9
M99`

test('M97 splices the N-block range, repeats honour L, highlight follows the sub', () => {
  const lines = prepare(SUB_PROGRAM)
  const { wire, rows } = wireProgram(lines, {})
  assert.deepEqual(wire,
    ['G0 X0', 'N200 G1 X5 F100', 'G1 X9', 'N200 G1 X5 F100', 'G1 X9', 'M30'])
  // rows point at the sub's own source lines, the way a control jumps its display
  assert.deepEqual(rows.slice(1, 3), [4, 5])
})

test('nothing after M30 streams — where the manual parks M97 subs', () => {
  const { wire } = wireProgram(prepare('G0 X1\nM30\nN200 G1 X5 F100\nM99'), {})
  assert.deepEqual(wire, ['G0 X1', 'M30'])
})

test('M98 inlines a program from control memory, pinned to the calling row', () => {
  const sub = prepare('O00200\nG1 X5 F100\nM99')
  const lines = prepare('G0 X1\nM98 P200\nM30')
  const { wire, rows } = wireProgram(lines, { getProgram: (n) => n === 200 ? sub : null })
  assert.deepEqual(wire, ['G0 X1', 'G1 X5 F100', 'M30'])
  assert.equal(rows[1], 1)                        // the M98 line, not the sub's
})

test('unstreamable programs refuse with the reason', () => {
  const throws = (text, opts, re) =>
    assert.throws(() => wireProgram(prepare(text), opts), (e) => e instanceof WireError && re.test(e.message))
  throws('M97 P999\nM30\nN1 M99', {}, /no block N999/)
  throws('M98 P777\nM30', { getProgram: () => null }, /O00777 is not in memory/)
  throws('G0 X1\nM99', {}, /loops the program forever/)
  throws('G65 P300 A5\nM30', { getProgram: () => prepare('M99') }, /macro arguments/)
  throws('N1 M97 P1\nM30', {}, /nested deeper/)   // self-call recurses past the depth cap
})

test('a block-deleted G43 H keeps its slash on every line it becomes', () => {
  const lines = prepare('/G43 H3 Z50.')
  const { wire } = wireProgram(lines, { tools: { 3: -20 }, caps: { runSwitches: true } })
  assert.deepEqual(wire, ['/G43.1 Z-20.0000', '/Z50.'])
})

test('DRY RUN substitutes every feed with the jog-rate feed — §3.13', () => {
  const lines = prepare('G1 X10 F500\nG1 Y2\nG1 Z-1 F80\nM30')
  assert.deepEqual(wireProgram(lines, { dryRun: true, dryRunFeed: 254 }).wire,
    ['G1 X10 F254', 'G1 Y2', 'G1 Z-1 F254', 'M30'])
  // Without a rate the old behaviour holds — M-strip only.
  assert.deepEqual(wireProgram(lines, { dryRun: true }).wire,
    ['G1 X10 F500', 'G1 Y2', 'G1 Z-1 F80', 'M30'])
})

test('HAAS G51 P translates to the MACH3 factor form; centre forms pass through', () => {
  assert.deepEqual(wireLine('G51 P2', {}), ['G51 X2 Y2 Z2'])
  assert.deepEqual(wireLine('G51 X0 Y0 P2', {}), ['G51 X0 Y0 P2'])  // board's error:36 answers it
})

test('a P-less HAAS G86 gains P0 on the wire — grblHAL requires the dwell word', () => {
  assert.deepEqual(wireLine('G86 Z-2. R1. F500.', {}), ['G86 P0 Z-2. R1. F500.'])
  assert.deepEqual(wireLine('G86 P0.1 Z-2. R1. F500.', {}), ['G86 P0.1 Z-2. R1. F500.'])
})

test('haasNote explains the HAAS meaning of rejected codes, and stays quiet otherwise', () => {
  const { haasNote } = grblNS
  assert.match(haasNote('G12 I0.5 F10'), /pocket milling/i)
  assert.match(haasNote('G41 D1'), /cutter compensation/i)
  assert.match(haasNote('G84 Z-1 R1 F100'), /spindle encoder/)
  assert.match(haasNote('M19'), /orient/i)
  assert.match(haasNote('G154 P44'), /P1-P3/)
  assert.equal(haasNote('G1 X10 F100'), null)
  assert.equal(haasNote('G43.1 Z-5'), null)   // G41/42 regex must not eat G43.x
})

test('a streamed rejected block carries its HAAS note in the halt message', () => {
  const s = new Streamer(() => {}, 1024)
  s.start(['G0 X1', 'G84 Z-1 R1 F100', 'G0 X2'])
  s.onLine('ok')
  s.onLine('error:20')
  assert.match(s.error.text, /rigid tapping needs a spindle encoder/i)
})

test('G44 becomes a negated G43.1, and G110-G112 become G59.1-3', () => {
  assert.deepEqual(wireLine('G44 H3 Z50.', { tools: { 3: -20 } }), ['G43.1 Z20.0000', 'Z50.'])
  assert.deepEqual(wireLine('G111 G0 X1', {}), ['G59.2 G0 X1'])
  assert.deepEqual(wireLine('G113', {}), ['G113'])   // beyond the three: honest error downstream
})

test('a canned-cycle P is sticky across cycle changes until G0/G1/G80, like the manual', () => {
  // Manual p.232: the P carries into later cycles "unless canceled
  // (G00, G01, G80 or the [RESET] button)".
  const lines = prepare(['G82 P0.3 Z-1 R1 F100', 'G86 Z-2 R1 F100', 'G1 X0 F100', 'G89 Z-1 R1 F100', 'M30'].join('\n'))
  const { wire } = wireProgram(lines, {})
  assert.equal(wire[1], 'G86 P0.3 Z-2 R1 F100', 'the G82 P carries onto the P-less G86')
  assert.equal(wire[3], 'G89 P0 Z-1 R1 F100', 'G1 cancelled the sticky — the HAAS default of no dwell applies')
})
