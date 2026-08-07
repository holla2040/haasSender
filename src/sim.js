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
      case 0x18: this.reset(false); this.emit('ok'); return      // soft reset
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

    switch (line) {
      case '$I':
        this.emit('[VER:1.1f.haasSender-sim:]')
        this.emit(`[OPT:VNML,${PLANNER},${RX_FREE + 1},4,${N_SIM_TOOLS}]`)
        this.emit('[NEWOPT:EXPR]')
        this.emit('[AXS:4:XYZA]')
        this.emit('[FIRMWARE:grblHAL]')
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

      case '$13': this.emit('$13=0'); return this.emit('ok')

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
        // The handful the PARAMETER page and the sender actually read.
        for (const [k, v] of [[13, 0], [20, 0], [21, 0], [22, 0],
          [30, 24000], [31, 0], [32, 0],
          [110, 5000], [111, 5000], [112, 5000], [113, 3000],
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
      motionMode: this.motionMode, feed: this.feed, g92: [...this.g92],
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
      if (w.has('R')) return fail('error:20')   // ponytail: no rotation here — the board has it, this sim refuses rather than lies
      if (l === 2) {
        if (p === null || p < 0 || p > 9) return fail('error:20')
        const row = this.offsets[p === 0 ? this.wcs : p - 1]
        for (const [i, v] of axis) row[i] = conv(v)   // G10 L2 values are machine coords
        axis.clear()
      } else if (l === 1) {
        if (p === null || p < 1 || p > N_SIM_TOOLS) return fail('error:20')
        const t = this.tools.get(p) ?? {}
        for (const [i, v] of axis) t[AXES[i].toLowerCase()] = conv(v)
        if (w.has('R')) { t.r = conv(w.get('R')); w.delete('R') }
        this.tools.set(p, t)
        axis.clear()
      } else
        return fail('error:20')                 // ponytail: L10/L11 not modelled — sender writes absolute via L1
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
      if (axis.size) {
        const base = this.plannedEnd()
        const mid = base.map((v, i) => !axis.has(i) ? v
          : abs ? toMach(i, scaleAbs(i, axis.get(i))) : v + conv(scaleInc(i, axis.get(i))))
        axis.clear()
        path.push({ target: mid, rate: this.rapidRate, rapid: true })
      }
      path.push({ target: zero(), rate: this.rapidRate, rapid: true })
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

      if (motion === 2 || motion === 3) {
        // ponytail: arcs travel straight to their endpoint — operator training,
        // not toolpath preview. I/J/K/R are accepted and ignored.
        w.delete('I'); w.delete('J'); w.delete('K'); w.delete('R')
      }

      if (axis.size) {
        const base = this.plannedEnd()
        const target = base.map((v, i) => !axis.has(i) ? v
          : abs ? toMach(i, scaleAbs(i, axis.get(i))) : v + conv(scaleInc(i, axis.get(i))))
        axis.clear()

        if (target.some((v, i) => Math.abs(v) > this.maxTravel[i])) return this.raiseAlarm(2)
        if (motion !== 0 && this.feed <= 0) return fail('error:22')

        const dist = Math.hypot(...target.map((t, i) => t - this.plannedEnd()[i]))
        const rate = motion === 0 ? this.rapidRate
          : this.invTime ? Math.max(1, dist * this.feed)   // G93: F = 1/minutes
          : this.feed
        path.push({ target, rate, rapid: motion === 0 })
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
      else if (v === 0) effects.push(() => { this.state = 'Hold' })
      else if (v === 1) effects.push(() => { if (!this.optStopDisabled) this.state = 'Hold' })
      else if (v === 6) effects.push(() => {
        this.tool = this.pendingTool
        this.state = 'Hold'
        this.emit(`[MSG:Tool change T${this.tool}]`)
      })
      // M2/M30: program end — the queue draining to Idle is the machine's answer
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
