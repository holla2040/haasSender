import { render } from 'lit-html'
import { websocketTransport, serialTransport, simTransport, servedFromBoard } from './transport.js'
import { parseStatus, parseFeedback, parseOpt, Streamer, prepare, parseONumber, describeAlarm, describeError } from './grbl.js'
import { pendant } from './ui/pendant.js'
import { screen } from './ui/screen.js'
import { MODES, DISPLAY_PANES, UNAVAILABLE } from './keys.js'

const $ = (id) => document.getElementById(id)
const STATUS_IDLE_MS = 500

// The board auto-pushes a report every 250 ms and we poll after 500 ms of
// silence, so two seconds without one means the link is gone, not merely quiet.
// Long enough that a busy tab or a slow serial write does not flicker it.
const STALE_MS = 2000

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
  // Two different units, and conflating them is a real bug rather than a nicety.
  // `units` is the modal programming unit from G20/G21 — what the numbers in a
  // block mean, and what the DRO is labelled in. `reportUnits` is what `MPos:`
  // itself arrives in, which grbl governs with `$13` alone.
  wcs: 'G54', units: 'MM', reportUnits: 'MM', incIndex: 1,
  machineState: '—', link: 'OFFLINE', stale: true, feed: 0, spindle: 0, spindleDir: 0,
  ov: { feed: 100, rapid: 100, spindle: 100 },
  tool: 0, tlo: 0, coolant: false, jogLock: false,
  alarm: null, message: '', input: '',
  // Control memory: the program directory, filed by O-number the way a HAAS files
  // it, and whichever one is currently selected to run.
  programs: [], listIndex: 0, blockDelete: false,
  program: { o: '', name: '', lines: [], current: 0 },
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
  // Say why, rather than swallow the press. A key that looks live and does
  // nothing teaches a student that the control is unreliable; one that explains
  // itself teaches them what the machine underneath can actually do.
  const why = UNAVAILABLE.get(id)
  if (why) { s.message = why; return invalidate() }

  // Mode keys — three modes only, per T2.11.
  if (MODES[id]) { Object.assign(s, MODES[id]); return invalidate() }

  // Display keys move the white highlight; they do not change mode.
  if (DISPLAY_PANES[id]) { s.activePane = DISPLAY_PANES[id]; return invalidate() }

  // The SETTING page's one real setting. A HAAS keeps inch/metric in Setting 9;
  // grbl has no such store, so changing it means commanding the modal pair.
  if (s.activePane === 'setting' && (id === 'left' || id === 'right')) {
    return send(s.units === 'IN' ? 'G21' : 'G20')
  }

  // LIST PROGRAM: the cursor walks control memory.
  if (s.activePane === 'list' && s.programs.length) {
    const move = { up: -1, down: 1, 'page-up': -8, 'page-down': 8, home: -1e9, end: 1e9 }[id]
    if (move !== undefined) {
      s.listIndex = Math.max(0, Math.min(s.programs.length - 1, s.listIndex + move))
      return invalidate()
    }
  }

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

    case 'select-program': return selectProgram()
    case 'erase-program': return eraseProgram()

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

// -------------------------------------------------------- the program directory

const selected = () => s.programs[s.listIndex] ?? null

/** Lowest unused O-number, for a file that arrived without one. */
function nextFreeONumber () {
  const used = new Set(s.programs.map(p => p.o))
  for (let n = 1; n < 100000; n++) {
    const o = 'O' + String(n).padStart(5, '0')
    if (!used.has(o)) return o
  }
  return null
}

/** Returns false when the directory could not be persisted; the caller must say so. */
const saveDirectory = () => store.set(PROGRAMS, s.programs)

/** Import a file into control memory, filed under its O-number. */
function storeProgram (name, text) {
  const found = parseONumber(text)
  const o = found ?? nextFreeONumber()
  if (!o) { s.message = 'control memory is full'; return invalidate() }

  const at = s.programs.findIndex(p => p.o === o)
  const entry = { o, name, text }
  if (at >= 0) s.programs[at] = entry
  else s.programs.push(entry)
  s.programs.sort((a, b) => a.o.localeCompare(b.o))
  s.listIndex = s.programs.findIndex(p => p.o === o)
  const persisted = saveDirectory()

  s.mode = 'EDIT'; s.fn = 'LIST'; s.activePane = 'list'
  selectProgram()

  // One message carrying everything the operator needs, set last because
  // selectProgram writes its own. Two things must not get lost here: that we
  // invented the O-number when the file had none, and that storage refused —
  // a program that vanishes on reload without warning is worse than one that
  // never claimed to be saved.
  s.message =
    (persisted ? '' : 'NOT STORED (browser storage refused) — ') +
    (found ? `${name} filed as ${o}` : `${name} had no O-number, filed as ${o}`) +
    `, ${s.program.lines.length} blocks`
  invalidate()
}

/** Make the highlighted directory entry the program CYCLE START will run. */
function selectProgram () {
  const p = selected()
  if (!p) { s.message = 'no program to select'; return invalidate() }
  s.program = {
    o: p.o,
    name: p.name,
    lines: prepare(p.text, { blockDelete: s.blockDelete }),
    current: 0
  }
  s.message = `${p.o} selected — ${s.program.lines.length} blocks`
  invalidate()
}

function eraseProgram () {
  const p = selected()
  if (!p) { s.message = 'no program to erase'; return invalidate() }
  if (s.job) { s.message = 'cannot erase while a program is running'; return invalidate() }

  s.programs.splice(s.listIndex, 1)
  s.listIndex = Math.max(0, Math.min(s.listIndex, s.programs.length - 1))
  const persisted = saveDirectory()

  // Erasing the program that is loaded has to unload it too, or CYCLE START would
  // run something the operator has just deleted from the directory.
  if (s.program.o === p.o) s.program = { o: '', name: '', lines: [], current: 0 }
  s.message = persisted ? `${p.o} erased` : `${p.o} erased, but browser storage refused — it will be back on reload`
  invalidate()
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
  // Ask what that did to the modal state rather than assume. Units, work offset
  // and spindle mode all live in `$G`, and a control that displays the unit it
  // last *requested* is wrong the moment a block changes it.
  //
  // Not during a job: the streamer counts one `ok` per line it sent, and every
  // extra line we slip in returns an `ok` that it will credit against a block
  // still in flight. Modal state gets re-read when the program ends instead.
  // ponytail: so a program that switches G20 mid-job is not noticed until it
  // finishes. Poll `$G` on a slow timer if that ever matters.
  if (!s.job) link.send('$G\n')
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
  if (!s.program.lines.length) {
    s.message = 'no program selected — press LIST PROGRAM, then SELECT PROGRAM'
    return invalidate()
  }
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

  // A settings echo, `$13=0`. `$13` is the one that matters up here: it is the
  // report-unit flag, 0 millimetres and 1 inches, and it governs what `MPos:`
  // means. G20/G21 does NOT — verified on the ClearCore, where `G20` is accepted
  // and the very next report still comes back in millimetres.
  const setting = line.match(/^\$(\d+)=(.*)$/)
  if (setting) {
    if (setting[1] === '13') s.reportUnits = setting[2].trim() === '1' ? 'IN' : 'MM'
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
    link?.send('$G\n')      // the program may have left the modal state elsewhere
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
  // Let go of the previous link first. Without this, reconnecting leaves the old
  // transport alive with its callback still pointing here — an orphaned simulator
  // goes on pushing `Idle|MPos:0,0,0,0` at 4 Hz and overwrites the readings from
  // the machine that is actually connected. Observed: the DRO sat at 0.000 through
  // a jog that had really happened.
  try { await link?.disconnect() } catch { /* already gone */ }
  link = null

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
    if (kind === 'websocket' && $('host').value) remember.set($('host').value)
    link.send('$I\n')
    link.send('$G\n')
    link.send('$#\n')
    link.send('$13\n')      // are reports in millimetres or inches?
  } catch (e) {
    $('link').textContent = e.message
    $('link').className = 'bad'
    link = null
    // Say it on the control, not just in the dev strip. An operator watching the
    // screen must be able to tell "not connected" from "connected and at zero".
    s.message = `cannot reach ${$('host').value || 'the machine'} — ${e.message}`
  }
  invalidate()
}

setInterval(() => {
  const quiet = performance.now() - lastReportAt
  if (link && quiet > STATUS_IDLE_MS) link.sendRealtime(0x3F)

  // Staleness watchdog. A dropped socket does not clear `link` — the websocket
  // just stops delivering — so without this the DRO holds its last reading and
  // goes on looking live. Blank it instead and say the link is down.
  const stale = !link || quiet > STALE_MS
  if (stale !== s.stale) { s.stale = stale; invalidate() }
}, 200)

// Where is the machine? In precedence order:
//   1. an explicit ?board=<addr> — bookmark one per machine in a classroom
//   2. the host that served this page — we are installed on a board's SD card,
//      and a network socket is the only transport there anyway, since plain HTTP
//      is not a secure context and Web Serial does not exist
//   3. the last address that connected successfully — so local development
//      against a bench board does not mean retyping it every reload
// Never a hardcoded default: a fixed IP goes stale on the next DHCP lease and
// has no business in a published repository.
// localStorage throws rather than returning null when storage is blocked — some
// embedded and file:// contexts do that. At module scope an uncaught throw here
// means a blank page instead of a control, so it is never worth the risk.
const store = {
  get: (key, fallback) => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? fallback : JSON.parse(raw)
    } catch { return fallback }            // blocked, or somebody else's format
  },
  set: (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); return true } catch { return false }
  }
}

const REMEMBERED = 'haassender.board'
const remember = {
  get: () => store.get(REMEMBERED, null),
  set: (v) => store.set(REMEMBERED, v)
}

// Control memory. A HAAS keeps programs on the control, filed by O-number, and
// LIST PROGRAM is how an operator picks one — so the browser's storage is the
// nearest honest equivalent to the control's memory.
const PROGRAMS = 'haassender.programs'
// Whatever comes out of storage is untrusted — a half-written value, or a
// different version's format. Anything that is not a list of entries is no
// directory at all, and the rest of the app must not have to check.
const loadedPrograms = store.get(PROGRAMS, [])
s.programs = Array.isArray(loadedPrograms)
  ? loadedPrograms.filter(p => p && typeof p.o === 'string' && typeof p.text === 'string')
  : []

const wantedBoard =
  new URLSearchParams(location.search).get('board') ||
  servedFromBoard() ||
  remember.get() ||
  ''

if (wantedBoard) {
  $('host').value = wantedBoard
  $('kind').value = 'websocket'
  // Knowing which machine this is and not connecting to it is the worst of both:
  // the pendant looks live while the readouts sit at zero, which is precisely the
  // lie a trainer must not tell. If we know where the machine is, go there.
  connect()
}

$('connect').onclick = connect
// The dev strip's file input is now an import into control memory, not a way to
// run a job: a student picks the program with LIST PROGRAM like they would on the
// machine. This is the only step of the workflow that has no pendant equivalent,
// because a real HAAS reads its USB port and a browser cannot.
$('file').onchange = async (e) => {
  const f = e.target.files[0]
  if (!f) return
  storeProgram(f.name, await f.text())
  e.target.value = ''          // so re-importing the same file fires change again
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
