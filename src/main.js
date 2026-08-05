import { render } from 'lit-html'
import { websocketTransport, serialTransport, simTransport } from './transport.js'
import { parseStatus, parseFeedback, parseOpt, Streamer, prepare, describeAlarm, describeError } from './grbl.js'
import { pendant } from './ui/pendant.js'
import { screen } from './ui/screen.js'
import { MODES, DISPLAY_PANES } from './keys.js'

const $ = (id) => document.getElementById(id)
const STATUS_IDLE_MS = 500

// Handle-jog increments. The keys are printed with both scales — ".0001 / .1" —
// because the same key means thousandths of an inch or tenths of a millimetre
// depending on the active unit.
const INCREMENT_KEYS = ['inc-0001', 'inc-001', 'inc-01', 'inc-1']
const INCREMENTS = { IN: [0.0001, 0.001, 0.01, 0.1], MM: [0.1, 1, 10, 100] }
const JOG_FEED = { IN: 100, MM: 2540 }

const AXIS_KEYS = {
  'jog-x-plus': [0, +1], 'jog-x-minus': [0, -1],
  'jog-y-plus': [1, +1], 'jog-y-minus': [1, -1],
  'jog-z-plus': [2, +1], 'jog-z-minus': [2, -1],
  'jog-b-plus': [3, +1], 'jog-a-plus': [3, -1]
}

const REALTIME = {
  'feed-100': 0x90, 'feed-plus': 0x91, 'feed-minus': 0x92,
  'spindle-100': 0x99, 'spindle-plus': 0x9A, 'spindle-minus': 0x9B,
  'rapid-100': 0x95, 'rapid-50': 0x96, 'rapid-25': 0x97,
  'coolant': 0xA0
}

const s = {
  mode: 'SETUP', fn: 'JOG',
  activePane: 'position',
  mpos: [0, 0, 0, 0], wco: [0, 0, 0, 0], dtg: [0, 0, 0, 0], operator: [0, 0, 0, 0],
  wcs: 'G54', units: 'MM', incIndex: 1,
  machineState: '—', link: 'OFFLINE', feed: 0, spindle: 0, spindleDir: 0,
  ov: { feed: 100, rapid: 100, spindle: 100 },
  tool: 0, tlo: 0, coolant: false, jogLock: false,
  alarm: null, message: '', input: '',
  program: { name: '', lines: [], current: 0 },
  job: null, plannerSize: 100,
  dial: 0
}

let link = null
let streamer = null
let lastReportAt = 0
let dirty = true

const increment = () => INCREMENTS[s.units][s.incIndex]

// ---------------------------------------------------------------------- render

function paint () {
  s.increment = increment()
  s.screen = screen(s)
  render(pendant(s, { press, jogWheel }), $('app'))
  dirty = false
}
const invalidate = () => { dirty = true }
setInterval(() => { if (dirty) paint() }, 60)

// ------------------------------------------------------------------- dispatch

function press (id) {
  // Mode keys — three modes only, per T2.11.
  if (MODES[id]) { Object.assign(s, MODES[id]); return invalidate() }

  // Display keys move the white highlight; they do not change mode.
  if (DISPLAY_PANES[id]) { s.activePane = DISPLAY_PANES[id]; return invalidate() }

  const incAt = INCREMENT_KEYS.indexOf(id)
  if (incAt >= 0) { s.incIndex = incAt; return invalidate() }

  if (REALTIME[id] !== undefined) { link?.sendRealtime(REALTIME[id]); return }

  if (AXIS_KEYS[id]) { jogAxis(...AXIS_KEYS[id]); return }

  switch (id) {
    case 'cycle-start': return cycleStart()
    case 'feed-hold': return link?.sendRealtime(0x21)
    case 'reset': case 'estop':
      link?.sendRealtime(0x18)
      streamer?.stop()
      s.job = null
      s.alarm = id === 'estop' ? 'EMERGENCY STOP (software)' : null
      s.message = id === 'estop' ? 'this is not a hardware E-stop' : ''
      return invalidate()

    case 'spindle-cw': return send('M3 S1000')
    case 'spindle-ccw': return send('M4 S1000')
    case 'spindle-stop': return send('M5')

    case 'jog-lock': s.jogLock = !s.jogLock; return invalidate()
    case 'zero-all': return send('$H')
    case 'zero-home': return send('G28')

    case 'cancel': s.input = ''; return invalidate()
    case 'enter': return commitInput()
    case 'space': s.input += ' '; return invalidate()
  }

  // Alpha and numeric keys type into the input bar.
  const typed = typedChar(id)
  if (typed !== null) { s.input += typed; return invalidate() }
}

function typedChar (id) {
  if (id.startsWith('alpha-')) return id.slice(6).toUpperCase()
  if (id.startsWith('num-')) return id.slice(4)
  if (id === 'minus') return '-'
  if (id === 'dot') return '.'
  if (id === 'semicolon') return ';'
  if (id === 'paren-open') return '('
  if (id === 'paren-close') return ')'
  return null
}

function commitInput () {
  const v = s.input.trim()
  s.input = ''
  invalidate()
  if (v) send(v)
}

function send (line) {
  if (!link) { s.message = 'not connected'; return invalidate() }
  link.send(line + '\n')
}

function jogAxis (axis, dir) {
  if (!link) return
  const step = (increment() * dir).toFixed(4)
  link.send(`$J=G91 F${JOG_FEED[s.units]} ${'XYZA'[axis]}${step}\n`)
}

function jogWheel (dir) {
  s.dial = (s.dial + dir * 18) % 360
  invalidate()
  jogAxis(0, dir)     // the dial jogs the axis the operator has selected; X for now
}

function cycleStart () {
  if (streamer && !streamer.done && streamer.total && !streamer.running) {
    return link?.sendRealtime(0x7E)     // resume from a hold
  }
  if (!s.program.lines.length) { s.message = 'no program in memory'; return invalidate() }
  s.alarm = null
  s.mode = 'OPERATION'; s.fn = 'MEM'
  s.activePane = 'program'
  s.job = { sentAll: false }
  streamer.start(s.program.lines.map(l => l.text))
  invalidate()
}

// -------------------------------------------------------------------- incoming

function onLine (line) {
  const st = parseStatus(line)
  if (st) return applyStatus(st)

  if (streamer?.onLine(line)) {
    if (streamer.error) {
      s.alarm = `ERROR ${streamer.error.code} — ${streamer.error.text}`
      s.job = null
    } else if (streamer.done && s.job) {
      // Every block has been ACCEPTED, not executed — grbl answers `ok` when a
      // line is buffered. The machine is still cutting whatever is in the planner,
      // so the job is not finished until it goes Idle.
      s.job.sentAll = true
      s.message = 'all blocks sent — running out the buffer'
    }
    return invalidate()
  }

  if (line.startsWith('ALARM:')) {
    const n = Number(line.slice(6))
    s.alarm = `ALARM ${n} — ${describeAlarm(n)}`
    return invalidate()
  }
  if (line.startsWith('error:')) {
    const n = Number(line.slice(6))
    s.message = `error ${n} — ${describeError(n)}`
    return invalidate()
  }

  const fb = parseFeedback(line)
  if (!fb) { s.message = line; return invalidate() }

  if (fb.kind === 'OPT') {
    const opt = parseOpt(fb.value)
    if (opt.rx && streamer) streamer.rxBuffer = opt.rx
    if (opt.planner) s.plannerSize = opt.planner
  } else if (fb.kind === 'GC') {
    s.modal = fb.value
    s.units = /\bG20\b/.test(fb.value) ? 'IN' : 'MM'
    const wcs = fb.value.match(/G5[4-9](\.\d)?/)
    if (wcs) s.wcs = wcs[0]
  } else if (fb.kind === 'TLO') {
    s.tlo = fb.value[2] ?? 0
  } else if (fb.kind === 'MSG') {
    s.message = fb.value
  }
  invalidate()
}

function applyStatus (st) {
  lastReportAt = performance.now()
  s.machineState = st.sub === null ? st.state : `${st.state}:${st.sub}`
  if (st.MPos) s.mpos = st.MPos
  if (st.WCO) s.wco = st.WCO
  if (st.feed !== undefined) s.feed = st.feed
  if (st.spindle !== undefined) s.spindle = st.spindle
  if (st.ov) s.ov = st.ov

  // Which block is the machine CUTTING? Not the one we last sent — grbl acks on
  // buffering, so we are always some blocks ahead. `Bf:` gives free planner slots,
  // so acked minus what is still queued is the block actually under the tool.
  // (`Ln:` is not usable for this: it counts blocks executed since power-up, not
  // source lines, unless the program carries N words.)
  if (s.job && st.bf && s.plannerSize) {
    const queued = Math.max(0, s.plannerSize - st.bf.blocks)
    s.program.current = Math.max(0, streamer.acked - queued)
  }

  if (s.job?.sentAll && st.state === 'Idle') {
    s.job = null
    s.message = 'program complete'
    s.program.current = 0
  }
  s.spindleDir = st.accessory?.includes('S') ? 1 : st.accessory?.includes('C') ? -1 : 0
  s.coolant = !!st.accessory?.includes('F')
  if (st.state === 'Alarm') { if (!s.alarm) s.alarm = 'ALARM' } else if (st.state !== 'Alarm') {
    if (s.alarm?.startsWith('ALARM') && st.state === 'Idle') s.alarm = null
  }
  invalidate()
}

// ------------------------------------------------------------------ connection

async function connect () {
  const kind = $('kind').value
  try {
    link = kind === 'websocket' ? websocketTransport({ host: $('host').value })
      : kind === 'serial' ? serialTransport()
        : simTransport()

    link.onLine(onLine)
    await link.connect()

    streamer = new Streamer(wire => link.send(wire), 128)
    lastReportAt = 0

    $('link').textContent = link.describe()
    $('link').className = 'ok'
    s.link = link.kind.toUpperCase()
    link.send('$I\n')
    link.send('$G\n')
    link.send('$#\n')
  } catch (e) {
    $('link').textContent = e.message
    $('link').className = 'bad'
    link = null
  }
  invalidate()
}

setInterval(() => {
  if (link && performance.now() - lastReportAt > STATUS_IDLE_MS) link.sendRealtime(0x3F)
}, 200)

$('connect').onclick = connect
$('file').onchange = async (e) => {
  const f = e.target.files[0]
  if (!f) return
  s.program = { name: f.name, lines: prepare(await f.text()), current: 0 }
  s.activePane = 'program'
  s.message = `loaded ${f.name} (${s.program.lines.length} lines)`
  invalidate()
}

// Physical keyboard shortcuts for the keys a student uses constantly.
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return
  const map = {
    ArrowLeft: 'jog-x-plus', ArrowRight: 'jog-x-minus',
    ArrowUp: 'jog-y-plus', ArrowDown: 'jog-y-minus',
    PageUp: 'jog-z-plus', PageDown: 'jog-z-minus'
  }
  if (map[e.key]) { e.preventDefault(); press(map[e.key]) }
})

addEventListener('beforeunload', () => link?.disconnect())

paint()
