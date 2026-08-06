import { render } from 'lit-html'
import { websocketTransport, serialTransport, simTransport, servedFromBoard } from './transport.js'
import { parseStatus, parseFeedback, parseOpt, Streamer, prepare, parseONumber, wireProgram, toolsUsed, words, editBlock, TOOL_COUNT, WCS, setWorkOffset, distanceToGo, describeAlarm, describeError, describeRecovery } from './grbl.js'
import { pendant } from './ui/pendant.js'
import { screen, displayScale } from './ui/screen.js'
import { MODES, DISPLAY_PANES, UNAVAILABLE, SHIFTED, VERIFIED, LEGEND } from './keys.js'

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
  // `dtg` is null whenever the running block does not say how far is left — see
  // distanceToGo(). The DRO shows dashes for it rather than a plausible zero.
  mpos: [0, 0, 0, 0], wco: [0, 0, 0, 0], dtg: null, operator: [0, 0, 0, 0],
  pendingHomeAxis: false,
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
  programs: [], listIndex: 0,
  // The four front-panel run switches. They are the sender's, not the machine's:
  // grbl has no optional-stop switch and no dry run, so this control owns them.
  blockDelete: false, optionStop: false, dryRun: false, singleBlock: false,
  program: { o: '', name: '', lines: [], current: 0 },
  job: null, plannerSize: 100,
  // The timers pane. `cycleStartedAt` is wall-clock rather than a tick count so a
  // throttled background tab cannot make a cycle look shorter than it was.
  cycleStartedAt: null, cycleMs: 0, lastCycleMs: 0, parts: 0,
  // The work offsets, keyed by the name `$#` reports them under, and the cell the
  // OFFSET page's cursor is on. `tools` is the one table the machine knows nothing
  // about — the board is built with N_TOOLS 0, so this control owns it.
  offsets: {}, offsetRow: 0, offsetCol: 0,
  offsetPage: 'work', tools: {}, toolRow: 0,
  // EDIT: which block, and which *word* in it. The HAAS cursor selects a word —
  // address plus value — and INSERT, ALTER and DELETE all act on that one word.
  editRow: 0, editWord: 0, undoStack: [],
  // MDI keeps what it ran, so an error can be shown against the block that caused
  // it rather than on its own.
  mdi: [], alarms: [], shifted: false,
  // The machine's own settings, as `$$` reports them. Read-only here: writing a
  // setting is a different kind of act from writing a work offset.
  settings: {}, paramRow: 0,
  // What the jog handle does, and which axis JOG LOCK has latched into a
  // continuous move. Both are front-panel state, not the machine's.
  handleMode: 'jog', latched: null,
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
  if (s.cycleStartedAt) s.cycleMs = Date.now() - s.cycleStartedAt
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

  // OFFSET carries two pages, as it does on the machine, and the key cycles them.
  if (id === 'page-offset' && s.activePane === 'offset') {
    s.offsetPage = s.offsetPage === 'work' ? 'tool' : 'work'
    return invalidate()
  }

  // Display keys move the white highlight; they do not change mode.
  if (DISPLAY_PANES[id]) { s.activePane = DISPLAY_PANES[id]; return invalidate() }

  // The SETTING page's one real setting. A HAAS keeps inch/metric in Setting 9;
  // grbl has no such store, so changing it means commanding the modal pair.
  if (s.activePane === 'setting' && (id === 'left' || id === 'right')) {
    return send(s.units === 'IN' ? 'G21' : 'G20')
  }

  // TOOL OFFSET: one column, so the cursor only walks rows.
  if (s.activePane === 'offset' && s.offsetPage === 'tool') {
    const dr = { up: -1, down: 1, 'page-up': -10, 'page-down': 10 }[id]
    if (dr !== undefined) {
      s.toolRow = Math.max(0, Math.min(TOOL_COUNT - 1, s.toolRow + dr))
      return invalidate()
    }
    if (id === 'home') { s.toolRow = 0; return invalidate() }
    if (id === 'end') { s.toolRow = TOOL_COUNT - 1; return invalidate() }
    if (id === 'tool-offset-measure') return toolOffsetMeasure()
  }

  // OFFSET: the cursor walks a grid of cells, one per axis per coordinate system.
  if (s.activePane === 'offset' && s.offsetPage === 'work') {
    const dr = { up: -1, down: 1, 'page-up': -5, 'page-down': 5 }[id]
    const dc = { left: -1, right: 1 }[id]
    if (dr !== undefined) {
      s.offsetRow = Math.max(0, Math.min(WCS.length - 1, s.offsetRow + dr))
      return invalidate()
    }
    if (dc !== undefined) {
      s.offsetCol = Math.max(0, Math.min(3, s.offsetCol + dc))
      return invalidate()
    }
    if (id === 'home') { s.offsetRow = 0; s.offsetCol = 0; return invalidate() }
    if (id === 'end') { s.offsetRow = WCS.length - 1; return invalidate() }
    if (id === 'part-zero-set') return partZeroSet()
  }

  // EDIT: the cursor walks the program by word, and four keys change it.
  if (editing()) {
    const move = {
      left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1],
      'page-up': [0, -12], 'page-down': [0, 12]
    }[id]
    if (move) return moveCursor(...move)
    if (id === 'home') { s.editRow = 0; s.editWord = 0; return invalidate() }
    if (id === 'end') { s.editRow = s.program.lines.length - 1; s.editWord = 0; return invalidate() }
    if (['insert', 'alter', 'delete', 'undo'].includes(id)) return editKey(id)
  }

  // PARAMETER / DIAGNOSTIC: the cursor walks the machine's settings, read-only.
  if (s.activePane === 'param') {
    const n = Object.keys(s.settings).length
    const dr = { up: -1, down: 1, 'page-up': -12, 'page-down': 12 }[id]
    if (dr !== undefined && n) {
      s.paramRow = Math.max(0, Math.min(n - 1, s.paramRow + dr))
      return invalidate()
    }
    if (id === 'home') { s.paramRow = 0; return invalidate() }
    if (id === 'end') { s.paramRow = Math.max(0, n - 1); return invalidate() }
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

  if (REALTIME[id] !== undefined) {
    link?.sendRealtime(REALTIME[id])
    // `Ov:` and `A:` are not in every report — grblHAL leaves them out of most
    // and refreshes them every so often — so an override or coolant key would
    // otherwise take a second or two to show up. Ask for a report instead of
    // assuming the press worked: the display still shows the machine, just sooner.
    link?.sendRealtime(0x3F)
    return
  }

  if (AXIS_KEYS[id]) { jogAxis(...AXIS_KEYS[id]); return }

  switch (id) {
    case 'cycle-start': return cycleStart()
    case 'feed-hold': return link?.sendRealtime(0x21)
    case 'reset': case 'estop':
      link?.sendRealtime(0x18)
      // Forget the job, do not merely pause it. Leaving the old line list in the
      // streamer made the next CYCLE START look like a resume — it sent a cycle
      // byte to a machine with nothing queued and never started the program.
      streamer?.reset()
      s.job = null
      s.cycleStartedAt = null      // an abandoned cycle is not a part
      s.latched = null             // a soft reset ends any latched jog too
      s.alarm = id === 'estop' ? 'EMERGENCY STOP (software)' : null
      s.message = id === 'estop' ? 'this is not a hardware E-stop' : ''
      return invalidate()

    case 'spindle-cw': return send('M3 S1000')
    case 'spindle-ccw': return send('M4 S1000')
    case 'spindle-stop': return send('M5')

    // Both are handled above when their page is up. Anywhere else there is no cell
    // to write, so say where they work rather than do nothing.
    case 'part-zero-set':
      s.message = 'press OFFSET first — PART ZERO SET writes into the work offset page'
      return invalidate()
    case 'tool-offset-measure':
      s.message = 'press OFFSET twice first — TOOL OFFSET MEASURE writes into the tool table'
      return invalidate()

    case 'select-program': return selectProgram()
    case 'erase-program': return eraseProgram()

    case 'block-delete': return toggleSwitch('blockDelete', 'BLOCK DELETE')
    case 'option-stop': return toggleSwitch('optionStop', 'OPTION STOP')
    case 'dry-run': return toggleSwitch('dryRun', 'DRY RUN')
    case 'single-block': return toggleSwitch('singleBlock', 'SINGLE BLOCK')

    case 'jog-lock':
      s.jogLock = !s.jogLock
      // Turning the lock off with a move latched would leave the machine running
      // and no key that stops it. Cancel first.
      if (!s.jogLock && s.latched !== null) { link?.sendRealtime(0x85); s.latched = null }
      s.message = `JOG LOCK ${s.jogLock ? 'ON — a jog key starts a continuous move' : 'OFF'}`
      return invalidate()

    // The handle stops jogging and becomes an override knob, as it does on the
    // machine. Pressing the same key again gives it back to jogging.
    case 'handle-feed': return setHandleMode('feed', 'HANDLE CONTROL FEED')
    case 'handle-spindle': return setHandleMode('spindle', 'HANDLE CONTROL SPINDLE')

    // ZERO RETURN. `$H` is the one mapping in this project that cannot be
    // confirmed against the bench machine — homing is built into that firmware but
    // has never been exercised, for want of real limit switches. It works against
    // the simulator, and it says as much rather than implying otherwise.
    case 'zero-all':
      s.message = 'homing — untested on this machine, no limit switches fitted'
      return send('$H')
    // G28 needs no limit switches: it is a move to a stored position, not a
    // homing search. Watched returning the machine from X15 Y8 Z12 to zero.
    case 'zero-home':
      s.message = 'returning to the G28 position'
      return send('G28')
    case 'zero-single':
      // A HAAS homes one axis at a time here, and asks which. grblHAL takes the
      // axis letter after `$H`.
      s.pendingHomeAxis = true
      s.message = 'ZERO SINGLE AXIS — press X, Y, Z or A'
      return invalidate()
    case 'zero-origin':
      // Zeroes the sender-side OPERATOR readout — a scratch measurement a student
      // takes without touching a work offset. It is ours, so it needs no machine.
      s.operator = [...s.mpos]
      s.message = 'OPERATOR position zeroed'
      return invalidate()

    case 'cancel':
      if (s.pendingHomeAxis) s.message = 'cancelled'
      s.input = ''
      s.pendingHomeAxis = false
      return invalidate()
    case 'shift': s.shifted = !s.shifted; return invalidate()
    case 'enter': return commitInput()
    case 'space': s.input += ' '; return invalidate()
  }

  // ZERO RETURN → SINGLE asked which axis; this is the answer.
  if (s.pendingHomeAxis && /^alpha-[xyza]$/.test(id)) {
    const axis = id.slice(-1).toUpperCase()
    s.pendingHomeAxis = false
    s.message = `homing ${axis} — untested on this machine, no limit switches fitted`
    return send('$H' + axis)
  }

  // Alpha and numeric keys type into the input bar.
  const typed = typedChar(id)
  if (typed !== null) { s.input += typed; return invalidate() }

  // Nothing above claimed it. A key that is not in VERIFIED is simply not built,
  // and saying so beats sitting mute — the same reason the impossible keys give
  // their reason. A verified key that lands here did nothing on purpose, because
  // there is nothing for it to do on this pane, and it stays quiet.
  if (!VERIFIED.has(id)) {
    s.message = `${LEGEND[id] ?? id} — not implemented yet`
    return invalidate()
  }
}

function typedChar (id) {
  // SHIFT reaches the yellow legend above the key, and is one-shot like the real
  // one. `$` lives above the 5, which is the only way to type `$X` or `$H` here.
  if (s.shifted && SHIFTED[id]) { s.shifted = false; return SHIFTED[id] }
  if (id.startsWith('alpha-')) return id.slice(6).toUpperCase()
  if (id.startsWith('num-')) return id.slice(4)
  if (id === 'minus') return '-'
  if (id === 'dot') return '.'
  if (id === 'semicolon') return ';'
  if (id === 'paren-open') return '('
  if (id === 'paren-close') return ')'
  return null
}

// ---------------------------------------------------------------- work offsets

const AXIS_LETTERS = ['X', 'Y', 'Z', 'A']

/**
 * Write one cell of the OFFSET page.
 *
 * The value is in whatever unit the control is displaying, and `G10 L2` reads its
 * words in the *modal* unit — which is the same thing, because the SETTING page
 * keeps the two in step. `$#` is re-read afterwards rather than the table being
 * patched locally: the machine is the record, and if the write were rejected a
 * locally-patched table would show an offset the machine does not have.
 */
function writeOffset (value) {
  const w = WCS[s.offsetRow]
  const axis = AXIS_LETTERS[s.offsetCol]
  send(setWorkOffset(w.p, axis, value))
  link?.send('$#\n')
  s.message = `${w.name} ${axis} set to ${Number(value).toFixed(4)}`
  invalidate()
}

/**
 * PART ZERO SET — the most-used setup key on a real HAAS. Stores where the
 * machine is now into the highlighted cell, so the operator jogs to the corner of
 * the part and presses one key.
 *
 * Machine position arrives in the report unit and `G10 L2` speaks the modal unit,
 * so this converts. Getting that wrong would put a work zero 25.4 times too far
 * out, which on a real machine is how you find out where the table ends.
 */
function partZeroSet () {
  if (s.stale) { s.message = 'no position from the machine — cannot set part zero'; return invalidate() }
  const k = displayScale(s.reportUnits, s.units)
  writeOffset(s.mpos[s.offsetCol] * k)
}

// --------------------------------------------------------------------- alarms

/**
 * Keep what went wrong, newest first, so the ALARMS page has something to show.
 * The same fault repeating four times a second while a machine sits in Alarm is
 * one event, not four, so a repeat of the head of the list is folded into it.
 */
function logAlarm (kind, code, text, recovery) {
  const head = s.alarms[0]
  if (head && head.kind === kind && head.code === code) return
  s.alarms = [{ kind, code, text, recovery }, ...s.alarms].slice(0, 20)
}

// ------------------------------------------------------------------ EDIT mode

// EDIT mode *and* the program on screen. An operator who has paged away to
// POSITION should not be editing a program they cannot see.
const editing = () =>
  s.mode === 'EDIT' && s.fn === 'EDIT' &&
  s.activePane === 'program' && s.program.lines.length > 0
const editLine = () => s.program.lines[s.editRow]

/** Clamp the cursor after the program under it has changed shape. */
function clampCursor () {
  s.editRow = Math.max(0, Math.min(s.program.lines.length - 1, s.editRow))
  const n = words(editLine()?.text).length
  s.editWord = Math.max(0, Math.min(Math.max(0, n - 1), s.editWord))
}

/**
 * Move the cursor by whole words, running on into the next block at the end of
 * one — which is how a HAAS cursor behaves, and the reason it is a word cursor
 * and not a character one.
 */
function moveCursor (dWord, dRow) {
  if (dRow) {
    s.editRow = Math.max(0, Math.min(s.program.lines.length - 1, s.editRow + dRow))
    s.editWord = 0
    return invalidate()
  }
  const n = words(editLine()?.text).length
  const next = s.editWord + dWord
  if (next < 0) {
    if (s.editRow === 0) return invalidate()
    s.editRow--
    s.editWord = Math.max(0, words(editLine()?.text).length - 1)
  } else if (next >= n) {
    if (s.editRow >= s.program.lines.length - 1) return invalidate()
    s.editRow++
    s.editWord = 0
  } else {
    s.editWord = next
  }
  invalidate()
}

/**
 * Every edit goes through here, so every edit is undoable and every edit is
 * written back to control memory. An editor that can change a program but not
 * put it back is a toy.
 */
function applyEdit (lines, message) {
  s.undoStack.push({
    lines: s.program.lines.map(l => ({ ...l })),
    editRow: s.editRow,
    editWord: s.editWord
  })
  if (s.undoStack.length > 50) s.undoStack.shift()

  s.program = { ...s.program, lines }
  clampCursor()
  saveEditedProgram()
  s.message = message
  invalidate()
}

/** Put the edited program back into control memory, under the same O-number. */
function saveEditedProgram () {
  const at = s.programs.findIndex(p => p.o === s.program.o)
  if (at < 0) return             // not from the directory — an MDI scratch block
  s.programs[at] = { ...s.programs[at], text: s.program.lines.map(l => l.text).join('\n') }
  if (!saveDirectory()) s.message = 'edit not stored — browser storage refused'
}

function editKey (id) {
  const line = editLine()
  const typed = s.input.trim()

  if (id === 'undo') {
    const back = s.undoStack.pop()
    if (!back) { s.message = 'nothing to undo'; return invalidate() }
    s.program = { ...s.program, lines: back.lines }
    s.editRow = back.editRow
    s.editWord = back.editWord
    saveEditedProgram()
    s.message = `undo — ${s.undoStack.length} left`
    return invalidate()
  }

  if (id === 'delete') {
    // Nothing typed and the block has one word left: the block itself goes.
    const w = words(line.text)
    const lines = w.length <= 1
      ? s.program.lines.filter((_, i) => i !== s.editRow)
      : s.program.lines.map((l, i) =>
          i === s.editRow ? { ...l, text: editBlock(l.text, s.editWord, 'delete') } : l)
    if (!lines.length) { s.message = 'a program needs at least one block'; return invalidate() }
    s.input = ''
    return applyEdit(lines, w.length <= 1 ? 'block deleted' : `deleted ${w[s.editWord]}`)
  }

  if (!typed) {
    s.message = `type the word first, then ${id === 'alter' ? 'ALTER' : 'INSERT'}`
    return invalidate()
  }

  s.input = ''
  if (id === 'alter') {
    const lines = s.program.lines.map((l, i) =>
      i === s.editRow ? { ...l, text: editBlock(l.text, s.editWord, 'alter', typed) } : l)
    return applyEdit(lines, `altered to ${typed}`)
  }

  // INSERT after the cursor. On a block that is only a comment, or at the end of
  // the program, this is how a new block gets written.
  const lines = s.program.lines.map((l, i) =>
    i === s.editRow ? { ...l, text: editBlock(l.text, s.editWord, 'insert', typed) } : l)
  s.editWord++
  return applyEdit(lines, `inserted ${typed}`)
}

// ------------------------------------------------------------------ tool table

const TOOLS = 'haassender.tools'

/** Returns false when the table could not be persisted; the caller must say so. */
const saveTools = () => store.set(TOOLS, s.tools)

/** One message for both ways of writing a tool length, storage failure included. */
const toolWritten = (n, shown, persisted) => {
  s.message = (persisted ? '' : 'NOT STORED (browser storage refused) — ') +
    `T${String(n).padStart(2, '0')} length set to ${shown.toFixed(4)}`
  invalidate()
}

/**
 * TOOL OFFSET MEASURE — record where this tool's tip is.
 *
 * The operator jogs the tip down to the reference surface and presses this. What
 * gets stored is the machine Z, unconverted and un-negated, because that is
 * exactly the number `G43.1` wants: with the work Z offset at zero, `G43.1 Z<m>`
 * makes work Z read zero at machine Z = m. Verified on the board, where
 * `G43.1 Z-10` put -10.000 into both `[TLO:]` and `WCO`.
 */
function toolOffsetMeasure () {
  if (s.stale) { s.message = 'no position from the machine — cannot measure'; return invalidate() }
  const n = s.toolRow + 1
  s.tools = { ...s.tools, [n]: s.mpos[2] }
  toolWritten(n, s.mpos[2] * displayScale(s.reportUnits, s.units), saveTools())
}

// ------------------------------------------------------------- the run switches

/**
 * These change what goes on the wire, so they take effect at the next CYCLE
 * START, not in the middle of a program: the blocks after the tool are already
 * in the controller's planner and cannot be recalled. Say so rather than let an
 * operator believe a switch they just pressed applies to the cut in progress.
 */
function toggleSwitch (key, label) {
  s[key] = !s[key]
  if (key === 'singleBlock' && streamer) streamer.singleBlock = s.singleBlock
  s.message = `${label} ${s[key] ? 'ON' : 'OFF'}` +
    (s.job && key !== 'singleBlock' ? ' — takes effect at the next CYCLE START' : '')
  return invalidate()
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
  s.program = { o: p.o, name: p.name, lines: prepare(p.text), current: 0 }
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

/**
 * WRITE/ENTER. What it does depends on which pane is active — that is the whole
 * point of the active-pane model, and the reason exactly one pane is white.
 *
 * On a data-entry pane it commits the typed value into the highlighted cell. On
 * any other, it is MDI: the typed text goes to the machine as a block.
 */
function commitInput () {
  const v = s.input.trim()

  if (s.activePane === 'offset') {
    if (!v) {
      s.message = s.offsetPage === 'tool'
        ? 'type a length first, or press TOOL OFFSET MEASURE'
        : 'type a value first, or press PART ZERO SET'
      return invalidate()
    }
    // A control that quietly writes zero because the operator typed "12x" is
    // worse than one that refuses. Offsets move the machine's idea of the part.
    if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(v)) {
      s.message = `"${v}" is not a number`
      return invalidate()
    }
    s.input = ''
    if (s.offsetPage === 'tool') {
      const n = s.toolRow + 1
      // Typed in the displayed unit; stored in the machine's, like everything else
      // in this table, so `G43.1` can use it without a second conversion.
      s.tools = { ...s.tools, [n]: Number(v) * displayScale(s.units, s.reportUnits) }
      return toolWritten(n, Number(v), saveTools())
    }
    return writeOffset(Number(v))
  }

  // The PARAMETER page is read-only, so WRITE/ENTER on it means "ask again". A
  // typed value must not fall through and be sent as g-code — the operator was
  // aiming at a settings row, and `$20=1` typed by accident changes the machine.
  if (s.activePane === 'param') {
    s.input = ''
    if (v) {
      s.message = 'this page is read-only — change a setting from MDI, e.g. $20=1'
      return invalidate()
    }
    s.message = 'reading settings'
    send('$$')
    return invalidate()
  }

  s.input = ''
  if (!v) return invalidate()

  if (s.activePane === 'mdi') {
    s.mdi = [...s.mdi, { text: v }].slice(-12)
    s.message = ''
  }
  send(v)
  invalidate()
}

function send (line) {
  if (!link) { s.message = 'not connected'; return invalidate() }

  // Not while a program is running, and this is a correctness rule rather than a
  // policy. grbl answers every line it accepts with `ok`, and the streamer counts
  // those acks to know how full the controller's receive buffer is. A line slipped
  // in from the keypad returns an ok the streamer credits against a block still in
  // flight, so its estimate drifts high until it overruns the buffer for real.
  //
  // It is also what the machine does. A HAAS will not take MDI during a cycle, and
  // a block sent mid-program would not do what a student expects anyway: it would
  // queue behind everything already in the planner rather than act now.
  if (s.job) { s.message = 'not while a program is running'; return invalidate() }

  link.send(line + '\n')
  // Ask what that did to the modal state rather than assume. Units, work offset
  // and spindle mode all live in `$G`, and a control that displays the unit it
  // last *requested* is wrong the moment a block changes it.
  // ponytail: only manual sends refresh this, so a program that switches G20
  // mid-job is not noticed until it ends. Poll `$G` slowly if that ever matters.
  link.send('$G\n')
}

/**
 * How far a latched jog runs. grbl has no "jog until I say stop", so continuous
 * jog is a move long enough to outlast the operator, cancelled with `0x85`.
 *
 * The machine's own declared travel (`$130`+) is the right length: it is as far
 * as the axis can go, so the move ends where the machine would have stopped
 * anyway. Falling back to a constant would either stop short on a big machine or
 * ask a small one to travel further than it can.
 */
function jogTravel (axis) {
  const declared = Number(s.settings[130 + axis])
  return Number.isFinite(declared) && declared > 0 ? declared : 200
}

function jogAxis (axis, dir) {
  if (!link) return

  // JOG LOCK: the key latches. Press once for a continuous move, press any jog
  // key again to stop it — which is `0x85`, jog cancel, not a reset, so the
  // machine decelerates properly and keeps its position.
  if (s.jogLock) {
    if (s.latched !== null) {
      link.sendRealtime(0x85)
      s.latched = null
      s.message = 'jog cancelled'
      return invalidate()
    }
    const distance = (jogTravel(axis) * dir).toFixed(3)
    link.send(`$J=G91 F${JOG_FEED[s.units]} ${'XYZA'[axis]}${distance}\n`)
    s.latched = axis
    s.message = `${'XYZA'[axis]} jogging — press a jog key to stop`
    return invalidate()
  }

  const step = (increment() * dir).toFixed(4)
  link.send(`$J=G91 F${JOG_FEED[s.units]} ${'XYZA'[axis]}${step}\n`)
}

function setHandleMode (mode, label) {
  s.handleMode = s.handleMode === mode ? 'jog' : mode
  s.message = s.handleMode === mode
    ? `${label} — the handle now trims the override, 1% a click`
    : 'the handle jogs again'
  return invalidate()
}

/** An override byte, plus a request for a report so the readout follows at once. */
function override (byte) {
  link?.sendRealtime(byte)
  link?.sendRealtime(0x3F)
}

/**
 * The handle. Normally it jogs; HANDLE CONTROL FEED and HANDLE CONTROL SPINDLE
 * turn it into an override knob, as they do on the machine.
 *
 * A click is **one percent**, not ten: grbl has 0x93/0x94 and 0x9C/0x9D for that,
 * measured on the board — three clicks of 0x93 read back `Ov:103`. Ten percent a
 * click would make the handle useless for the trimming it exists to do.
 */
function jogWheel (dir) {
  s.dial = (s.dial + dir * 18) % 360
  invalidate()
  if (s.handleMode === 'feed') return override(dir > 0 ? 0x93 : 0x94)
  if (s.handleMode === 'spindle') return override(dir > 0 ? 0x9C : 0x9D)
  jogAxis(0, dir)     // the dial jogs the axis the operator has selected; X for now
}

function cycleStart () {
  // The machine is holding — from FEED HOLD, or from an M00/M01 the program ran
  // into. CYCLE START continues it, and that is the whole point of OPTION STOP:
  // the program stops, the operator looks at the part, the operator restarts.
  // This has to come first. A hold raised by M01 mid-program leaves the streamer
  // running, so every check below would miss it and the machine would sit held
  // while CYCLE START appeared to do nothing.
  if (/^Hold/.test(s.machineState)) {
    s.message = 'resuming'
    link?.sendRealtime(0x7E)
    return invalidate()
  }

  // Mid-cycle. In SINGLE BLOCK this is the key that steps to the next block;
  // otherwise it does nothing at all. It must not fall through to the code below
  // and restart the program from the top with the tool still in the cut.
  if (s.job && streamer?.running) {
    if (s.singleBlock) {
      // One press, one block — and the block has to finish first. grbl acks on
      // buffering, not on execution, so releasing on the ack alone would let a
      // quick second press drop two blocks into the planner and run them straight
      // through, which is exactly the pause SINGLE BLOCK exists to provide.
      if (/^(Run|Jog|Home)/.test(s.machineState)) {
        s.message = 'block still running'
        return invalidate()
      }
      streamer.release()
      return invalidate()
    }
    s.message = 'already running'
    return invalidate()
  }

  // A program that stopped on a rejected block, or a machine sitting in alarm.
  // Starting from the top would send the tool back through everything it has
  // already cut, with the fault still there. RESET is the acknowledgement that
  // the operator has looked, and it is what clears the streamer.
  if (streamer?.error) {
    s.message = `press RESET first — the program stopped on error ${streamer.error.code} at block ${streamer.error.line}`
    return invalidate()
  }
  if (/^Alarm/.test(s.machineState)) {
    s.message = 'machine is in alarm — press ALARMS to see what clears it'
    return invalidate()
  }

  if (!s.program.lines.length) {
    s.message = 'no program selected — press LIST PROGRAM, then SELECT PROGRAM'
    return invalidate()
  }

  // Build the wire program now, so the switches read at CYCLE START are the ones
  // that govern the whole cycle. `rows` keeps the running-block highlight pointing
  // at the source line, which a switch that removes blocks would otherwise skew.
  const { wire, rows } = wireProgram(s.program.lines, s)
  if (!wire.length) {
    s.message = 'every block is switched out — nothing to run'
    return invalidate()
  }

  // A program that asks for a tool offset nobody measured gets zero, which is the
  // one number certain to be wrong. Run anyway — refusing would be worse on a
  // machine with no tools fitted — but never let it happen quietly.
  const unmeasured = toolsUsed(s.program.lines).filter(n => n > 0 && s.tools[n] === undefined)
  if (unmeasured.length) {
    s.message = `no tool length measured for ${unmeasured.map(n => 'H' + n).join(', ')} — running with no offset`
  }

  s.alarm = null
  s.mode = 'OPERATION'; s.fn = 'MEM'
  s.activePane = 'program'
  s.cycleStartedAt = Date.now(); s.cycleMs = 0
  s.job = { sentAll: false, rows }
  streamer.singleBlock = s.singleBlock
  streamer.start(wire)
  if (s.singleBlock) streamer.release()
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
    logAlarm('ALARM', n, describeAlarm(n), describeRecovery(n))
    return invalidate()
  }
  if (line.startsWith('error:')) {
    const n = Number(line.slice(6))
    s.message = `error ${n} — ${describeError(n)}`
    // Pin it to the MDI block that caused it. A student typing blocks by hand
    // learns far more from "G1 X10 — needs a feed rate" than from the code alone.
    const last = s.mdi[s.mdi.length - 1]
    if (last && !last.error) last.error = `error ${n}: ${describeError(n)}`
    logAlarm('ERROR', n, describeError(n), null)
    return invalidate()
  }

  // A settings echo, `$13=0`. `$13` is the one that matters up here: it is the
  // report-unit flag, 0 millimetres and 1 inches, and it governs what `MPos:`
  // means. G20/G21 does NOT — verified on the ClearCore, where `G20` is accepted
  // and the very next report still comes back in millimetres.
  const setting = line.match(/^\$(\d+)=(.*)$/)
  if (setting) {
    if (setting[1] === '13') s.reportUnits = setting[2].trim() === '1' ? 'IN' : 'MM'
    s.settings = { ...s.settings, [setting[1]]: setting[2].trim() }
    return invalidate()
  }

  // A bare `ok` is the machine acknowledging a block we sent by hand. It is not
  // news, and posting it wipes the message that explained what just happened —
  // "G55 Y set to -12.5000" became "ok" a quarter of a second later.
  if (line === 'ok') return

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
    // The modal string carries the selected tool, which is the only place this
    // control can learn it — the board has no tool table to ask.
    const t = fb.value.match(/\bT(\d+)/)
    if (t) s.tool = Number(t[1])
  } else if (fb.kind === 'TLO') {
    s.tlo = fb.value[2] ?? 0
  } else if (/^G5[4-9](\.[1-3])?$/.test(fb.kind)) {
    s.offsets = { ...s.offsets, [fb.kind]: fb.value }
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
    // `Bf:` counts planner blocks still to be *completed*, which includes the one
    // under the tool right now. So acked minus queued is the index of the block
    // being executed, not of the last one finished — subtracting a further 1, as
    // this did, highlighted the previous block for the whole program. DIST TO GO
    // is what exposed it: it read zero on an axis the machine was visibly moving.
    const queued = Math.max(0, s.plannerSize - st.bf.blocks)
    const wireAt = Math.max(0, streamer.acked - queued)
    // ...and back to the source row, because the run switches may have removed
    // blocks between the listing and the wire.
    const row = s.job.rows[Math.min(wireAt, s.job.rows.length - 1)] ?? 0
    s.program.current = row + 1

    const block = s.program.lines[s.program.current - 1]?.text
    s.dtg = distanceToGo(block, {
      mpos: s.mpos,
      wco: s.wco,
      absolute: !/\bG91\b/.test(s.modal ?? ''),
      scale: displayScale(s.units, s.reportUnits)   // modal unit -> report unit
    })
  } else if (!s.job) {
    s.dtg = null            // nothing running, nothing left to travel
  }

  if (s.job?.sentAll && st.state === 'Idle') {
    s.job = null
    s.message = 'program complete'
    s.program.current = 0
    // A cycle that finished is a part made, and the counter is what a shop
    // actually watches. Only a completed cycle counts — one stopped by RESET
    // clears the timer without incrementing anything.
    s.lastCycleMs = s.cycleMs
    s.parts++
    s.cycleStartedAt = null
    // A program can leave the modal state, the work offsets and the tool length
    // offset anywhere at all. Re-read rather than assume they survived the cycle.
    link?.send('$G\n')
    link?.send('$#\n')
  }
  // Only when the machine actually told us. grblHAL leaves `A:` out of most
  // reports and refreshes it every so often — measured on the board, flood stayed
  // on through reports with no `A:` at all — so treating its absence as "off"
  // made the spindle direction and the coolant lamp flicker to nothing several
  // times a second during a cut. An empty `A:` is different: that is the machine
  // saying everything is off, and it counts.
  if (st.accessory !== undefined) {
    s.spindleDir = st.accessory.includes('S') ? 1 : st.accessory.includes('C') ? -1 : 0
    s.coolant = st.accessory.includes('F')
  }
  // A latched jog that ran to the end of its travel, or was cancelled, is over —
  // the lamp must not go on claiming the machine is still moving.
  if (s.latched !== null && st.state !== 'Jog') s.latched = null

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
    // Everything the machine will tell us about itself. `$$` costs one dump of
    // ~40 lines at connect and pays for the PARAMETER page, `$13` (which unit
    // `MPos:` arrives in) and `$130`+ (how far a latched jog may run).
    link.send('$$\n')
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
const loadedTools = store.get(TOOLS, {})
s.tools = (loadedTools && typeof loadedTools === 'object' && !Array.isArray(loadedTools))
  ? Object.fromEntries(Object.entries(loadedTools).filter(([, v]) => Number.isFinite(v)))
  : {}

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
