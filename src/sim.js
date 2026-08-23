// A virtual grblHAL that speaks the same wire protocol as the real board, so a
// classroom seat needs no hardware and every pane of the pendant can be exercised.
//
// ponytail: no acceleration planner and no lookahead — position is interpolated
// linearly along each move at the programmed feedrate. That is indistinguishable
// from the real thing for teaching the operator workflow, and wrong the moment you
// care about corner rounding or actual cycle times. The upgrade path is to compile
// grblHAL itself to WebAssembly and drop it in behind the same transport interface.

const AXES = ['X', 'Y', 'Z', 'A']
const PLANNER = 100        // blocks, matches the ClearCore's [OPT:…,100,…]
const RX_FREE = 1023       // bytes, matches its Bf: report
const TICK_MS = 20
const MAX_DT = 0.25        // seconds of motion any single tick may apply
const REPORT_MS = 250      // matches $397=250 on the real board

const zero = () => [0, 0, 0, 0]
const MOVING = new Set(['Run', 'Home', 'Jog'])

// What the haasSender-branch ClearCore build accepts. The sim's contract is:
// reject what the board rejects, with the board's error numbers — a classroom
// seat must never execute something the bench errors on, and vice versa.
const G_SUPPORTED = new Set([
  0, 1, 2, 3, 4, 10, 17, 18, 19, 20, 21, 28, 30, 40, 43, 43.1, 43.2, 49,
  50, 51, 53, 54, 55, 56, 57, 58, 59, 59.1, 59.2, 59.3, 61,
  73, 80, 81, 82, 83, 85, 86, 89, 90, 91, 92, 92.1, 93, 94, 98, 99
])
const M_SUPPORTED = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 30, 31, 33, 88, 89])
const MOTION_GROUP = new Set([0, 1, 2, 3, 73, 80, 81, 82, 83, 85, 86, 89])
const CYCLES = new Set([73, 81, 82, 83, 85, 86, 89])
const N_SIM_TOOLS = 32     // matches N_TOOLS on the branch firmware

/**
 * Every point the tool would pass through, without running the clock.
 *
 * The planner queue already holds the whole program as targets — that IS the
 * polyline — so a preview costs one pass over the blocks instead of a simulated
 * cycle time. Points are `[x, y, rapid]` in machine millimetres, starting at
 * machine zero because that is where the machine starts.
 *
 * `err` is the first line the simulator refused with, or null. A rejected block
 * stops the drawing there, which is the honest picture: the machine would not
 * have gone any further either.
 *
 * `seconds` is the same walk with a clock held against it: every step's length
 * over its own rate, plus the dwells. It is what this simulator's cycle would
 * take at 100% override, which makes it a floor and not a cycle time — there is
 * no acceleration here (see the note at the top of this file), so every corner
 * and every arc chord is taken at full feed. Setting 1001 is where the operator
 * corrects it against the machine they actually have.
 */
export function toolPath (wire, opts) {
  const m = new VirtualGrbl(opts)
  let err = null
  m.onLine(l => { if (!err && /^(error:|ALARM:)/.test(l)) err = l })

  const pts = [[0, 0, true]]
  let at = zero()                // all four axes: the clock below counts what tick() counts
  let seconds = 0
  let seen = 0                   // blocks already taken off the planner
  const harvest = () => {
    for (; seen < m.queue.length; seen++) {
      const b = m.queue[seen]
      for (const step of b.path ?? [{ target: b.target, rate: b.rate, rapid: b.rapid }]) {
        if (step.dwell !== undefined) { seconds += step.dwell; continue }
        if (!step.target) continue
        // Deliberately the same distance and the same rate tick() uses, so the
        // estimate cannot disagree with the clock this simulator would run.
        if (step.rate > 0) {
          seconds += Math.hypot(...step.target.map((t, i) => t - at[i])) / (step.rate / 60)
        }
        at = step.target
        pts.push([step.target[0], step.target[1], !!step.rapid])
      }
    }
  }

  // A block at a time, and read the planner after each one. An alarm FLUSHES the
  // planner, exactly as it does on the machine, so a program that runs off the
  // table would otherwise erase the drawing that shows where it did it. The
  // queue is never spliced: `plannedEnd()` reads it to find where the last move
  // left the tool, and emptying it would restart every block from machine zero.
  for (const line of wire) {
    m.write(line + '\n')
    m.drain()                    // the outbox is only delivered on a drain
    harvest()
    if (err) break
  }
  return { pts, err, blocks: seen, seconds }
}

export class VirtualGrbl {
  constructor ({ rapidRate = 5000, maxTravel = [500, 400, 300, 360] } = {}) {
    this.rapidRate = rapidRate          // mm/min
    this.maxTravel = maxTravel
    this.outbox = []
    this.onLineCb = () => {}
    this.reset(true)
    // Survives soft reset, like the board: the tool table is NVS-backed and the
    // $B/$S/$O switches are sys flags a 0x18 does not clear.
    this.tools = new Map()              // tool id -> { z, r }
    // The handful of `$$` settings the PARAMETER page and the sender actually
    // read. $130-$133 are NOT here: they are `maxTravel`, which the soft-limit
    // check already owns, and two copies of the envelope would drift apart.
    // ponytail: stored, not obeyed — writing $20=0 will not disable soft limits
    // here, nor $13=1 switch reports to inches. Wire one up when a lesson needs it.
    this.settings = {
      13: 0, 20: 0, 21: 0, 22: 0, 30: 24000, 31: 0, 32: 0,
      110: 5000, 111: 5000, 112: 5000, 113: 3000
    }
    this.blockDelete = false
    this.singleBlock = false
    this.optStopDisabled = false
    this.timer = null
    this.reportTimer = null
  }

  reset (hard) {
    this.state = 'Idle'
    this.mpos = hard ? zero() : this.mpos
    this.queue = []                     // planned moves
    this.current = null
    this.owedOks = 0                    // oks deferred because the planner was full
    this.feed = 0                       // programmed F, mm/min
    this.spindle = 0
    this.commandedRpm = 0               // last S word, applied when the spindle runs
    this.spindleDir = 0                 // 0 off, 1 cw, -1 ccw
    this.flood = false
    this.mist = false
    this.absolute = true                // G90
    this.inches = false                 // G21 default, matches $13=0
    this.wcs = 0                        // index into offsets, G54 == 0
    this.offsets = Array.from({ length: 9 }, zero)
    this.g92 = zero()
    this.tloZ = 0                       // active tool length offset, mm
    this.motionMode = 0
    this.plane = 0                      // G17 XY; 1 is G18 ZX, 2 is G19 YZ
    this.invTime = false                // G93
    this.retract98 = true               // G98 initial-point return
    this.cycle = null                   // sticky canned-cycle state
    this.scaling = null                 // G51 { center, factors }
    this.pendingTool = 0                // T word; becomes active on M6
    this.tool = 0
    this.dwellRemaining = 0
    this.line = 0
    this.alarm = null
    this.ov = { feed: 100, rapid: 100, spindle: 100 }
  }

  onLine (cb) { this.onLineCb = cb }

  /**
   * Output is buffered, never delivered on the caller's stack.
   *
   * A real controller answers over a wire, so its `ok` can never arrive inside the
   * send that provoked it. Emitting synchronously here made the streamer recurse
   * (pump -> send -> ok -> pump) until the stack blew, and would also have let UI
   * code depend on ordering that real hardware never provides.
   */
  emit (line) { this.outbox.push(line) }

  drain () {
    if (!this.outbox.length) return
    const queued = this.outbox
    this.outbox = []                    // anything emitted during delivery lands here
    for (const line of queued) this.onLineCb(line)
  }

  start () {
    this.emit("GrblHAL 1.1f ['$' or '$HELP' for help]")

    // Advance by real elapsed time, not by a fixed slice per tick. Browsers throttle
    // timers in background tabs — assuming the nominal interval made the machine
    // crawl at a fortieth of the programmed feedrate whenever the tab lost focus.
    // MAX_DT then stops a long pause from teleporting the tool across the table on
    // the first tick back.
    let last = performance.now()
    this.timer = setInterval(() => {
      const now = performance.now()
      const dt = Math.min((now - last) / 1000, MAX_DT)
      last = now
      this.tick(dt)
      this.drain()
    }, TICK_MS)

    this.reportTimer = setInterval(() => this.emit(this.statusReport()), REPORT_MS)
  }

  stop () {
    clearInterval(this.timer)
    clearInterval(this.reportTimer)
    this.timer = this.reportTimer = null
  }

  // ------------------------------------------------------------------ incoming

  write (chunk) {
    for (const raw of chunk.split('\n')) {
      const line = raw.trim()
      if (line) this.exec(line)
    }
  }

  realtime (byte) {
    switch (byte) {
      case 0x3F: this.emit(this.statusReport()); return          // ?
      // Soft reset. grbl's mc_reset: abandoning a cycle mid-move leaves the
      // controller no longer knowing where the tool is, so it comes back up
      // latched in ALARM:3 instead of answering. The latch also SURVIVES the
      // next 0x18 — a reset cannot restore a position it never knew, so the
      // alarm comes straight back and only `$X` opens it.
      case 0x18: {
        const latched = MOVING.has(this.state) || this.current ? 3 : this.alarm
        this.reset(false)
        if (latched) return this.raiseAlarm(latched)
        this.emit('ok'); return
      }
      case 0x21: if (this.state === 'Run') this.state = 'Hold'; return   // !
      case 0x7E: if (this.state === 'Hold') this.state = 'Run'; return   // ~
      case 0x85: this.cancelJog(); return

      case 0x90: this.ov.feed = 100; return
      case 0x91: this.ov.feed = Math.min(200, this.ov.feed + 10); return
      case 0x92: this.ov.feed = Math.max(10, this.ov.feed - 10); return
      case 0x93: this.ov.feed = Math.min(200, this.ov.feed + 1); return
      case 0x94: this.ov.feed = Math.max(10, this.ov.feed - 1); return

      case 0x95: this.ov.rapid = 100; return
      case 0x96: this.ov.rapid = 50; return
      case 0x97: this.ov.rapid = 25; return

      case 0x99: this.ov.spindle = 100; return
      case 0x9A: this.ov.spindle = Math.min(200, this.ov.spindle + 10); return
      case 0x9B: this.ov.spindle = Math.max(10, this.ov.spindle - 10); return
      case 0x9C: this.ov.spindle = Math.min(200, this.ov.spindle + 1); return
      case 0x9D: this.ov.spindle = Math.max(10, this.ov.spindle - 1); return
      case 0x9E: if (this.state === 'Hold') this.spindleDir = 0; return

      case 0xA0: this.flood = !this.flood; return
      case 0xA1: this.mist = !this.mist; return

      // The firmware's own run-switch toggles: 0x88 optional stop, 0x89 single
      // block. There is no realtime byte for block delete — $B only, like the board.
      case 0x88: this.optStopDisabled = !this.optStopDisabled; return
      case 0x89: this.singleBlock = !this.singleBlock; return
    }
  }

  exec (line) {
    if (this.alarm && !/^\$(X|H)/.test(line)) {
      this.emit('error:9')        // locked out during alarm
      return
    }
    if (line[0] === '$') return this.system(line)
    if (line[0] === '/') {
      // Block delete: with $B on the parser skips the line; off, the slash is
      // simply consumed and the block runs — the firmware's exact behaviour.
      if (this.blockDelete) return this.emit('ok')
      line = line.slice(1)
      if (!line) return this.emit('ok')
    }
    this.gcode(line)
  }

  // ------------------------------------------------------------ system commands

  system (line) {
    if (line.startsWith('$J=')) return this.jog(line.slice(3))

    // A settings write, `$30=5000`. Answered with a bare `ok` and no echo, like
    // the board — the client is expected to re-read `$$` to see what took.
    const write = line.match(/^\$(\d+)=(.*)$/)
    if (write) {
      const n = Number(write[1])
      // $130-$133 ARE the soft-limit envelope, so writing one has to move it,
      // not just change what `$$` prints. A junk value must never reach it: the
      // limit check is `Math.abs(v) > maxTravel[i]`, and that is false for every
      // v once the bound is NaN — `$130=abc` would quietly switch off X's soft
      // limit for the rest of the session, which is the opposite of a safe seat.
      const mm = Number(write[2])
      if (n >= 130 && n <= 133) { if (Number.isFinite(mm)) this.maxTravel[n - 130] = mm }
      else this.settings[n] = write[2].trim()
      return this.emit('ok')
    }

    switch (line) {
      case '$I':
        this.emit('[VER:1.1f.haasSender-sim:]')
        this.emit(`[OPT:VNML,${PLANNER},${RX_FREE + 1},4,${N_SIM_TOOLS}]`)
        this.emit('[NEWOPT:EXPR]')
        this.emit('[AXS:4:XYZA]')
        this.emit('[FIRMWARE:grblHAL]')
        this.emit('[PLUGIN:HAAS parity v0.2]')
        return this.emit('ok')

      case '$#':
        this.offsets.forEach((o, i) => this.emit(`[${wcsName(i)}:${fmt(o)}]`))
        this.emit(`[G28:${fmt(zero())}]`)
        this.emit(`[G30:${fmt(zero())}]`)
        this.emit(`[G92:${fmt(this.g92)}]`)
        this.emit(`[TLO:${fmt([0, 0, this.tloZ, 0])}]`)
        // Tool table rows, the branch firmware's exact habit (bench 2026-08-07):
        // ALL rows print, unset tools as zeros — the client must not read a
        // zero row as a measured length.
        for (let id = 1; id <= N_SIM_TOOLS; id++) {
          const t = this.tools.get(id) ?? {}
          this.emit(`[T:${id}|${fmt([t.x ?? 0, t.y ?? 0, t.z ?? 0, 0])}|${(t.r ?? 0).toFixed(3)}|6,0,0||${id}]`)
        }
        this.emit(`[PRB:${fmt(zero())}:0]`)
        return this.emit('ok')

      case '$G': {
        const cyc = this.cycle && CYCLES.has(this.motionMode) ? this.motionMode : (this.motionMode ?? 0)
        this.emit(`[GC:G${cyc} ${wcsName(this.wcs)} G17 ` +
          `${this.inches ? 'G20' : 'G21'} ${this.absolute ? 'G90' : 'G91'} ` +
          `${this.invTime ? 'G93' : 'G94'} ${this.tloZ ? 'G43.1' : 'G49'} ` +
          `${this.retract98 ? 'G98' : 'G99'} ` +
          `M${this.spindleDir === 0 ? 5 : this.spindleDir > 0 ? 3 : 4} ` +
          `M${this.flood ? 8 : 9} T${this.tool} F${this.feed} S${this.spindle}]`)
        return this.emit('ok')
      }

      case '$13': this.emit(`$13=${this.settings[13]}`); return this.emit('ok')

      // The firmware's own run switches. $B is idle-only there and here.
      case '$B':
        if (this.state !== 'Idle') return this.emit('error:9')
        this.blockDelete = !this.blockDelete
        return this.emit('ok')
      case '$S':
        this.singleBlock = !this.singleBlock
        return this.emit('ok')
      case '$O':
        this.optStopDisabled = !this.optStopDisabled
        return this.emit('ok')

      case '$$':
        for (const [k, v] of [...Object.entries(this.settings),
          [130, this.maxTravel[0]], [131, this.maxTravel[1]],
          [132, this.maxTravel[2]], [133, this.maxTravel[3]]]) {
          this.emit(`$${k}=${v}`)
        }
        return this.emit('ok')

      case '$H':
        this.alarm = null
        this.state = 'Home'
        this.queue = []
        this.current = null
        // Homing parks at machine zero. Real homing is a search; this is a move.
        this.queue.push({ target: zero(), rate: this.rapidRate, rapid: true, n: ++this.line })
        return this.emit('ok')

      case '$X':
        this.alarm = null
        this.state = 'Idle'
        this.emit('[MSG:Caution: Unlocked]')
        return this.emit('ok')

      default:
        return this.emit('ok')
    }
  }

  // ------------------------------------------------------------------- g-code

  gcode (line) {
    const words = line.toUpperCase().match(/([A-Z])\s*(-?[\d.]+)/g) || []
    if (!words.length) return this.emit('ok')

    // Collect the WHOLE block first, then validate, then apply — grbl rejects a
    // block before any of it takes effect, and the target must be resolved under
    // the block's FINAL distance mode. (Resolving as-you-go seeded an absolute
    // target and applied it incrementally, doubling every unmentioned axis.)
    const g = [], m = []
    const axis = new Map()               // axis index -> typed value
    const w = new Map()                  // other letters -> value
    for (const token of words) {
      const letter = token[0]
      const value = Number(token.slice(1).trim())
      if (letter === 'G') g.push(value)
      else if (letter === 'M') m.push(value)
      else {
        const ai = AXES.indexOf(letter)
        if (ai >= 0) axis.set(ai, value)
        else w.set(letter, value)
      }
    }

    // Reject like the board rejects, before any state changes.
    for (const v of g) if (!G_SUPPORTED.has(v)) return this.emit('error:20')
    for (const v of m) if (!M_SUPPORTED.has(v)) return this.emit('error:20')
    if (w.has('D')) return this.emit('error:20')          // no cutter comp
    const motions = g.filter(v => MOTION_GROUP.has(v))
    if (motions.length > 1) return this.emit('error:21')

    // Snapshot the parser state a failing block must not half-apply.
    const snap = {
      inches: this.inches, absolute: this.absolute, wcs: this.wcs,
      tloZ: this.tloZ, invTime: this.invTime, retract98: this.retract98,
      motionMode: this.motionMode, feed: this.feed, g92: [...this.g92], plane: this.plane,
      scaling: this.scaling, cycle: this.cycle ? { ...this.cycle } : null,
      pendingTool: this.pendingTool
    }
    const fail = (code) => { Object.assign(this, snap, { g92: snap.g92 }); return this.emit(code) }

    // Value words are read before being claimed; anything left unclaimed at the
    // end is error:36, exactly as the firmware answers.
    const fWord = w.has('F') ? w.get('F') : null
    const sWord = w.has('S') ? w.get('S') : null
    const tWord = w.has('T') ? Math.round(w.get('T')) : null
    w.delete('F'); w.delete('S'); w.delete('N'); w.delete('T')

    // Units and distance mode are block-modal: they govern every value in this
    // block no matter where they sit in it.
    const inch = g.includes(20) ? true : g.includes(21) ? false : this.inches
    const abs = g.includes(91) ? false : g.includes(90) ? true : this.absolute
    const conv = (v) => inch ? v * 25.4 : v
    for (const v of g) {
      if (v === 20) this.inches = true
      else if (v === 21) this.inches = false
      else if (v === 90) this.absolute = true
      else if (v === 91) this.absolute = false
      else if (v === 17) this.plane = 0
      else if (v === 18) this.plane = 1
      else if (v === 19) this.plane = 2
      else if (v === 93) this.invTime = true
      else if (v === 94) this.invTime = false
      else if (v === 98) this.retract98 = true
      else if (v === 99) this.retract98 = false
      else if (v >= 54 && v <= 59) this.wcs = Math.round(v) - 54
      else if (v === 59.1 || v === 59.2 || v === 59.3) this.wcs = 6 + Math.round((v - 59.1) * 10)
    }
    if (fWord !== null) this.feed = conv(fWord)
    if (tWord !== null) {
      if (tWord < 0 || tWord > N_SIM_TOOLS) return fail('error:20')
      this.pendingTool = tWord
    }

    const wco = this.offsets[this.wcs]
    const g53 = g.includes(53)
    // work -> machine on this block: WCS + G92 shift + tool length on Z.
    const toMach = (i, v) =>
      g53 ? conv(v) : conv(v) + wco[i] + this.g92[i] + (i === 2 ? this.tloZ : 0)

    const effects = []
    const path = []

    // ---- offsets, TLO and the tool table (parse-time, like a synced write) --

    if (g.includes(10)) {
      const l = w.has('L') ? Math.round(w.get('L')) : null
      const p = w.has('P') ? Math.round(w.get('P')) : null
      w.delete('L'); w.delete('P')
      if (l === 2) {
        if (w.has('R')) return fail('error:20') // no G10 L2 rotation in the simulator
        if (p === null || p < 0 || p > 9) return fail('error:20')
        const row = this.offsets[p === 0 ? this.wcs : p - 1]
        for (const [i, v] of axis) row[i] = conv(v)   // G10 L2 values are machine coords
        axis.clear()
      } else if (l === 1) {
        if (w.has('R')) return fail('error:20') // grbl radius maintenance is not student-facing HAAS syntax
        if (p === null || p < 1 || p > N_SIM_TOOLS) return fail('error:20')
        const t = this.tools.get(p) ?? {}
        for (const [i, v] of axis) t[AXES[i].toLowerCase()] = conv(v)
        this.tools.set(p, t)
        axis.clear()
      } else if (l === 10) {
        if (p === null || p < 1 || p > N_SIM_TOOLS || !w.has('R') || axis.size) return fail('error:20')
        const t = this.tools.get(p) ?? {}
        t.z = conv(w.get('R'))
        w.delete('R')
        this.tools.set(p, t)
      } else
        return fail('error:20')
    }

    // G49 is deferred to after this block's targets are computed: on the bench,
    // `G49 G0 Z10.` moved to work Z10 under the OLD offset (machine -15.4 with
    // TLO -25.4) — cancellation touches the NEXT block, while G43 H in a block
    // DOES shift that block's own move (PLAN.md: G43 H3 Z50. landed at 30.000).
    const g49 = g.includes(49)
    if (g.includes(43)) {                        // native tool-table TLO, branch firmware
      if (!w.has('H')) return fail('error:28')
      const h = Math.round(w.get('H')); w.delete('H')
      if (h < 0 || h > N_SIM_TOOLS) return fail('error:20')
      this.tloZ = h === 0 ? 0 : (this.tools.get(h)?.z ?? 0)
    }
    if (g.includes(43.2)) {
      if (!w.has('H')) return fail('error:28')
      const h = Math.round(w.get('H')); w.delete('H')
      if (h < 1 || h > N_SIM_TOOLS) return fail('error:20')
      this.tloZ += this.tools.get(h)?.z ?? 0
    }
    if (g.includes(43.1)) {
      if (!axis.has(2)) return fail('error:28')
      this.tloZ = conv(axis.get(2)); axis.delete(2)
    }

    if (g.includes(92.1)) this.g92 = zero()
    if (g.includes(92)) {
      const base = this.plannedEnd()
      for (const [i, v] of axis)
        this.g92[i] = base[i] - wco[i] - (i === 2 ? this.tloZ : 0) - conv(v)
      axis.clear()
    }

    if (g.includes(51)) {
      // MACH3 scaling, bench-verified 2026-08-07: the AXIS WORDS are the
      // factors and scaling is about work zero — at X0, `G51 X2` then
      // `G0 X10` landed at MPos 20.000. HAAS's center+P form answers
      // error:36 on the board (P is an unused word there), and does here.
      if (!axis.size) return fail('error:28')
      const factors = [1, 1, 1, 1]
      for (const [i, v] of axis) factors[i] = v
      axis.clear()
      this.scaling = { factors }
    }
    if (g.includes(50)) this.scaling = null

    // scale a WORK-coordinate value / an incremental delta, about work zero
    const scaleAbs = (i, v) => this.scaling ? v * this.scaling.factors[i] : v
    const scaleInc = (i, d) => this.scaling ? d * this.scaling.factors[i] : d

    // ---- G28/G30: rapid home via optional intermediate point ----------------

    if (g.includes(28) || g.includes(30)) {
      const selected = [...axis.keys()]
      let finalBase = this.plannedEnd()
      if (axis.size) {
        finalBase = finalBase.map((v, i) => !axis.has(i) ? v
          : abs ? toMach(i, scaleAbs(i, axis.get(i))) : v + conv(scaleInc(i, axis.get(i))))
        path.push({ target: finalBase, rate: this.rapidRate, rapid: true })
      }
      axis.clear()
      if (g.includes(28)) {
        // HAAS G28 cancels tool length after the optional intermediate leg and
        // returns only named axes (all axes when none are named) to machine zero.
        path.push({ effect: () => { this.tloZ = 0 } })
        const home = selected.length ? selected : [0, 1, 2, 3]
        const target = finalBase.map((v, i) => home.includes(i) ? 0 : v)
        path.push({ target, rate: this.rapidRate, rapid: true })
      } else {
        path.push({ target: zero(), rate: this.rapidRate, rapid: true })
      }
    }

    // ---- dwell --------------------------------------------------------------

    if (g.includes(4)) {                        // P is SECONDS here, like the board;
      if (!w.has('P')) return fail('error:28')  // the sender translates HAAS integer-ms
      path.push({ dwell: Math.max(0, w.get('P')) })
      w.delete('P')
    }

    // ---- canned cycles ------------------------------------------------------

    const cycleCode = motions.find(v => CYCLES.has(v))
    if (g.includes(80)) { this.cycle = null; this.motionMode = 80 }

    if (cycleCode !== undefined || (this.cycle && axis.size && !motions.length && !g.includes(28) && !g.includes(30))) {
      if (cycleCode !== undefined) this.motionMode = cycleCode
      const c = this.cycle = {
        code: cycleCode ?? this.cycle.code,
        z: axis.has(2) ? conv(axis.get(2)) : this.cycle?.z,      // work coords, mm
        r: w.has('R') ? conv(w.get('R')) : this.cycle?.r,
        p: w.has('P') ? w.get('P') : this.cycle?.p,              // seconds, sticky (manual p.232)
        q: w.has('Q') ? conv(w.get('Q')) : this.cycle?.q
      }
      axis.delete(2); w.delete('R'); w.delete('P'); w.delete('Q')
      if (c.z === undefined || c.r === undefined) return fail('error:28')
      if ((c.code === 73 || c.code === 83) && !(c.q > 0)) return fail('error:28')
      // The board requires a fresh P when CHANGING to G82/G86/G89 (shared
      // validation, gcode.c:3382-3388; G86's "missing word" was P — bench).
      if (cycleCode !== undefined && (c.code === 82 || c.code === 86 || c.code === 89) && c.p === undefined) return fail('error:28')
      if (this.feed <= 0) return fail('error:22')

      const L = w.has('L') ? Math.max(0, Math.round(w.get('L'))) : 1
      w.delete('L')

      // L0 sets the cycle up without executing it — the obstacle-avoidance idiom.
      if (L > 0) {
        const base = this.plannedEnd()
        const initialZ = base[2]                 // G98 return point for this block
        const rZ = g53 ? c.r : c.r + wco[2] + this.g92[2] + this.tloZ
        const bottom = g53 ? c.z : c.z + wco[2] + this.g92[2] + this.tloZ
        let x = base[0], y = base[1], a = base[3]
        let zNow = initialZ
        for (let rep = 0; rep < L; rep++) {
          // Incremental repeats space the holes; absolute repeats re-drill in
          // place, which is legal and pointless on the real control too.
          if (axis.has(0)) x = abs && rep === 0 ? toMach(0, scaleAbs(0, axis.get(0))) : abs ? x : x + conv(scaleInc(0, axis.get(0)))
          if (axis.has(1)) y = abs && rep === 0 ? toMach(1, scaleAbs(1, axis.get(1))) : abs ? y : y + conv(scaleInc(1, axis.get(1)))
          path.push({ target: [x, y, zNow, a], rate: this.rapidRate, rapid: true })
          path.push({ target: [x, y, rZ, a], rate: this.rapidRate, rapid: true })
          if (c.code === 73 || c.code === 83) {
            let zAt = rZ
            while (zAt > bottom + 1e-9) {
              const next = Math.max(bottom, zAt - c.q)
              path.push({ target: [x, y, next, a], rate: this.feed, rapid: false })
              if (next > bottom + 1e-9) {
                // 83 retracts fully to R; 73 chip-breaks with a short back-off
                const up = c.code === 83 ? rZ : Math.min(rZ, next + 0.5)
                path.push({ target: [x, y, up, a], rate: this.rapidRate, rapid: true })
                if (c.code === 83) path.push({ target: [x, y, next + 0.5, a], rate: this.rapidRate, rapid: true })
              }
              zAt = next
            }
          } else {
            path.push({ target: [x, y, bottom, a], rate: this.feed, rapid: false })
          }
          if ((c.code === 82 || c.code === 86 || c.code === 89) && c.p > 0) path.push({ dwell: c.p })
          if (c.code === 86) path.push({ effect: () => { this.spindleDir = 0; this.spindle = 0 } })
          const backTo = this.retract98 ? initialZ : rZ
          const feedBack = c.code === 85 || c.code === 89
          path.push({ target: [x, y, backTo, a], rate: feedBack ? this.feed : this.rapidRate, rapid: !feedBack })
          zNow = backTo
        }
        axis.clear()
      } else
        axis.clear()
    }

    // ---- plain motion -------------------------------------------------------

    else if (axis.size || motions.some(v => v === 2 || v === 3)) {
      const motion = motions.length ? motions[0] : this.motionMode
      if (motion === 80 || motion === undefined || motion === null) return fail('error:20')
      if (motions.length && (motion === 0 || motion === 1 || motion === 2 || motion === 3)) {
        this.motionMode = motion
        this.cycle = null              // G00/G01 (and arcs) cancel a canned cycle, manual p.235
      }

      // An arc needs no axis words at all: `G2 I25` in G17 is a full circle back
      // to where it started, and the old `axis.size` gate dropped it silently.
      const arc = motion === 2 || motion === 3

      if (axis.size || arc) {
        const base = this.plannedEnd()
        const target = base.map((v, i) => !axis.has(i) ? v
          : abs ? toMach(i, scaleAbs(i, axis.get(i))) : v + conv(scaleInc(i, axis.get(i))))
        axis.clear()

        if (motion !== 0 && this.feed <= 0) return fail('error:22')

        // The whole move as a list of targets: one for a straight line, a run of
        // short chords for an arc. Everything past here — soft limits, feedrate,
        // the planner, the graphics plot — treats the two the same.
        let targets = [target]
        if (arc) {
          const got = this.arcTargets(base, target, w, motion === 2, conv)
          if (got.err) return fail(got.err)
          targets = got.targets
        }

        // Every chord, not just the endpoint: an arc bulges, and the bulge is
        // what leaves the envelope on a program whose start and end do not.
        for (const t of targets)
          if (t.some((v, i) => Math.abs(v) > this.maxTravel[i])) return this.raiseAlarm(2)

        let dist = 0
        let from = base
        for (const t of targets) { dist += Math.hypot(...t.map((v, i) => v - from[i])); from = t }
        const rate = motion === 0 ? this.rapidRate
          : this.invTime ? Math.max(1, dist * this.feed)   // G93: F = 1/minutes
          : this.feed
        for (const t of targets) path.push({ target: t, rate, rapid: motion === 0 })
      }
    }

    // ---- M effects, deferred to execution ----------------------------------

    if (sWord !== null) effects.push(() => { this.commandedRpm = sWord; if (this.spindleDir) this.spindle = sWord })
    for (const v of m) {
      if (v === 3) effects.push(() => { this.spindleDir = 1; this.spindle = this.commandedRpm ?? 0 })
      else if (v === 4) effects.push(() => { this.spindleDir = -1; this.spindle = this.commandedRpm ?? 0 })
      else if (v === 5) effects.push(() => { this.spindleDir = 0; this.spindle = 0 })
      else if (v === 7 || v === 88) effects.push(() => { this.mist = true })
      else if (v === 89) effects.push(() => { this.mist = false })
      else if (v === 31 || v === 33) effects.push(() => { this.chipFwd = v === 31 })
      else if (v === 8) effects.push(() => { this.flood = true })
      else if (v === 9) effects.push(() => { this.flood = false; this.mist = false })
      else if (v === 0) effects.push(() => {
        this.spindleDir = 0; this.spindle = 0; this.flood = false; this.mist = false
        this.state = 'Hold'
      })
      else if (v === 1) effects.push(() => { if (!this.optStopDisabled) this.state = 'Hold' })
      else if (v === 6) effects.push(() => {
        this.tool = this.pendingTool
        this.state = 'Hold'
        this.emit(`[MSG:Tool change T${this.tool}]`)
      })
      else if (v === 30) effects.push(() => {
        this.spindleDir = 0; this.spindle = 0; this.flood = false; this.mist = false; this.tloZ = 0
        this.emit('[MSG:HAAS:M30]')
      })
      // M2: program end — the queue draining to Idle is the machine's answer
    }

    if (w.size || axis.size) return fail('error:36')      // unused words

    if (g49) this.tloZ = 0

    const block = { n: ++this.line, effects, path, step: 0 }
    this.queue.push(block)
    if (this.state === 'Idle') this.state = 'Run'

    // Real grbl acknowledges when the block is buffered, not when it finishes —
    // that is what lets the sender keep the planner full. Defer the ok when the
    // planner is full so the streamer actually has something to push against.
    if (this.queue.length < PLANNER) this.emit('ok')
    else this.owedOks++
  }

  /**
   * A G2/G3 as the run of short chords the machine actually travels.
   *
   * The old version drove straight to the endpoint and threw I/J/K/R away, which
   * is invisible while you are teaching operator workflow and a lie the moment
   * anything DRAWS the path: a bolt circle came out a polygon. Chord sagitta is
   * held to 0.01 mm, so the segment count follows the radius instead of a
   * constant that would be coarse on a big arc and wasteful on a small one.
   *
   * Returns `{ targets }` in machine coordinates, or `{ err }` with the code the
   * board would answer. Offsets are incremental from the start point — the only
   * form the Classic teaches, and G90.1 is not in G_SUPPORTED.
   *
   * ponytail: G51 scaling does not reach the offsets, so a scaled arc keeps its
   * true radius. Scale them the day a lesson needs a scaled arc, not before.
   */
  arcTargets (start, end, w, cw, conv) {
    // grbl's plane axis order. The same math serves all three planes only if G18
    // is read as (Z,X) rather than (X,Z) — that ordering is what keeps G2 meaning
    // clockwise as seen from the positive end of the axis left over.
    const [a, b] = [[0, 1], [2, 0], [1, 2]][this.plane]
    const oa = 'IJK'[a], ob = 'IJK'[b]
    let ca, cb, r

    if (w.has('R')) {
      if (w.has(oa) || w.has(ob)) return { err: 'error:33' }   // R or offsets, not both
      r = conv(w.get('R')); w.delete('R')
      const dx = end[a] - start[a]
      const dy = end[b] - start[b]
      const d = Math.hypot(dx, dy)
      // A full circle has no chord to hang a radius on, so R cannot describe one.
      if (d === 0) return { err: 'error:33' }
      let h = 4 * r * r - dx * dx - dy * dy
      if (h < 0) return { err: 'error:34' }     // no circle that small reaches the endpoint
      h = -Math.sqrt(h) / d
      if (!cw) h = -h
      if (r < 0) { h = -h; r = -r }             // negative R picks the major arc
      ca = 0.5 * (dx - dy * h)
      cb = 0.5 * (dy + dx * h)
    } else {
      if (!w.has(oa) && !w.has(ob)) return { err: 'error:35' }
      ca = w.has(oa) ? conv(w.get(oa)) : 0
      cb = w.has(ob) ? conv(w.get(ob)) : 0
      w.delete(oa); w.delete(ob)
      r = Math.hypot(ca, cb)
      // The endpoint has to sit on the same circle as the start. Real controls
      // check this because a mistyped J is otherwise a spiral nobody asked for.
      const rEnd = Math.hypot(end[a] - start[a] - ca, end[b] - start[b] - cb)
      if (Math.abs(rEnd - r) > Math.max(0.005, r * 0.002)) return { err: 'error:33' }
    }
    if (r < 1e-6) return { err: 'error:33' }

    const cA = start[a] + ca
    const cB = start[b] + cb
    // Both angles measured the same way, off the same centre. Writing the start
    // as atan2(-cb, -ca) looks equivalent and is not: a J0 arrives as negative
    // zero, which puts the start on -pi and the end on +pi, and a full circle
    // came out as a zero-length move that drew nothing.
    const t0 = Math.atan2(start[b] - cB, start[a] - cA)
    let sweep = Math.atan2(end[b] - cB, end[a] - cA) - t0
    // atan2 lands the difference in (-2pi, 2pi), so one nudge is enough to put it
    // on the commanded side. Exactly zero is the full circle, not a no-op.
    if (cw && sweep >= 0) sweep -= 2 * Math.PI
    if (!cw && sweep <= 0) sweep += 2 * Math.PI

    const per = 2 * Math.acos(Math.max(-1, 1 - 0.01 / r))
    const n = Math.min(600, Math.max(2, Math.ceil(Math.abs(sweep) / per)))
    const targets = []
    for (let k = 1; k < n; k++) {
      const f = k / n
      const th = t0 + sweep * f
      // Anything not in the plane rides along linearly: that is a helix, and on
      // this control it is also how A gets to the end of an arc.
      const t = start.map((v, i) => v + (end[i] - v) * f)
      t[a] = cA + r * Math.cos(th)
      t[b] = cB + r * Math.sin(th)
      targets.push(t)
    }
    targets.push([...end])          // land on the commanded point, not on a cosine
    return { targets }
  }

  jog (spec) {
    const words = spec.toUpperCase().match(/([A-Z])\s*(-?[\d.]+)/g) || []
    let relative = false
    let rate = this.rapidRate
    const delta = zero()
    let moved = false

    for (const w of words) {
      const letter = w[0]
      const value = Number(w.slice(1).trim())
      if (letter === 'G' && value === 91) relative = true
      else if (letter === 'F') rate = this.toMm(value)
      else {
        const axis = AXES.indexOf(letter)
        if (axis >= 0) { delta[axis] = this.toMm(value); moved = true }
      }
    }
    if (!moved) return this.emit('error:16')

    const base = this.plannedEnd()
    const target = relative ? base.map((v, i) => v + delta[i]) : delta
    if (target.some((v, i) => Math.abs(v) > this.maxTravel[i])) {
      return this.emit('error:15')    // jog target exceeds travel
    }

    this.state = 'Jog'
    this.queue.push({ target, rate, rapid: false, jog: true, n: this.line })
    this.emit('ok')
  }

  cancelJog () {
    if (this.state !== 'Jog') return
    this.queue = this.queue.filter(m => !m.jog)
    if (this.current?.jog) this.current = null
    this.state = 'Idle'
  }

  // -------------------------------------------------------------------- motion

  /** Take the next block off the planner and apply the effects it carries. */
  advance () {
    this.current = this.queue.shift() || null
    if (!this.current) return null
    // Jog and $H push bare { target } blocks; normalise everything to a path so
    // tick() has one shape to walk (a canned-cycle line is many steps, one block).
    if (this.current.target && !this.current.path) {
      this.current.path = [{ target: this.current.target, rate: this.current.rate, rapid: this.current.rapid }]
    }
    this.current.step ??= 0
    for (const effect of this.current.effects ?? []) effect()
    this.line = this.current.n
    if (this.owedOks > 0) { this.owedOks--; this.emit('ok') }
    return this.current
  }

  /** A block just finished: single block holds after EVERY block, like $S. */
  finishBlock () {
    const wasJog = this.current?.jog
    this.current = null
    if (this.singleBlock && !wasJog && this.state === 'Run') this.state = 'Hold'
  }

  tick (dt) {
    if (this.state === 'Hold' || this.state === 'Alarm') return

    while (dt > 0) {
      if (!this.current) {
        if (!this.queue.length) break
        this.advance()
        if (this.state === 'Hold') return       // an M0/M1/M6 effect fired
        continue
      }

      const step = this.current.path?.[this.current.step]
      if (!step) { this.finishBlock(); if (this.state === 'Hold') return; continue }

      if (step.dwell !== undefined) {
        if (this.dwellRemaining === 0) this.dwellRemaining = step.dwell
        const used = Math.min(dt, this.dwellRemaining)
        this.dwellRemaining -= used
        dt -= used
        if (this.dwellRemaining <= 1e-9) { this.dwellRemaining = 0; this.current.step++ }
        continue
      }

      if (step.effect) { step.effect(); this.current.step++; continue }

      const scale = (step.rapid ? this.ov.rapid : this.ov.feed) / 100
      const mmPerSec = (step.rate * scale) / 60
      const delta = step.target.map((t, i) => t - this.mpos[i])
      const dist = Math.hypot(...delta)
      const budget = mmPerSec * dt

      if (dist <= budget || dist < 1e-9) {
        this.mpos = [...step.target]
        dt -= mmPerSec > 0 ? dist / mmPerSec : dt
        this.current.step++
      } else {
        this.mpos = this.mpos.map((v, i) => v + (delta[i] / dist) * budget)
        dt = 0
      }
    }

    // Go idle as soon as the buffer drains, not on the following tick — otherwise
    // the last move of a job leaves the machine reporting Run with nothing to do.
    if (!this.current && !this.queue.length && MOVING.has(this.state)) {
      this.state = 'Idle'
    }
  }

  /** Where the machine will be once everything currently queued has run. */
  plannedEnd () {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const p = this.queue[i].path
      if (p) { for (let j = p.length - 1; j >= 0; j--) if (p[j].target) return p[j].target }
      if (this.queue[i].target) return this.queue[i].target
    }
    const cp = this.current?.path
    if (cp) for (let j = cp.length - 1; j >= 0; j--) if (cp[j].target) return cp[j].target
    return this.current?.target ?? this.mpos
  }

  // ------------------------------------------------------------------- reports

  statusReport () {
    const wco = this.offsets[this.wcs]
    const free = Math.max(0, PLANNER - this.queue.length)
    let r = `<${this.state}${this.state === 'Hold' ? ':0' : ''}` +
      `|MPos:${fmt(this.mpos)}` +
      `|Bf:${free},${RX_FREE}` +
      `|Ln:${this.line}` +
      `|FS:${Math.round(this.currentFeed())},${Math.round(this.spindle)}`

    // Real grbl sends WCO and Ov intermittently rather than every report; matching
    // that keeps the client honest about caching them.
    if (this.reportCount === undefined) this.reportCount = 0
    if (this.reportCount % 10 === 0) r += `|WCO:${fmt(wco)}`
    if (this.reportCount % 10 === 5) r += `|Ov:${this.ov.feed},${this.ov.rapid},${this.ov.spindle}`
    this.reportCount++

    const acc = (this.spindleDir > 0 ? 'S' : this.spindleDir < 0 ? 'C' : '') +
      (this.flood ? 'F' : '') + (this.mist ? 'M' : '')
    if (acc) r += `|A:${acc}`

    // Software run switches surface as control-signal chars, firmware order:
    // L block delete, T optional-stop-disable, Q single block (report.c:166).
    const pn = (this.blockDelete ? 'L' : '') + (this.optStopDisabled ? 'T' : '') +
      (this.singleBlock ? 'Q' : '')
    if (pn) r += `|Pn:${pn}`

    return r + '>'
  }

  currentFeed () {
    const step = this.current?.path?.[this.current.step]
    if (!step?.target) return 0
    const scale = (step.rapid ? this.ov.rapid : this.ov.feed) / 100
    return step.rate * scale
  }

  /** Instructors can provoke a fault so students see the alarm pane do something. */
  raiseAlarm (code) {
    this.alarm = code
    this.state = 'Alarm'
    this.queue = []
    this.current = null
    this.emit(`ALARM:${code}`)
  }

  toMm (v) { return this.inches ? v * 25.4 : v }
}

const fmt = (v) => v.map(n => n.toFixed(3)).join(',')
const wcsName = (i) => i < 6 ? `G5${4 + i}` : `G59.${i - 5}`
