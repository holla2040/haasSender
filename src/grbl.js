// grblHAL wire protocol: parsing, code tables, and job streaming.
// Nothing in here touches the DOM or a transport — it is pure so it can be tested
// under `node --test`.

// ---------------------------------------------------------------- status reports

/**
 * Parse a real-time status report:
 *   <Idle|MPos:1,2,3,4|Bf:100,1023|Ln:187756|FS:0,0|Ov:100,100,100|WCO:0,0,0,0>
 * Returns null for anything that is not a status report.
 */
export function parseStatus (line) {
  if (line.charCodeAt(0) !== 60 /* < */ || line[line.length - 1] !== '>') return null

  const parts = line.slice(1, -1).split('|')
  const [state, sub] = parts[0].split(':')
  const s = { state, sub: sub === undefined ? null : Number(sub) }

  for (let i = 1; i < parts.length; i++) {
    const at = parts[i].indexOf(':')
    if (at < 0) continue
    const key = parts[i].slice(0, at)
    const val = parts[i].slice(at + 1)

    switch (key) {
      case 'MPos': case 'WPos': case 'WCO':
        s[key] = val.split(',').map(Number)
        break
      case 'Bf': {
        const [blocks, bytes] = val.split(',').map(Number)
        s.bf = { blocks, bytes }
        break
      }
      case 'Ln': s.line = Number(val); break
      case 'F': s.feed = Number(val); break
      case 'FS': {
        const [f, rpm] = val.split(',').map(Number)
        s.feed = f; s.spindle = rpm
        break
      }
      case 'Ov': {
        const [feed, rapid, spindle] = val.split(',').map(Number)
        s.ov = { feed, rapid, spindle }
        break
      }
      case 'A': s.accessory = val; break   // S/C spindle dir, F flood, M mist
      case 'Pn': s.pins = val; break       // triggered inputs
    }
  }
  return s
}

/**
 * Parse a bracketed feedback message: [G54:…] [GC:…] [VER:…] [OPT:…] [PRB:…:1]
 * Returns {kind, value} with value already split into numbers where that makes sense.
 */
export function parseFeedback (line) {
  if (line[0] !== '[' || line[line.length - 1] !== ']') return null
  const body = line.slice(1, -1)
  const at = body.indexOf(':')
  if (at < 0) return { kind: body, value: null }

  const kind = body.slice(0, at)
  const rest = body.slice(at + 1)

  // Coordinate-ish reports are comma-separated numbers, sometimes with a trailing
  // :flag (PRB). Everything else stays a string.
  if (/^(G5[4-9](\.[1-3])?|G28|G30|G92|TLO|PRB)$/.test(kind)) {
    const [coords, flag] = rest.split(':')
    const value = coords.split(',').map(Number)
    return flag === undefined ? { kind, value } : { kind, value, ok: flag === '1' }
  }
  return { kind, value: rest }
}

/**
 * Unpack `[OPT:VNML,100,1024,4,0]` — compile flags, planner blocks, RX buffer
 * bytes, axis count. The planner size matters as much as the buffer: it is what
 * lets us work out which block the machine is actually executing, as opposed to
 * which one we have merely sent.
 */
export function parseOpt (optValue) {
  const [, planner, rx, axes] = String(optValue).split(',')
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null)
  return { planner: num(planner), rx: num(rx), axes: num(axes) }
}

/** Pull just the RX buffer size out of an `[OPT:…]` value. */
export const rxBufferFromOpt = (optValue) => parseOpt(optValue).rx

// -------------------------------------------------------------------- offsets

/**
 * The work coordinate systems this control offers, in the order the OFFSET page
 * lists them, with the name a HAAS operator knows them by.
 *
 * The last three are the interesting ones. A HAAS calls them `G154 P1`–`P3` and a
 * student will look for that name; grbl has no `G154`, but grblHAL reports nine
 * coordinate systems and `G59.1`–`G59.3` sit exactly where `G154 P1`–`P3` do. The
 * P-number for writing them was measured on the ClearCore rather than assumed:
 * `G10 L2 P7` moved `G59.1` and `P9` moved `G59.3`.
 *
 * A real HAAS goes on to `G154 P20` and beyond. Showing three and saying so beats
 * drawing twenty rows that cannot be written.
 */
export const WCS = [
  { name: 'G54', report: 'G54', p: 1 },
  { name: 'G55', report: 'G55', p: 2 },
  { name: 'G56', report: 'G56', p: 3 },
  { name: 'G57', report: 'G57', p: 4 },
  { name: 'G58', report: 'G58', p: 5 },
  { name: 'G59', report: 'G59', p: 6 },
  { name: 'G154 P1', report: 'G59.1', p: 7 },
  { name: 'G154 P2', report: 'G59.2', p: 8 },
  { name: 'G154 P3', report: 'G59.3', p: 9 }
]

/**
 * `G10 L2 P<n> <axis><value>` — write one axis of one work offset.
 *
 * L2 sets the offset from machine zero, which is what the OFFSET page edits. The
 * value goes out in the *modal* unit (G20/G21), so a caller holding millimetres
 * from `MPos:` while the control is in inches must convert before calling.
 */
export const setWorkOffset = (p, axis, value) =>
  `G10 L2 P${p} ${axis}${Number(value).toFixed(4)}`

/**
 * DIST TO GO — how far the block under the tool still has to travel, per axis.
 *
 * grbl does not report this, so it is worked out from the block itself: an
 * absolute target, expressed in the modal unit and relative to the active work
 * offset, minus where the machine is now.
 *
 * Returns **null** whenever that cannot be known, and the display shows dashes
 * rather than a number. Two cases: a block with no axis words is not a move, and
 * an incremental one (`G91`) has a target that depends on where the move began,
 * which is not in the block. Guessing either would put a plausible wrong number
 * on the one readout an operator uses to judge whether to reach into the machine.
 *
 * `scale` converts the block's modal unit into the unit `MPos:` arrives in;
 * `wco` shifts the work-coordinate target onto the machine's own axis.
 */
export function distanceToGo (blockText, { mpos, wco = [0, 0, 0, 0], absolute = true, scale = 1 }) {
  if (!blockText || !absolute) return null

  const out = [0, 0, 0, 0]
  let found = false
  'XYZA'.split('').forEach((letter, i) => {
    // A word is the letter and its number — not the letter inside a word like
    // `G91.1`, and not one hiding in what is left of a stripped comment.
    const m = new RegExp(`(?:^|[^A-Za-z0-9.])${letter}\\s*([-+]?(?:\\d+\\.?\\d*|\\.\\d+))`, 'i')
      .exec(blockText)
    if (!m) return
    found = true
    out[i] = (Number(m[1]) * scale + (wco[i] ?? 0)) - (mpos[i] ?? 0)
  })
  return found ? out : null
}

// ------------------------------------------------------------------ code tables

// Only the codes a student can realistically provoke. Unlisted codes fall back to
// "error N" rather than a lie.
export const ERRORS = {
  1: 'G-code words consist of a letter and a value. Letter was not found.',
  2: 'Numeric value format is not valid or missing an expected value.',
  3: 'Grbl $ system command was not recognized or supported.',
  4: 'Negative value received for an expected positive value.',
  5: 'Homing cycle is not enabled via settings.',
  8: 'Grbl $ command cannot be used unless Grbl is IDLE.',
  9: 'G-code locked out during alarm or jog state.',
  10: 'Soft limits cannot be enabled without homing also enabled.',
  11: 'Max characters per line exceeded.',
  15: 'Jog target exceeds machine travel.',
  16: 'Jog command with no = or contains prohibited g-code.',
  17: 'Laser mode requires PWM output.',
  20: 'Unsupported or invalid g-code command found in block.',
  21: 'More than one g-code command from same modal group found in block.',
  22: 'Feed rate has not yet been set or is undefined.',
  23: 'G-code command requires an integer value.',
  24: 'More than one g-code command that requires axis words found in block.',
  25: 'Repeated g-code word found in block.',
  26: 'No axis words found in block for g-code command that requires them.',
  33: 'Motion command target is invalid.',
  34: 'Arc radius value is invalid.',
  36: 'No axis words found in block while no command is present.',
  38: 'Tool number greater than max supported value.'
}

export const ALARMS = {
  1: 'Hard limit triggered. Machine position is likely lost.',
  2: 'Motion target exceeds machine travel. Soft limit.',
  3: 'Reset while in motion. Machine position is likely lost.',
  4: 'Probe fail. Probe is not in the expected initial state.',
  5: 'Probe fail. Probe did not contact the workpiece.',
  6: 'Homing fail. Reset during active homing cycle.',
  7: 'Homing fail. Safety door was opened during homing.',
  8: 'Homing fail. Pull off travel failed to clear limit switch.',
  9: 'Homing fail. Could not find limit switch within search distance.',
  10: 'Homing fail. On dual axis, could not find second limit switch.'
}

export const describeError = (n) => ERRORS[n] || `Unrecognized error ${n}.`
export const describeAlarm = (n) => ALARMS[n] || `Unrecognized alarm ${n}.`

// -------------------------------------------------------------------- streaming

/**
 * Character-counting flow control, the algorithm every working GRBL sender uses.
 *
 * We may have at most `rxBuffer` bytes in the controller's serial RX buffer at any
 * time, and the controller acknowledges each line with `ok` or `error:N`. So we
 * track the byte length of every line sent but not yet acknowledged, and only send
 * the next line while it still fits.
 *
 * `rxBuffer` is deliberately a constructor argument rather than a constant: 128 is
 * safe for classic GRBL, but grblHAL boards are much larger and report their real
 * size in `[OPT:…]` and `Bf:`. Seed it from the board.
 */
export class Streamer {
  constructor (send, rxBuffer = 128) {
    this.send = send
    this.rxBuffer = rxBuffer
    // A front-panel switch, not job state: it survives reset() because an
    // operator who selected SINGLE BLOCK expects the next program to start that
    // way too, exactly as the physical key would.
    this.singleBlock = false
    this.reset()
  }

  reset () {
    this.lines = []
    this.next = 0        // index of the next line to send
    this.acked = 0       // how many lines have been acknowledged
    this.pending = []    // byte lengths of lines in flight, oldest first
    this.inFlight = 0    // sum of `pending`
    this.running = false
    this.error = null
    this.released = 0    // blocks CYCLE START has let through, in single block
  }

  /**
   * SINGLE BLOCK: run one block per CYCLE START.
   *
   * Pipelining is the whole point of the streamer the rest of the time, so this
   * is the one mode that deliberately gives it up — with a single block in flight
   * the machine has finished it before the next one is even sent, which is what
   * makes stepping through a program mean anything.
   */
  release (n = 1) {
    this.released += n
    this.pump()
  }

  get total () { return this.lines.length }
  get done () { return this.acked >= this.lines.length }

  /** `lines` should already be stripped of comments/blanks by the caller. */
  start (lines) {
    this.reset()
    this.lines = lines
    this.running = true
    this.pump()
  }

  stop () {
    this.running = false
  }

  /** Send as many lines as the controller's buffer will currently hold. */
  pump () {
    if (!this.running) return
    while (this.next < this.lines.length) {
      // In single block, hold unless CYCLE START has released a block AND the
      // previous one has been acknowledged. Both halves matter: without the
      // second, one press would send two blocks back to back.
      if (this.singleBlock && (this.released <= 0 || this.pending.length)) return

      const wire = this.lines[this.next] + '\n'

      // A line that cannot fit an empty buffer would stall the job forever. Fail
      // loudly instead: a silently halted stream mid-part is far worse than a
      // refusal the operator can see on the alarm pane.
      if (wire.length >= this.rxBuffer) {
        this.error = {
          code: 11,
          line: this.next + 1,
          text: `Line is ${wire.length} bytes, longer than the controller's ${this.rxBuffer}-byte buffer.`
        }
        this.running = false
        return
      }

      if (this.inFlight + wire.length >= this.rxBuffer) break
      this.send(wire)
      this.pending.push(wire.length)
      this.inFlight += wire.length
      this.next++
      if (this.singleBlock) this.released--
    }
  }

  /**
   * Feed every line the controller sends back. Returns true if the line was an
   * acknowledgement this streamer consumed, so the caller knows not to treat it as
   * ordinary console output.
   */
  onLine (line) {
    if (!this.running) return false

    if (line === 'ok') {
      this.retire()
      this.pump()
      return true
    }
    if (line.startsWith('error:')) {
      const code = Number(line.slice(6))
      this.retire()
      // A rejected line means the rest of the program is no longer trustworthy —
      // stop rather than plough on into a part with a bad block already skipped.
      this.error = { code, line: this.acked, text: describeError(code) }
      this.running = false
      return true
    }
    return false
  }

  retire () {
    const len = this.pending.shift()
    if (len === undefined) return   // stray ok (e.g. from a manual command)
    this.inFlight -= len
    this.acked++
  }
}

/**
 * A HAAS names a program by the O-number on its first meaningful line — `O1234`,
 * displayed and filed as five digits. The `%` that wraps a tape-format file is
 * not it, and neither is a leading comment.
 *
 * Returns null when there is no O-number, which is a normal thing for a file cut
 * by a CAM post that never expected to live in control memory. The caller decides
 * what to call it then; it must not invent one here and pretend it was in the file.
 */
export function parseONumber (text) {
  const first = text.split(/\r?\n/).find(l => l.trim() && l.trim() !== '%')
  const m = first?.trim().match(/^O\s*(\d{1,5})\b/i)
  return m ? 'O' + m[1].padStart(5, '0') : null
}

/**
 * Split a program into the blocks the control *displays*.
 *
 * This is deliberately not the same list as the one that goes on the wire. The
 * program display shows the file as it was written — comments included, slashes
 * included, the O-number line included, because that is what a HAAS shows and
 * what a student is going to edit. Everything that has to come off before a
 * block reaches grbl comes off in `wireProgram`, at CYCLE START.
 *
 * Only two things are dropped, because neither is a block: blank lines, and the
 * `%` that wraps a tape-format file.
 */
export function prepare (text) {
  const out = []
  const raw = text.split(/\r?\n/)
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i].trim()
    if (!line || line === '%') continue
    out.push(line[0] === '/' ? { n: i + 1, text: line, del: true } : { n: i + 1, text: line })
  }
  return out
}

/** Everything in a block that is a note to a human rather than an instruction. */
export const stripComments = (text) =>
  text.replace(/\([^)]*\)/g, ' ').replace(/;.*$/, ' ').replace(/\s{2,}/g, ' ').trim()

/**
 * Turn a prepared program into what actually goes on the wire, given the front
 * panel's run switches. Returns the wire lines and, alongside, the index in
 * `lines` each one came from — because a switch that removes a block would
 * otherwise slide the running-block highlight off the row it belongs to.
 *
 * Every switch here is owned by the sender rather than the controller:
 *
 * - **BLOCK DELETE** skips `/` blocks. Off means the block runs, without its
 *   slash — that is a machine's power-up state, not a convenience.
 * - **OPTION STOP** decides whether `M01` is a stop or a no-op. grbl has no
 *   optional-stop switch of its own, so with the switch off the word is removed
 *   before sending; leaving it in and hoping the firmware ignores it would make
 *   the behaviour depend on which build is on the bench.
 * - **DRY RUN** suppresses spindle start and coolant on — `M3`/`M4`, `M7`/`M8`.
 *   `M5` and `M9` are left alone: a switch meant to make the machine safer must
 *   never strip the commands that turn things *off*.
 */
export function wireProgram (lines, { blockDelete = false, optionStop = false, dryRun = false, tools = {} } = {}) {
  const wire = []
  const rows = []
  const push = (text, row) => { wire.push(text); rows.push(row) }

  lines.forEach((l, i) => {
    if (l.del && blockDelete) return
    let t = stripComments(l.del ? l.text.slice(1) : l.text)

    // The program's own O-number is a name, not a command: a grbl parser answers
    // a bare `O1234` with error:20.
    if (!t || /^O\s*\d{1,5}$/i.test(t)) return

    if (dryRun) t = t.replace(/\bM0*[3478]\b/gi, ' ').trim()
    if (!optionStop) t = t.replace(/\bM0*1\b/gi, ' ').trim()

    // `G43 H<n>` — apply tool n's length offset. This board has no tool table at
    // all (N_TOOLS 0 in its firmware), so the sender owns one and turns the
    // request into grbl's dynamic form.
    //
    // It has to become its own block. A HAAS writes `G43 H1 Z50.` on one line
    // meaning "apply the offset, then rapid to Z50"; folding the offset into that
    // same line would put two Z words in one block and grbl answers error:25.
    if (/\bG43\b(?![.\d])/i.test(t)) {
      const h = /\bH0*(\d+)\b/i.exec(t)
      push(`G43.1 Z${Number(tools[h ? Number(h[1]) : 0] ?? 0).toFixed(4)}`, i)
      t = t.replace(/\bG43\b(?![.\d])/i, ' ').replace(/\bH0*\d+\b/i, ' ').trim()
    }

    t = t.replace(/\s{2,}/g, ' ').trim()
    if (!t) return
    push(t, i)
  })
  return { wire, rows }
}

// ------------------------------------------------------------ word-level edit

/**
 * Split a block into the things a HAAS cursor can land on.
 *
 * The cursor on a real control selects a *word* — an address letter and its
 * value, `X-1.5` or `G01` — not a character. Getting this right is the whole
 * foundation of EDIT: INSERT, ALTER and DELETE all operate on whatever this
 * returns, so a tokeniser that splits `X-1.5` into `X`, `-` and `1.5` makes
 * every one of them wrong in the same way.
 *
 * A comment is one word too. It is a thing on the line an operator wants to
 * select and retype, and treating `(ROUGH PASS)` as five words would be useless.
 */
export function words (block) {
  return String(block ?? '').match(/\([^)]*\)|;.*$|\/|[A-Za-z][-+]?[\d.]*|\S+/g) ?? []
}

/** Put a block back together from its words, with the single spaces a control uses. */
export const joinWords = (list) => list.join(' ').replace(/^\/ /, '/').trim()

/**
 * Replace, insert after, or delete the word at `at`.
 *
 * Returns the new block text. `insert` with `at` past the end appends, which is
 * what INSERT on an empty block has to do.
 */
export function editBlock (block, at, op, value = '') {
  const w = words(block)
  if (op === 'alter') w[at] = value
  else if (op === 'insert') w.splice(at + 1, 0, value)
  else if (op === 'delete') w.splice(at, 1)
  return joinWords(w.filter(x => x !== undefined && x !== ''))
}

/**
 * How many tools the offset table holds.
 *
 * A HAAS mill's table runs to 200. Twenty is what a hobby-class machine with a
 * manual toolchange will ever use, and twenty rows a student can scroll beats two
 * hundred they have to page through to find the four that are measured.
 */
export const TOOL_COUNT = 20

/** Which tool-length offsets a program asks for, so the control can check it has them. */
export function toolsUsed (lines) {
  const used = new Set()
  for (const l of lines) {
    if (!/\bG43\b(?![.\d])/i.test(l.text)) continue
    const h = /\bH0*(\d+)\b/i.exec(l.text)
    used.add(h ? Number(h[1]) : 0)
  }
  return [...used]
}
