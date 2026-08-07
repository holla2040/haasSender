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
  const [, planner, rx, axes, tools] = String(optValue).split(',')
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null)
  // The trailing field is the firmware's tool table size — 0 on stock builds,
  // 32 on the haasSender branch. It is how the sender knows G43 H is native.
  return { planner: num(planner), rx: num(rx), axes: num(axes), tools: num(tools) }
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

/**
 * What the STUDENT'S code meant, when this stack rejects it. "error 20" is
 * true and teaches nothing; "G12 is Circular Pocket Milling on a HAAS — mill
 * it with G2/G3" is what a student at a real control would eventually work
 * out. One note per family, first match wins, and only codes the 2014 manual
 * documents — this table must never invent a HAAS behaviour.
 */
const HAAS_NOTES = [
  [/\bG0*9\b(?![.\d])/i, 'G09 exact stop: this control always stops between blocks, so the code does not exist here.'],
  [/\bG0*1[23]\b(?![.\d])/i, 'G12/G13 is circular pocket milling on a HAAS. No pocket cycle here — mill it with G2/G3 arcs.'],
  [/\bG4[12]\b(?![.\d])/i, 'G41/G42 cutter compensation does not exist on this control — post the compensated path from CAM.'],
  [/\bG47\b(?![.\d])/i, 'G47 is text engraving on a HAAS. Engrave from CAM toolpaths here.'],
  [/\bG52\b(?![.\d])/i, 'G52 is a temporary work shift on a HAAS. Use G92, or a spare work offset.'],
  [/\bG60\b(?![.\d])/i, 'G60 uni-directional positioning is a HAAS backlash trick — servo axes here do not need it.'],
  [/\bG7[012]\b(?![.\d])/i, 'G70/G71/G72 are HAAS bolt-hole patterns. Not built here yet — program the holes individually.'],
  [/\bG74\b(?![.\d])/i, 'G74 reverse tapping needs a spindle encoder this machine does not have.'],
  [/\bG7[67]\b(?![.\d])/i, 'G76/G77 fine boring cycles are not supported here — use G85/G86.'],
  [/\bG84\b(?![.\d])/i, 'G84 rigid tapping needs a spindle encoder this machine does not have.'],
  [/\bG8[78]\b(?![.\d])/i, 'G87/G88 bore with manual retract — an operator-retract cycle this control does not run.'],
  [/\bG10[01]\b(?![.\d])/i, 'G100/G101 mirror image does not exist here — mirror the part in CAM.'],
  [/\bG103\b(?![.\d])/i, 'G103 block lookahead limiting does not exist here.'],
  [/\bG1(1[3-9]|2\d)\b(?![.\d])/i, 'G113-G129: only three extra work systems exist here — G110, G111 and G112.'],
  [/\bG136\b(?![.\d])/i, 'G136 work-offset probing needs a probe system this machine does not have.'],
  [/\bG14[13]\b(?![.\d])/i, 'G141/G143 are 5-axis compensation — this is a 3+1 axis machine.'],
  [/\bG150\b(?![.\d])/i, 'G150 general pocket milling is not supported — mill the pocket with G1/G2/G3.'],
  [/\bG154\s*P\d+/i, 'G154 P4-P99: only P1-P3 exist here, as G59.1-G59.3.'],
  [/\bG1[5-8]\d\b(?![.\d])/i, 'G153-G188 are 5-axis or option codes this machine does not have.'],
  [/\bM0*1[0-3]\b/i, 'M10-M13 are rotary brake commands — no brake fitted.'],
  [/\bM0*1[78]\b/i, 'M17/M18 are pallet-changer commands — no pallet changer fitted.'],
  [/\bM0*19\b/i, 'M19 orient spindle needs a spindle encoder — nothing here can hold an angle.'],
  [/\bM0*2[1-8]\b/i, 'M21-M28 fire user relays with M-Fin — no such relays are wired.'],
  [/\bM0*3[45]\b/i, 'M34/M35 move the P-Cool spigot — no programmable coolant fitted.'],
  [/\bM0*39\b/i, 'M39 rotates the tool turret — no tool changer fitted.'],
  [/\bM0*4[12]\b/i, 'M41/M42 are spindle gear overrides — this spindle has no gearbox.'],
  [/\bM0*4[89]\b|\bM0*5\d\b/i, 'M48-M59 are program-check, pallet and relay codes this machine does not have.'],
  [/\bM0*6[1-9]\b/i, 'M61-M69 user I/O: every output pin on this controller is already spoken for.'],
  [/\bM0*7[589]\b/i, 'M75/M78/M79 are probing codes — no probe system fitted.'],
  [/\bM0*8[0-7]\b/i, 'M80-M87 drive doors, air guns and tool clamps — none fitted.'],
  [/\bM0*9[56]\b/i, 'M95 sleep / M96 input-jump are not supported on this control.'],
  [/\bM109\b/i, 'M109 interactive input needs the macro system — not built here.']
]

/** The HAAS-aware half of an error message, or null when the line has no story. */
export function haasNote (text) {
  for (const [re, note] of HAAS_NOTES) if (re.test(text ?? '')) return note
  return null
}

/**
 * What actually clears each alarm, which is the half a student needs and the half
 * the grbl tables never print.
 *
 * The control says what to do; it does not do it. `$X` re-enables motion on a
 * machine whose position may be wrong — after a hard limit or a reset in motion,
 * the controller genuinely does not know where the tool is — and a trainer that
 * quietly unlocked for you would be teaching exactly the wrong reflex. A HAAS
 * makes you clear the condition before RESET means anything, and so does this.
 */
export const ALARM_RECOVERY = {
  1: 'Move off the switch by hand, then $X to unlock and $H to re-establish position.',
  2: 'The target was outside machine travel, so nothing moved. $X to unlock, then fix the block or the work offset.',
  3: 'Position is not trustworthy after a reset in motion. $X to unlock, then $H.',
  4: 'Check the probe wiring and its starting state, then $X.',
  5: 'The probe never touched. Check the travel and the probe, then $X.',
  6: 'Homing was interrupted. $X, then $H to start again.',
  7: 'Close the safety door, then $X and $H.',
  8: 'The axis could not pull off its switch. Check the switch and $22 pull-off, then $H.',
  9: 'No limit switch found within the search distance. Check wiring and $23 direction mask, then $H.',
  10: 'The second switch on a dual axis was not found. Check that motor and switch, then $H.'
}

export const describeRecovery = (n) =>
  ALARM_RECOVERY[n] || 'Clear the cause, then $X to unlock. $H re-establishes position.'

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

  /**
   * The SINGLE BLOCK switch. Always set it through here rather than assigning the
   * field, because turning it OFF mid-program has to restart the pipeline.
   *
   * `pump()` runs from `start()`, `release()` and an incoming `ok` — and in single
   * block the last `ok` arrived before the operator touched the key, so nothing
   * would ever send the rest of the program. The job stayed open with the machine
   * idle and CYCLE START answering "already running" forever. Watched on the sim
   * seat, 2026-08-07: a program stepped to block 4, switch off, and the remaining
   * blocks never went out.
   */
  setSingleBlock (on) {
    this.singleBlock = on
    if (!on) this.pump()
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
      // retire() ran, so the failed wire line is the one just retired.
      const note = haasNote(this.lines[this.acked - 1])
      this.error = { code, line: this.acked, text: describeError(code) + (note ? ` ${note}` : '') }
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
 * The same number as a student types it on the keypad, on its own: `O10`,
 * normalised to `O00010`. Two keys take one — SELECT PROGRAM on the LIST page
 * (§3.3.2) and ALTER at the head of the MDI page (§4.2.3 step 3) — and both must
 * agree about what counts as a program number, or the two would file differently.
 *
 * Stricter than parseONumber on purpose: this is a whole typed entry, not the
 * first word of a program, so anything after the digits means the operator typed
 * something else and it must not be taken for a program number.
 */
export function parseOWord (typed) {
  const m = /^O\s*(\d{1,5})$/i.exec(String(typed ?? '').trim())
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

/** A program that cannot be put on the wire faithfully. cycleStart shows the message. */
export class WireError extends Error {}

/**
 * The per-line dialect translation between what a HAAS program says and what
 * this firmware speaks — shared by CYCLE START and MDI, because a typed block
 * and a program block must reach the machine in the same language. Returns the
 * wire lines one source block becomes (usually one; a G43 H split makes two).
 */
export function wireLine (t, { tools = {}, caps = {} } = {}) {
  const out = []

  // HAAS G04: an integer P is milliseconds, a decimal P is seconds — manual
  // p.245: "G04 P10. is a dwell of 10 seconds; G04 P10 is 10 milliseconds".
  // grbl's P is always seconds, so a half-second HAAS dwell would otherwise
  // run for eight minutes. Only G04's P converts: canned-cycle P is stated in
  // seconds by the manual and every example writes it with a decimal.
  if (/\bG0*4\b(?![.\d])/i.test(t)) {
    t = t.replace(/\bP(\d+)(?![.\d])/i, (_, ms) => `P${Number(ms) / 1000}`)
  }

  // HAAS spellings of things grbl spells differently.
  t = t.replace(/\bG31\b(?![.\d])/i, 'G38.2')                    // probe
  t = t.replace(/\bM0*16\b/i, 'M6')                              // M16 = M06 synonym
  t = t.replace(/\bG154\s*P0*([1-3])\b/i, (_, p) => `G59.${p}`)  // P4+ passes through; the board's error is the honest answer
  t = t.replace(/\bG11([0-2])\b(?![.\d])/i, (_, d) => `G59.${Number(d) + 1}`)  // HAAS #7-#9 = the three extra systems; G113+ errors honestly

  // HAAS G44 (tool length MINUS) has no grblHAL form in any mode — it becomes
  // the dynamic offset with the sign flipped, split out like the G43 rewrite.
  if (/\bG44\b(?![.\d])/i.test(t)) {
    const h = /\bH0*(\d+)\b/i.exec(t)
    out.push(`G43.1 Z${(-Number(tools[h ? Number(h[1]) : 0] ?? 0)).toFixed(4)}`)
    t = t.replace(/\bG44\b(?![.\d])/i, ' ').replace(/\bH0*\d+\b/i, ' ')
  }

  // A P-less G82/G86/G89 is legal HAAS (dwell defaults to none) but grblHAL
  // requires P on a cycle change (shared validation, gcode.c:3382) — P0 says
  // what the HAAS block meant. Bench-verified on G86.
  t = t.replace(/\bG0*(8[269])\b(?![.\d])/i, (m, c) => /\bP[\d.]/i.test(t) ? m : `G${c} P0`)

  // HAAS `G51 P<f>` (uniform scale, no centre) → the board's MACH3 form, where
  // the AXIS WORDS are the factors (bench-verified: G51 X2 doubled a G0 X10).
  // A G51 that names a centre point passes through untouched and the board's
  // error:36 answers it — scaling about an arbitrary centre does not exist here.
  if (/\bG0*51\b/i.test(t) && !/\bG0*51\b[^;]*\b[XYZA]/i.test(t)) {
    t = t.replace(/\bG0*51\s*P([\d.]+)/i, (_, f) => `G51 X${f} Y${f} Z${f}`)
  }

  // `G43 H<n>` on a firmware with no tool table becomes grbl's dynamic form,
  // as its own block — folded in, two Z words share a line and grbl answers
  // error:25. With a native tool table (the haasSender branch firmware,
  // detected from [OPT:]'s tool count), G43 H passes through untouched.
  if (!caps.toolTable && /\bG43\b(?![.\d])/i.test(t)) {
    const h = /\bH0*(\d+)\b/i.exec(t)
    out.push(`G43.1 Z${Number(tools[h ? Number(h[1]) : 0] ?? 0).toFixed(4)}`)
    t = t.replace(/\bG43\b(?![.\d])/i, ' ').replace(/\bH0*\d+\b/i, ' ')
  }

  t = t.replace(/\s{2,}/g, ' ').trim()
  if (t) out.push(t)
  return out
}

/**
 * Turn a prepared program into what actually goes on the wire, given the front
 * panel's run switches. Returns the wire lines and, alongside, the index in
 * `lines` each one came from — because a switch that removes a block would
 * otherwise slide the running-block highlight off the row it belongs to.
 *
 * With `caps.runSwitches` (grblHAL, i.e. every current transport) BLOCK DELETE
 * and OPTION STOP belong to the firmware — `/` blocks and `M01` go through on
 * the wire and `$B`/`$O` decide there, which also covers jobs the board runs
 * off its own card. The stripping path below survives for a classic-grbl
 * serial board, the day Web Serial is bench-tested.
 *
 * DRY RUN is the sender's forever: it suppresses spindle start and coolant on
 * (`M3`/`M4`, `M7`/`M8`), never `M5`/`M9` — a switch meant to make the machine
 * safer must not strip the commands that turn things off.
 *
 * Subprograms are expanded here, because a streamed job is a line stream with
 * no file to jump around in: M97 splices the N-block range of this program,
 * M98/G65 inline a program fetched from control memory via `getProgram`.
 * Faults throw WireError with the reason a student needs.
 */
export function wireProgram (lines, {
  blockDelete = false, optionStop = false, dryRun = false, dryRunFeed = 0,
  tools = {}, caps = {}, getProgram = null
} = {}) {
  const wire = []
  const rows = []
  const push = (text, row) => { wire.push(text); rows.push(row) }
  const err = (msg) => { throw new WireError(msg) }

  // First-word N-labels, per program, for M97 local calls.
  const nIndexes = new Map()
  const nIndex = (list) => {
    let ix = nIndexes.get(list)
    if (!ix) {
      ix = new Map()
      list.forEach((l, i) => {
        const m = /^\/?\s*N0*(\d+)\b/i.exec(l.text.trim())
        if (m && !ix.has(Number(m[1]))) ix.set(Number(m[1]), i)
      })
      nIndexes.set(list, ix)
    }
    return ix
  }

  let expanded = 0
  const CAP = 20000        // spliced blocks — a runaway L count stops here, loudly

  // HAAS keeps a canned-cycle P sticky "unless canceled (G00, G01, G80 or
  // RESET)" — manual p.232 — while grblHAL wants a fresh P on every change to
  // G82/G86/G89. Carrying it here makes the board behave like the manual.
  let stickyP = null

  // Walk blocks from `start`; inside a sub, M99 returns. `rowOverride` pins the
  // highlight to the calling block when the spliced lines are another program's.
  const emitFrom = (list, start, depth, rowOverride, inSub) => {
    for (let i = start; i < list.length; i++) {
      const l = list[i]
      if (++expanded > CAP) err('program too large after subprogram expansion')

      if (l.del && blockDelete && !caps.runSwitches) continue
      // Under native switches the slash stays on the wire for $B to judge —
      // but it comes off before the transforms and back onto EVERY line the
      // block becomes, or a block-deleted G43 H split would apply its offset
      // from an unslashed G43.1 line while $B skipped the rest.
      const slashed = caps.runSwitches && l.del
      let t = stripComments(l.del ? l.text.slice(1) : l.text)
      if (!t || /^O\s*\d{1,5}$/i.test(t)) continue

      if (dryRun) {
        t = t.replace(/\bM0*[3478]\b/gi, ' ').trim()
        // §3.13: dry-run feeds run at the jog-speed-button rate — the bottom
        // legend of the increment keys. Every F is substituted so the program's
        // own feeds never apply. Rapids stay rapids (divergence, said in HELP):
        // grbl has no rapid-rate word, only the 25/50/100% override.
        if (dryRunFeed > 0) t = t.replace(/\bF[\d.]+/gi, `F${dryRunFeed}`).trim()
      }
      if (!optionStop && !caps.runSwitches) t = t.replace(/\bM0*1\b/gi, ' ').trim()
      if (!t) continue

      if (/\bM0*99\b/i.test(t)) {
        if (inSub) return
        err('M99 loops the program forever — run it from the machine card (DNC) instead of streaming')
      }

      const sub = /\b(?:M0*9([78])|G0*65)\b/i.exec(t)
      if (sub) {
        if (depth >= 4) err('subprograms nested deeper than 4 levels')
        const p = /\bP0*(\d+)/i.exec(t)
        if (!p) err(`${sub[0].toUpperCase()} without a P word`)
        const reps = Number((/\bL0*(\d+)/i.exec(t) || [])[1] ?? 1)
        if (sub[1] === '7') {                       // M97: N-label in this program
          const at = nIndex(list).get(Number(p[1]))
          if (at === undefined) err(`M97 P${p[1]}: no block N${p[1]} in this program`)
          for (let k = 0; k < reps; k++) emitFrom(list, at, depth + 1, rowOverride, true)
        } else {                                    // M98 / G65: program from memory
          if (/G0*65/i.test(sub[0])) {
            const rest = t.replace(/\bG0*65\b/i, '').replace(/\bP0*\d+/i, '').replace(/\bL0*\d+/i, '').trim()
            if (rest) err('G65 macro arguments (#variables) are not supported when streaming — run it from the machine card')
          }
          const prog = getProgram?.(Number(p[1]))
          if (!prog) err(`P${p[1]}: program O${String(p[1]).padStart(5, '0')} is not in memory`)
          for (let k = 0; k < reps; k++) emitFrom(prog, 0, depth + 1, rowOverride ?? i, true)
        }
        continue                                    // the call itself sends nothing
      }

      if (/\bG0*(73|8[1-9])\b(?![.\d])/i.test(t)) {
        const p = /\bP([\d.]+)/i.exec(t)
        if (p) stickyP = p[1]
        else if (stickyP !== null) t = t.replace(/\bG0*(8[269])\b(?![.\d])/i, (_, c) => `G${c} P${stickyP}`)
      } else if (/\bG0*[01]\b(?![.\d])|\bG80\b(?![.\d])/i.test(t)) stickyP = null

      for (const out of wireLine(t, { tools, caps })) push(slashed ? '/' + out : out, rowOverride ?? i)

      // M30/M02 end the program: nothing after them streams — which is also
      // what hides the M97 subprogram bodies the manual places after the M30.
      if (!inSub && /\bM0*(2|30)\b/i.test(t)) return
    }
    if (inSub) err('subprogram ran off the end of the program without an M99')
  }

  emitFrom(lines, 0, 0, null, false)
  return { wire, rows }
}

// --------------------------------------------------------------- modal state

/**
 * What each modal code means, and which group it belongs to.
 *
 * `$G` hands back one flat string — `G0 G54 G17 G21 G90 G94 G49 G98 M5 M9 T0 F600
 * S1000.` — which is exactly the information a HAAS breaks out on its CURRENT
 * COMMANDS page and far more use broken out. A student who cannot yet read a
 * modal string can still read "DISTANCE  G90  absolute".
 *
 * Only codes grbl actually reports are listed. Padding this with the rest of the
 * g-code standard would put codes on the screen this machine will never say.
 */
const MODAL = {
  G0: ['MOTION', 'rapid positioning'],
  G1: ['MOTION', 'linear feed'],
  G2: ['MOTION', 'clockwise arc'],
  G3: ['MOTION', 'counter-clockwise arc'],
  'G38.2': ['MOTION', 'probe toward, stop on contact'],
  G80: ['MOTION', 'canned cycle cancelled'],
  G54: ['WORK OFFSET', 'work coordinate system 1'],
  G55: ['WORK OFFSET', 'work coordinate system 2'],
  G56: ['WORK OFFSET', 'work coordinate system 3'],
  G57: ['WORK OFFSET', 'work coordinate system 4'],
  G58: ['WORK OFFSET', 'work coordinate system 5'],
  G59: ['WORK OFFSET', 'work coordinate system 6'],
  'G59.1': ['WORK OFFSET', 'G154 P1 on a HAAS'],
  'G59.2': ['WORK OFFSET', 'G154 P2 on a HAAS'],
  'G59.3': ['WORK OFFSET', 'G154 P3 on a HAAS'],
  G17: ['PLANE', 'XY'],
  G18: ['PLANE', 'ZX'],
  G19: ['PLANE', 'YZ'],
  G20: ['UNITS', 'inch'],
  G21: ['UNITS', 'millimetre'],
  G90: ['DISTANCE', 'absolute'],
  G91: ['DISTANCE', 'incremental'],
  G93: ['FEED MODE', 'inverse time'],
  G94: ['FEED MODE', 'units per minute'],
  G95: ['FEED MODE', 'units per revolution'],
  G43: ['TOOL LENGTH', 'offset applied'],
  'G43.1': ['TOOL LENGTH', 'dynamic offset applied'],
  G49: ['TOOL LENGTH', 'cancelled'],
  G98: ['RETURN LEVEL', 'to initial point'],
  G99: ['RETURN LEVEL', 'to R point'],
  G50: ['SCALING', 'cancelled'],
  G51: ['SCALING', 'active'],
  M0: ['PROGRAM', 'stop'],
  M1: ['PROGRAM', 'optional stop'],
  M2: ['PROGRAM', 'end'],
  M30: ['PROGRAM', 'end and rewind'],
  M3: ['SPINDLE', 'on, clockwise'],
  M4: ['SPINDLE', 'on, counter-clockwise'],
  M5: ['SPINDLE', 'off'],
  M7: ['COOLANT', 'mist'],
  M8: ['COOLANT', 'flood'],
  M9: ['COOLANT', 'off']
}

const MODAL_ORDER = ['MOTION', 'WORK OFFSET', 'PLANE', 'DISTANCE', 'UNITS',
  'FEED MODE', 'TOOL LENGTH', 'RETURN LEVEL', 'SCALING', 'SPINDLE', 'COOLANT',
  'PROGRAM', 'TOOL', 'FEED', 'SPEED']

/**
 * Break a `$G` modal string into named groups for the CURRENT COMMANDS page.
 *
 * A code grbl reports that is not in the table above still gets a row, under its
 * own code and with no description — better a row saying "the machine says G61
 * and this control does not know what that is" than a code silently dropped off a
 * page whose whole job is to say what is active.
 */
export function modalGroups (modal) {
  const rows = new Map()
  for (const tok of String(modal ?? '').trim().split(/\s+/).filter(Boolean)) {
    const word = tok.replace(/\.$/, '')                 // grbl prints `S0.`
    const wordy = { T: 'TOOL', F: 'FEED', S: 'SPEED' }[word[0]]
    if (wordy && /^[TFS][\d.]+$/.test(word)) {
      rows.set(wordy, { group: wordy, code: word, meaning: '' })
      continue
    }
    const known = MODAL[word]
    rows.set(known ? known[0] : word, {
      group: known ? known[0] : '?',
      code: word,
      meaning: known ? known[1] : 'not known to this control'
    })
  }
  return [...rows.values()].sort((a, b) => {
    const ai = MODAL_ORDER.indexOf(a.group); const bi = MODAL_ORDER.indexOf(b.group)
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi)
  })
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
