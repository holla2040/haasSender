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
 * Strip a raw g-code file down to the lines worth sending: no blanks, no comments,
 * no block-delete lines. Keeps the original 1-based line number alongside each so
 * the program pane can highlight the right row.
 */
export function prepare (text) {
  const out = []
  const raw = text.split(/\r?\n/)
  for (let i = 0; i < raw.length; i++) {
    let line = raw[i]
    line = line.replace(/\([^)]*\)/g, '')   // (inline comments)
    line = line.replace(/;.*$/, '')          // ; trailing comments
    line = line.trim()
    if (!line || line[0] === '/') continue   // blank, or block-delete
    out.push({ n: i + 1, text: line })
  }
  return out
}
