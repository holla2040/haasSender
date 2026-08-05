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

export class VirtualGrbl {
  constructor ({ rapidRate = 5000, maxTravel = [500, 400, 300, 360] } = {}) {
    this.rapidRate = rapidRate          // mm/min
    this.maxTravel = maxTravel
    this.outbox = []
    this.onLineCb = () => {}
    this.reset(true)
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
    this.tlo = zero()
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
    }
  }

  exec (line) {
    if (this.alarm && !/^\$(X|H)/.test(line)) {
      this.emit('error:9')        // locked out during alarm
      return
    }
    if (line[0] === '$') return this.system(line)
    this.gcode(line)
  }

  // ------------------------------------------------------------ system commands

  system (line) {
    if (line.startsWith('$J=')) return this.jog(line.slice(3))

    switch (line) {
      case '$I':
        this.emit('[VER:1.1f.haasSender-sim:]')
        this.emit(`[OPT:VNML,${PLANNER},${RX_FREE + 1},4,0]`)
        this.emit('[AXS:4:XYZA]')
        this.emit('[FIRMWARE:grblHAL]')
        return this.emit('ok')

      case '$#':
        this.offsets.forEach((o, i) => this.emit(`[${wcsName(i)}:${fmt(o)}]`))
        this.emit(`[G28:${fmt(zero())}]`)
        this.emit(`[G30:${fmt(zero())}]`)
        this.emit(`[G92:${fmt(zero())}]`)
        this.emit(`[TLO:${fmt(this.tlo)}]`)
        this.emit(`[PRB:${fmt(zero())}:0]`)
        return this.emit('ok')

      case '$G':
        this.emit(`[GC:G${this.motionMode ?? 0} ${wcsName(this.wcs)} G17 ` +
          `${this.inches ? 'G20' : 'G21'} ${this.absolute ? 'G90' : 'G91'} G94 G49 G98 ` +
          `M${this.spindleDir === 0 ? 5 : this.spindleDir > 0 ? 3 : 4} ` +
          `M${this.flood ? 8 : 9} T0 F${this.feed} S${this.spindle}]`)
        return this.emit('ok')

      case '$13': this.emit('$13=0'); return this.emit('ok')

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

    let motion = null
    const target = this.absolute ? [...this.plannedEnd()] : zero()
    let moved = false
    let feed = this.feed

    // Machine effects are DEFERRED to when the block executes; interpreter state
    // (G90/G91, G20/G21, work offset, feed) applies now, because it governs how the
    // following lines are read. This is the same split a real control makes: the
    // parser runs ahead of the table, so an M5 on the last line must not stop the
    // spindle while the first cut is still running.
    let dir = null, rpm = null, flood = null
    const effects = []

    for (const w of words) {
      const letter = w[0]
      const value = Number(w.slice(1).trim())

      if (letter === 'G') {
        if (value === 0 || value === 1) { motion = value; this.motionMode = value }
        else if (value === 4) { /* dwell: treated as instantaneous */ }
        else if (value === 20) this.inches = true
        else if (value === 21) this.inches = false
        else if (value === 90) this.absolute = true
        else if (value === 91) this.absolute = false
        else if (value >= 54 && value <= 59) this.wcs = Math.round(value) - 54
      } else if (letter === 'M') {
        if (value === 3) dir = 1
        else if (value === 4) dir = -1
        else if (value === 5) dir = 0
        else if (value === 8) flood = true
        else if (value === 9) flood = false
        else if (value === 30 || value === 2) { /* program end */ }
      } else if (letter === 'F') {
        feed = this.toMm(value)
      } else if (letter === 'S') {
        rpm = value
      } else {
        const axis = AXES.indexOf(letter)
        if (axis >= 0) { target[axis] = this.toMm(value); moved = true }
      }
    }

    this.feed = feed
    if (rpm !== null) effects.push(() => { this.commandedRpm = rpm; if (this.spindleDir) this.spindle = rpm })
    if (dir !== null) {
      effects.push(() => {
        this.spindleDir = dir
        this.spindle = dir === 0 ? 0 : (this.commandedRpm ?? 0)
      })
    }
    if (flood !== null) effects.push(() => { this.flood = flood; if (!flood) this.mist = false })

    const block = { n: ++this.line, effects }

    if (moved) {
      if (motion === null) motion = this.motionMode ?? 0
      const abs = this.absolute ? target : this.plannedEnd().map((v, i) => v + target[i])

      if (abs.some((v, i) => Math.abs(v) > this.maxTravel[i])) return this.raiseAlarm(2)
      if (motion === 1 && feed <= 0) return this.emit('error:22')

      block.target = abs
      block.rate = motion === 0 ? this.rapidRate : feed
      block.rapid = motion === 0
    }

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
    for (const effect of this.current.effects ?? []) effect()   // jog and $H carry none
    this.line = this.current.n
    if (this.owedOks > 0) { this.owedOks--; this.emit('ok') }
    return this.current
  }

  tick (dt) {
    if (this.state === 'Hold' || this.state === 'Alarm') return

    // Blocks with no motion — M3, M8, a bare G90 — execute the instant they reach
    // the front of the planner, so run them off before spending any motion budget.
    while (!this.current?.target) {
      if (this.current) this.current = null
      if (!this.advance()) break
    }
    if (!this.current) {
      if (MOVING.has(this.state)) this.state = 'Idle'
      return
    }

    const scale = (this.current.rapid ? this.ov.rapid : this.ov.feed) / 100
    let budget = ((this.current.rate * scale) / 60) * dt

    while (budget > 0 && this.current?.target) {
      const delta = this.current.target.map((t, i) => t - this.mpos[i])
      const dist = Math.hypot(...delta)

      if (dist <= budget || dist < 1e-9) {
        this.mpos = [...this.current.target]
        budget -= dist
        this.current = null
        while (!this.current?.target) { if (!this.advance()) break }
      } else {
        this.mpos = this.mpos.map((v, i) => v + (delta[i] / dist) * budget)
        budget = 0
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
      if (this.queue[i].target) return this.queue[i].target
    }
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

    return r + '>'
  }

  currentFeed () {
    if (!this.current?.target) return 0
    const scale = (this.current.rapid ? this.ov.rapid : this.ov.feed) / 100
    return this.current.rate * scale
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
