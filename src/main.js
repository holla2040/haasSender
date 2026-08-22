import { render } from 'lit-html'
import { websocketTransport, serialTransport, simTransport, servedFromBoard } from './transport.js'
import { toolPath } from './sim.js'
import { parseStatus, parseFeedback, parseOpt, Streamer, prepare, parseONumber, parseOWord, wireProgram, WireError, homeG28, toolsUsed, stripComments, words, editBlock, WCS, setWorkOffset, distanceToGo, describeAlarm, describeError, describeRecovery } from './grbl.js'
import { pendant } from './ui/pendant.js'
import { screen, displayScale, HELP_ROWS, PANE_ROWS, PROGRAM_ROWS, helpTotal, helpFrom, HELP_SECTIONS } from './ui/screen.js'
import { MODES, DISPLAY_PANES, UNAVAILABLE, SHIFTED, VERIFIED, LEGEND, keyForChar } from './keys.js'
import { SETTINGS, settingValue, settingOn, maxTools, settingDefaults, settingsFromStore, clampSetting, nextChoice, rowOfSetting } from './settings.js'

const $ = (id) => document.getElementById(id)
const STATUS_IDLE_MS = 500

// The board auto-pushes a report every 250 ms and we poll after 500 ms of
// silence, so two seconds without one means the link is gone, not merely quiet.
// Long enough that a busy tab or a slow serial write does not flicker it.
const STALE_MS = 2000

// Handle-jog increments. The keys are printed with both scales — ".0001 / .1" —
// and the manual (T2.8, printed p.39) states the metric value is the inch
// legend ×10: ".0001 becomes 0.001mm". The second printed number is the
// dry-run jog rate, not a metric increment — misread here once, at 100× cost.
const INCREMENT_KEYS = ['inc-0001', 'inc-001', 'inc-01', 'inc-1']
const INCREMENTS = { IN: [0.0001, 0.001, 0.01, 0.1], MM: [0.001, 0.01, 0.1, 1] }
// The BOTTOM legend of the same keys is the dry-run feed (T2.8), in/min.
const DRY_RUN_FEED = { IN: [0.1, 1, 10, 100], MM: [2.54, 25.4, 254, 2540] }
const JOG_FEED = { IN: 100, MM: 2540 }

const AXIS_KEYS = {
  'jog-x-plus': [0, +1], 'jog-x-minus': [0, -1],
  'jog-y-plus': [1, +1], 'jog-y-minus': [1, -1],
  'jog-z-plus': [2, +1], 'jog-z-minus': [2, -1],
  // The rotary pair's PRIMARY legends: 'jog-b-plus' is printed "-A/C" and
  // 'jog-a-plus' is printed "+A/C" (F2.26 at 400 dpi). Signs follow the print.
  'jog-b-plus': [3, -1], 'jog-a-plus': [3, +1]
}

const REALTIME = {
  'feed-100': 0x90, 'feed-plus': 0x91, 'feed-minus': 0x92,
  'spindle-100': 0x99, 'spindle-plus': 0x9A, 'spindle-minus': 0x9B,
  'rapid-100': 0x95, 'rapid-50': 0x96, 'rapid-25': 0x97,
  'coolant': 0xA0
}

/**
 * A fresh MDI page. §4.2.3: "Your input stays on the MDI input page until you
 * delete it" — so the page is emptied in exactly two places, power-up and ERASE
 * PROGRAM, and nowhere else.
 */
const blankMdi = () => ({ o: '', name: 'MDI', lines: [], current: 0 })

const s = {
  // Is the control switched on at all? Distinct from whether the machine is
  // answering: a powered control with a dead link shows LINK DOWN and blanked
  // readouts, but a control that is *off* shows nothing, because an unlit screen
  // is what a machine with its power off actually looks like.
  powered: false,
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
  tool: 0, tlo: 0, coolant: false, tsc: false, chipFwd: false, jogLock: false,
  alarm: null, message: '', input: '',
  // Control memory: the program directory, filed by O-number the way a HAAS files
  // it, and whichever one is currently selected to run. `pendingErase` holds the
  // O-number ERASE PROGRAM has asked about — the number, not the cursor row, so
  // that what gets deleted is what the prompt named.
  programs: [], listIndex: 0, pendingErase: null,
  // The four front-panel run switches. BLOCK DELETE and OPTION STOP are the
  // firmware's own on grblHAL ($B/$O — the parser skips, which also covers jobs
  // run from the machine's card); their lamps follow the Pn: report. SINGLE
  // BLOCK stays sender-side until $S's hold-after-every-block feel is bench-
  // judged against a real HAAS; DRY RUN is the sender's, grbl has none.
  blockDelete: false, optionStop: false, dryRun: false, singleBlock: false,
  // What the connected firmware can do, learned from $I: `toolTable` is the
  // trailing field of [OPT:] (0 stock, 32 on the haasSender branch firmware),
  // `expr` is EXPR in NEWOPT. `runSwitches` is true for every current transport
  // (grblHAL and the sim); it exists so a classic-grbl serial board can fall
  // back to sender-side stripping the day Web Serial is bench-tested.
  caps: { runSwitches: true, toolTable: false, expr: false, haas: false }, optSynced: false,
  // Did the machine ever answer `$I`? Not the same question as "does it have
  // the parity firmware" — see askIdentity().
  idSeen: false,
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
  // MDI — §4.2.3 p.114. A program page, not a command line: what is typed stays
  // on it until it is deleted, CYCLE START runs it, and the same editor keys that
  // work on a program work on it. Same shape as `program` for exactly that reason
  // — one editor, one CYCLE START, two things they can point at.
  mdi: blankMdi(), alarms: [], shifted: false, plot: null,
  // The machine's own settings, as `$$` reports them. Read-only here: writing a
  // setting is a different kind of act from writing a work offset.
  settings: {}, paramRow: 0,
  // THIS control's settings — the HAAS ones on the SETTING page, which are a
  // different thing entirely from the machine's `$$` above. Defaults until
  // POWER ON reads what was stored, because a control reads its settings when it
  // powers up and there is nothing to read them for before that.
  set: settingDefaults(), setRow: 0,
  // The handwheel: what it does, which axis it moves, and which axis JOG LOCK has
  // latched into a continuous move. All front-panel state, none of it the
  // machine's. `jogAxis` is chosen by pressing a jog key, as on the machine —
  // without it the handle only ever moved X.
  handleMode: 'jog', jogAxis: 0, latched: null,
  // The machine's SD card. grblHAL exposes it on the grbl stream itself — `$F`
  // lists, `$F<=` dumps, `$F=` runs — so RECEIVE works over any transport. SEND
  // is the exception: there is no write-file command, only the HTTP endpoint.
  sdFiles: [], sdIndex: 0, listPage: 'memory', receiving: null, boardHost: null,
  helpRow: 0,
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
  // A control with its power off does nothing, and says nothing, because there is
  // no lit screen to say it on. Only POWER ON gets through — which is exactly how
  // you learn a machine: the panel is dark and one button is not.
  if (!s.powered && id !== 'power-on') return

  // §3.3.4 step 4: ERASE PROGRAM has asked, and this press is the answer. Y
  // erases; everything else cancels and is swallowed, which is stricter than the
  // manual's Y/N pair on purpose — an armed delete that outlived an unrelated
  // keypress could go off later against whatever the cursor had moved to since,
  // and this is the one action in the control with no UNDO behind it.
  //
  // RESET and E-STOP are the exception. They are never merely an answer to a
  // prompt, so they cancel it and go on to do their own job.
  if (s.pendingErase) {
    const o = s.pendingErase
    s.pendingErase = null
    if (id !== 'reset' && id !== 'estop') {
      if (id === 'alpha-y') return eraseConfirmed(o)
      s.message = `${o} not erased`
      return invalidate()
    }
  }

  // Say why, rather than swallow the press. A key that looks live and does
  // nothing teaches a student that the control is unreliable; one that explains
  // itself teaches them what the machine underneath can actually do.
  const why = UNAVAILABLE.get(id)
  if (why) { s.message = why; return invalidate() }

  // LIST PROGRAM steps back from the card to control memory, before the mode keys
  // get it — otherwise there is no way off the card page except another mode.
  if (id === 'mode-list' && s.activePane === 'list' && s.listPage === 'sd') {
    s.listPage = 'memory'
    return invalidate()
  }

  // Mode keys — three modes only, per T2.11. The edit cursor and its undo history
  // belong to the program under them, so moving between EDIT and MDI leaves both
  // behind: an UNDO carried across would put one program's blocks on the other's
  // page, and the cursor would land wherever the last program happened to be long.
  if (MODES[id]) {
    // Only when the key moves to a DIFFERENT editable window. The mode keys with
    // no pane of their own — HANDLE JOG, MEMORY, ZERO RETURN — leave the editor
    // where it stands, so a glance at the DRO mid-edit does not cost the undo
    // history it took a dozen presses to build.
    const pane = MODES[id].activePane
    if (pane && pane !== s.activePane) { s.editRow = 0; s.editWord = 0; s.undoStack = [] }
    Object.assign(s, MODES[id])
    return invalidate()
  }

  // §3.8: SETTING/GRAPHIC carries two pages, and the manual's step 1 is "press
  // [SETTING/GRAPHIC] until the GRAPHICS page is displayed". Pressing it on the
  // graphics page falls through to DISPLAY_PANES and lands back on SETTING.
  if (id === 'page-setting' && s.activePane === 'setting') {
    s.activePane = 'graphics'
    return invalidate()
  }

  // OFFSET carries two pages, as it does on the machine, and the key cycles them.
  if (id === 'page-offset' && s.activePane === 'offset') {
    s.offsetPage = s.offsetPage === 'work' ? 'tool' : 'work'
    return invalidate()
  }

  // Display keys move the white highlight; they do not change mode.
  if (DISPLAY_PANES[id]) { s.activePane = DISPLAY_PANES[id]; return invalidate() }

  // SETTING: a list with a cursor, §2.4 p.65. The vertical keys walk it, the
  // horizontal keys change the row underneath, and a typed number jumps.
  if (s.activePane === 'setting') {
    // p.66: "you can type the number of a parameter, setting, or alarm that you
    // want to view, then press the [UP] or [DOWN] cursor arrow to view it."
    // Checked before the plain cursor move, or typing 31 and pressing DOWN would
    // step one row and drop the number on the floor.
    if ((id === 'up' || id === 'down') && s.input.trim()) {
      const want = Number(s.input.trim())
      const at = rowOfSetting(want)
      s.input = ''
      if (at < 0) {
        s.message = `setting ${want} is not on this control — see the SETTING page for what is`
        return invalidate()
      }
      s.setRow = at
      return invalidate()
    }
    const dr = { up: -1, down: 1, 'page-up': -PANE_ROWS, 'page-down': PANE_ROWS }[id]
    if (dr !== undefined) {
      s.setRow = Math.max(0, Math.min(SETTINGS.length - 1, s.setRow + dr))
      return invalidate()
    }
    if (id === 'home') { s.setRow = 0; return invalidate() }
    if (id === 'end') { s.setRow = SETTINGS.length - 1; return invalidate() }
    const dc = { left: -1, right: 1 }[id]
    if (dc !== undefined) return changeSetting(SETTINGS[s.setRow], dc)
  }

  // TOOL OFFSET: one column, so the cursor only walks rows.
  if (s.activePane === 'offset' && s.offsetPage === 'tool') {
    // One short of PANE_ROWS: the tool pane spends a row on its heading.
    const dr = { up: -1, down: 1, 'page-up': 1 - PANE_ROWS, 'page-down': PANE_ROWS - 1 }[id]
    if (dr !== undefined) {
      // Setting 90: the cursor stops where the page does, or END would land on a
      // row nothing draws and TOOL OFFSET MEASURE would write to a tool the
      // operator cannot see.
      s.toolRow = Math.max(0, Math.min(maxTools(s) - 1, s.toolRow + dr))
      return invalidate()
    }
    if (id === 'home') { s.toolRow = 0; return invalidate() }
    if (id === 'end') { s.toolRow = maxTools(s) - 1; return invalidate() }
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

  // EDIT and MDI: the cursor walks the program by word, and four keys change it.
  // §4.2.1 step 1 gives both windows the same editor, and HOME here is the first
  // half of the §4.2.3 save — the cursor has to reach the top of the MDI page.
  if (editing()) {
    const move = {
      left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1],
      'page-up': [0, -PANE_ROWS], 'page-down': [0, PANE_ROWS]
    }[id]
    if (move) return moveCursor(...move)
    if (id === 'home') { s.editRow = 0; s.editWord = 0; return invalidate() }
    if (id === 'end') { s.editRow = Math.max(0, target().lines.length - 1); s.editWord = 0; return invalidate() }
    if (['insert', 'alter', 'delete', 'undo'].includes(id)) return editKey(id)
  }

  // PROGRAM, outside the editor: the cursor walks the listing. §4.2.1 p.115 step
  // 7 — "use the jog handle or cursor keys to scroll through the program code" —
  // and until this existed a selected program could only be READ by entering
  // EDIT mode, which is not where anybody runs one from.
  if (s.activePane === 'program') {
    const move = {
      up: -1, down: 1, 'page-up': -PROGRAM_ROWS, 'page-down': PROGRAM_ROWS,
      home: -1e9, end: 1e9
    }[id]
    if (move !== undefined) return programCursor(move)
  }

  // HELP is longer than the pane. PAGE UP and PAGE DOWN turn it, as they turn the
  // manual on the machine; the arrows step a line for anyone who prefers that.
  if (s.activePane === 'help') {
    const d = { 'page-down': HELP_ROWS, 'page-up': -HELP_ROWS, down: 1, up: -1 }[id]
    if (d !== undefined) { s.helpRow = Math.max(0, (s.helpRow ?? 0) + d); return invalidate() }
    if (id === 'home') { s.helpRow = 0; return invalidate() }
    if (id === 'end') { s.helpRow = helpTotal; return invalidate() }
    // The g-code list is far longer than the manual notes above it, so left and
    // right jump whole sections rather than paging there a screen at a time.
    if (id === 'left' || id === 'right') {
      const at = helpFrom(s)
      s.helpRow = id === 'right'
        ? (HELP_SECTIONS.find(i => i > at) ?? helpTotal)
        : (HELP_SECTIONS.filter(i => i < at).pop() ?? 0)
      return invalidate()
    }
  }

  // PARAMETER / DIAGNOSTIC: the cursor walks the machine's settings, read-only.
  if (s.activePane === 'param') {
    const n = Object.keys(s.settings).length
    const dr = { up: -1, down: 1, 'page-up': -PANE_ROWS, 'page-down': PANE_ROWS }[id]
    if (dr !== undefined && n) {
      s.paramRow = Math.max(0, Math.min(n - 1, s.paramRow + dr))
      return invalidate()
    }
    if (id === 'home') { s.paramRow = 0; return invalidate() }
    if (id === 'end') { s.paramRow = Math.max(0, n - 1); return invalidate() }
  }

  // LIST PROGRAM: the cursor walks control memory, or the machine's card.
  if (s.activePane === 'list') {
    const move = { up: -1, down: 1, 'page-up': -8, 'page-down': 8, home: -1e9, end: 1e9 }[id]
    if (move !== undefined) {
      if (s.listPage === 'sd' && s.sdFiles.length) {
        s.sdIndex = Math.max(0, Math.min(s.sdFiles.length - 1, s.sdIndex + move))
      } else if (s.programs.length) {
        s.listIndex = Math.max(0, Math.min(s.programs.length - 1, s.listIndex + move))
      }
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

  // A jog key steps its axis *and* hands that axis to the handwheel, which is the
  // only way the handle knows what to move.
  if (AXIS_KEYS[id]) {
    s.jogAxis = AXIS_KEYS[id][0]
    jogAxis(...AXIS_KEYS[id])
    return invalidate()
  }

  switch (id) {
    case 'cycle-start': return cycleStart()
    case 'feed-hold': return link?.sendRealtime(0x21)
    case 'reset': case 'estop':
      // Nothing left to abort and grbl sitting locked: RESET is the unlock. A
      // soft reset in motion lands in ALARM:3, and a second 0x18 only re-locks
      // it — `$X` is grbl's one way out, and RESET is where a HAAS operator
      // looks for it. Without this the panel cannot clear an alarm at all and
      // the operator has to go and type `$X` on the MDI page. Gated on there
      // being no job: with one still live the first press must abort it, and
      // only the press after that unlocks.
      if (id === 'reset' && !s.job && inAlarm()) {
        s.message = 'unlocked — position is not trustworthy, home before you cut'
        send('$X')
        return invalidate()
      }
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
      s.input = ''                 // the manual: RESET "clears input text" too
      // Setting 31 p.341. Nothing else moves the pointer once the job is gone —
      // it only ever advances from a status report, and there are no more of
      // those for this cycle — so without this it freezes on the block the tool
      // stopped in and the listing goes on pointing at a cut that is over.
      if (settingOn(s, 31)) s.program.current = s.mdi.current = 0
      return invalidate()

    // The manual: CW/CCW start the spindle at the COMMANDED speed. Overwriting
    // the S the student just set with a hardcoded number taught a wrong lesson;
    // the last commanded S rides in the $G modal string. 1000 only from cold.
    // The chip conveyor is a single relay (IO-5): FWD runs it, STOP stops it,
    // REV stays honestly impossible. AUX CLNT is the TSC pump on the mist
    // channel (IO-0) — its lamp follows the A: report, not this key.
    case 'chip-fwd': s.chipFwd = true; return send('M31')
    case 'chip-stop': s.chipFwd = false; return send('M33')
    case 'aux-coolant': return send(s.tsc ? 'M89' : 'M88')

    // Setting 6 p.336 locks the spindle and ATC keys. The ATC pair is already
    // refused for want of a changer, so this control's lock reaches two keys —
    // and SPINDLE STOP is deliberately not one of them: a lock that could stop a
    // student stopping the spindle would be a safety device pointing backwards.
    case 'spindle-cw': case 'spindle-ccw':
      if (settingOn(s, 6)) { s.message = 'FUNCTION LOCKED — setting 6 FRONT PANEL LOCK is ON'; return invalidate() }
      return send(`${id === 'spindle-cw' ? 'M3' : 'M4'} S${modalS() ?? 1000}`)
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
    case 'receive': return receive()
    case 'send': return sendToCard()

    case 'block-delete': return toggleRunSwitch('blockDelete', 'BLOCK DELETE', '$B')
    case 'option-stop': return toggleRunSwitch('optionStop', 'OPTION STOP', '$O')
    case 'dry-run': return toggleSwitch('dryRun', 'DRY RUN')
    case 'single-block': return toggleSwitch('singleBlock', 'SINGLE BLOCK')

    // POWER ON is where a machine's power lives, so it is where this control's
    // does too: it opens the one dialog that is not part of the pendant.
    case 'power-on':
      s.powered = true          // the screen lights before anything is connected
      // A control reads its settings when it powers up, which is also the only
      // moment this one can: `store` is defined below the state it fills in.
      s.set = settingsFromStore(store.get(SETTINGS_KEY, null))
      $('power').showModal()
      return invalidate()
    case 'power-off':
      link?.disconnect()
      link = null
      streamer?.reset()
      s.powered = false
      s.job = null; s.cycleStartedAt = null; s.latched = null
      s.link = 'OFFLINE'
      s.message = ''
      $('power').close()
      $('link').textContent = 'not connected'
      $('link').className = ''
      return invalidate()

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
    // §3.1 step 3: POWER UP/RESTART "zero returns all axes and initializes the
    // machine control" — it is the homing step of the power-on procedure. The
    // machine answers honestly when homing is not configured ($22), which is
    // this bench's state; the simulator homes.
    case 'power-up':
      s.mode = 'SETUP'; s.fn = 'ZERO'
      s.message = 'POWER UP RESTART — homing (untested on this machine, no limit switches fitted)'
      return send('$H')
    case 'zero-home':
      if (!s.caps.haas) {
        s.message = 'HOME G28 requires the paired HAAS parity v0.2 firmware'
        return invalidate()
      }
      try {
        const typed = s.input.trim().toUpperCase()
        const commands = homeG28(typed || null, /\bG91\b/.test(s.modal ?? ''))
        s.input = ''
        s.message = typed ? `returning ${typed} to machine zero` : 'returning all axes to machine zero'
        return send(commands.join('\n'))
      } catch (e) {
        if (!(e instanceof WireError)) throw e
        s.message = e.message
        return invalidate()
      }
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

    case 'f1': {
      // §3.12 p.104: F1 REPLACES the highlighted offset value where WRITE/ENTER
      // adds to it. Only the offset pages give F1 a meaning yet; elsewhere it
      // falls through to the honest not-built-yet message.
      if (s.activePane !== 'offset') break
      const f1v = s.input.trim()
      if (!f1v) { s.message = 'type a value first — F1 replaces the cell, WRITE/ENTER adds'; return invalidate() }
      if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(f1v)) { s.message = `"${f1v}" is not a number`; return invalidate() }
      s.input = ''
      return offsetEntry(Number(f1v), 'replace')
    }

    case 'cancel':
      // The manual: "Deletes the last character typed" — one character, not the
      // buffer. An armed single-axis-home prompt still cancels whole.
      if (s.pendingHomeAxis) { s.message = 'cancelled'; s.pendingHomeAxis = false; s.input = ''; return invalidate() }
      s.input = s.input.slice(0, -1)
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
  // One-shot means one KEY, not one shifted key: a key with no yellow legend
  // still consumes the shift, or SHIFT,A,5 would leak the latch and type "A$".
  if (s.shifted) {
    s.shifted = false
    if (SHIFTED[id]) return SHIFTED[id]
  }
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
 * Setting 119 p.363. The lock is on the OFFSET *display*, not on the offsets —
 * "programs that alter offsets will still be able to do so" — so it belongs on
 * the three operator entry points and nowhere near the stream. A G10 in a
 * running program goes out through the streamer and never comes past here.
 */
function offsetLocked () {
  if (!settingOn(s, 119)) return false
  s.message = 'FUNCTION LOCKED — setting 119 OFFSET LOCK is ON'
  invalidate()
  return true
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
  if (offsetLocked()) return
  if (s.stale) { s.message = 'no position from the machine — cannot set part zero'; return invalidate() }
  const k = displayScale(s.reportUnits, s.units)
  writeOffset(s.mpos[s.offsetCol] * k)
  // F3.11 step 12: the cursor advances so the next press loads the next axis —
  // X, then Y (and the manual's caution: a third press loads Z). Stops at the
  // last column rather than wrapping back onto a good X.
  if (s.offsetCol < 3) s.offsetCol++
}

/** The last commanded S word, from the modal string — null before any S. */
function modalS () {
  const m = /\bS([\d.]+)/.exec(s.modal ?? '')
  const v = m ? Number(m[1]) : 0
  return v > 0 ? v : null
}

// -------------------------------------------------------------------- graphics

/**
 * §3.8 Graphics Mode: run the program without moving anything, and draw where the
 * tool would have gone.
 *
 * The drawing comes off the simulator rather than a second g-code reader. It
 * already knows G90/G91, units, work offsets, tool length, canned cycles and
 * arcs, and it is the one the classroom seat runs against — a separate
 * interpreter here would be a second opinion about what the program means, and
 * the two would drift.
 *
 * Nothing is ticked. The planner queue holds every target the machine would pass
 * through, which is the polyline, so the plot costs one pass over the program
 * instead of a simulated cycle time.
 *
 * ponytail: work offsets are left at zero, so the picture is the SHAPE of the
 * program and not where it sits on the table. Feed `$#` in the day the page
 * grows a machine envelope to sit the shape inside.
 */
function plotWire (wire) {
  // The machine's own declared envelope when it has told us — a program that
  // leaves the table is a fault worth seeing here, on the page whose whole job
  // is to find it before the tool does.
  const travel = [0, 1, 2, 3].map(i => Number(s.settings[130 + i]))
  s.plot = toolPath(wire, travel.every(v => v > 0) ? { maxTravel: travel } : {})

  const err = s.plot.err
  const n = err ? Number(err.slice(err.indexOf(':') + 1)) : 0
  s.message = !err ? `${s.plot.blocks} blocks drawn — nothing moved`
    : err.startsWith('ALARM:2') ? 'the program leaves the machine envelope — nothing past that point is drawn'
    : err.startsWith('ALARM:') ? `${describeAlarm(n)} — the drawing stops there`
    : `error ${n} — ${describeError(n)}. The drawing stops at that block`
  return invalidate()
}

// --------------------------------------------------------------------- alarms

/**
 * Is the machine locked out right now?
 *
 * Two sources, because they arrive at different speeds: the `ALARM:n` line lands
 * the instant it happens, while `Alarm` in the status report waits on the next
 * poll. An E-STOP's own banner is deliberately not one of them — it is this
 * control's word, not a grbl lock, and `$X` has nothing to unlock.
 */
const inAlarm = () => s.alarm?.startsWith('ALARM') || /^Alarm/.test(s.machineState)

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

/**
 * The program the editor and CYCLE START act on.
 *
 * §4.2.3 makes the MDI page a program in its own right — edited with the same
 * keys (§4.2.1 step 1: "an active EDIT:EDIT or EDIT:MDI window"), run by the same
 * CYCLE START — so it is the same object shape and there is one of everything
 * rather than a second half-editor for the MDI page.
 */
const target = () => (s.activePane === 'mdi' ? s.mdi : s.program)

/** Put a changed program back where it came from: the MDI page, or memory. */
// Editing the program (or undoing an edit) makes any drawing of it a picture of
// something that no longer exists. Throw it away rather than leave the GRAPHICS
// page quietly showing the last version — press CYCLE START again for this one.
const setTarget = (prog) => {
  s.plot = null
  if (s.activePane === 'mdi') s.mdi = prog; else s.program = prog
}

/**
 * Is the program under the editor the one the machine is running?
 *
 * Its blocks are already on the wire, so an edit could not affect the cycle
 * anyway — and every edit replaces the program object, which would leave the
 * running-block mark updating a copy nobody is looking at. A HAAS locks the
 * editor during a cycle for the first reason; this control has the second too.
 */
const runningTarget = () => s.job?.prog === target()

// EDIT mode *and* the program on screen. An operator who has paged away to
// POSITION should not be editing a program they cannot see. The MDI page is
// always editable, empty included — an empty one has to accept a first block
// somehow, and that is the whole of §4.2.3 step 2.
const editing = () =>
  s.activePane === 'mdi' ||
  (s.mode === 'EDIT' && s.fn === 'EDIT' &&
   s.activePane === 'program' && s.program.lines.length > 0)
const editLine = () => target().lines[s.editRow]

/** Clamp the cursor after the program under it has changed shape. */
function clampCursor () {
  s.editRow = Math.max(0, Math.min(target().lines.length - 1, s.editRow))
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
    s.editRow = Math.max(0, Math.min(target().lines.length - 1, s.editRow + dRow))
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
    if (s.editRow >= target().lines.length - 1) return invalidate()
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
  const prog = target()
  s.undoStack.push({
    lines: prog.lines.map(l => ({ ...l })),
    editRow: s.editRow,
    editWord: s.editWord
  })
  if (s.undoStack.length > 50) s.undoStack.shift()

  const next = { ...prog, lines }
  setTarget(next)
  clampCursor()
  saveEditedProgram(next)
  s.message = message
  invalidate()
}

/**
 * Put the edited program back into control memory, under the same O-number.
 *
 * The MDI page has no O-number until ALTER files it, so it falls out here — which
 * is precisely §4.2.3: what is typed on that page stays on that page and nowhere
 * else until the operator says otherwise.
 */
function saveEditedProgram (prog) {
  if (!prog.o) return
  const at = s.programs.findIndex(p => p.o === prog.o)
  if (at < 0) return             // not from the directory
  s.programs[at] = { ...s.programs[at], text: prog.lines.map(l => l.text).join('\n') }
  if (!saveDirectory()) s.message = 'edit not stored — browser storage refused'
}

/**
 * Put a typed block on the page, after the cursor — §4.2.3 step 2, "type program
 * commands in the window". This is what WRITE/ENTER does on the MDI page, and
 * what INSERT does when there is no block to insert a word into yet.
 *
 * `n` is renumbered across the whole page so a message that names a line (the
 * two-M-codes warning at CYCLE START) names one the operator can count to.
 */
function appendBlock (text) {
  const lines = target().lines
  const at = lines.length ? s.editRow + 1 : 0
  const next = [...lines.slice(0, at), { text, del: text[0] === '/' }, ...lines.slice(at)]
    .map((l, i) => ({ ...l, n: i + 1 }))
  applyEdit(next, '')
  s.editRow = at
  s.editWord = 0
}

function editKey (id) {
  if (runningTarget()) { s.message = 'not while it is running'; return invalidate() }
  const line = editLine()
  const typed = s.input.trim()

  if (id === 'undo') {
    const back = s.undoStack.pop()
    if (!back) { s.message = 'nothing to undo'; return invalidate() }
    const next = { ...target(), lines: back.lines }
    setTarget(next)
    s.editRow = back.editRow
    s.editWord = back.editWord
    saveEditedProgram(next)
    s.message = `undo — ${s.undoStack.length} left`
    return invalidate()
  }

  if (id === 'delete') {
    if (!line) { s.message = 'nothing on the page to delete'; return invalidate() }
    // Nothing typed and the block has one word left: the block itself goes.
    const w = words(line.text)
    const lines = w.length <= 1
      ? target().lines.filter((_, i) => i !== s.editRow)
      : target().lines.map((l, i) =>
          i === s.editRow ? { ...l, text: editBlock(l.text, s.editWord, 'delete') } : l)
    // A numbered program has to stay a program. The MDI page is scratch, so
    // emptying it block by block is allowed — ERASE PROGRAM is just the fast way.
    if (!lines.length && s.activePane !== 'mdi') {
      s.message = 'a program needs at least one block'
      return invalidate()
    }
    s.input = ''
    return applyEdit(lines, w.length <= 1 ? 'block deleted' : `deleted ${w[s.editWord]}`)
  }

  if (!typed) {
    s.message = `type the word first, then ${id === 'alter' ? 'ALTER' : 'INSERT'}`
    return invalidate()
  }

  s.input = ''

  // §4.2.3 step 3: HOME to the top of the MDI page, type a program number, ALTER
  // — and the page is filed in control memory under it. Only on the MDI page and
  // only at the very head of it: altering the first word of a *program* to an
  // O-number is ordinary word editing and must go on working.
  if (id === 'alter' && s.activePane === 'mdi' && s.editRow === 0 && s.editWord === 0) {
    const o = parseOWord(typed)
    if (o) return saveMdiAs(o)
  }

  if (!line) {
    // An empty MDI page has no word to alter, but it can certainly take a block.
    if (id === 'insert') return appendBlock(typed)
    s.message = 'nothing on the page to alter — press WRITE/ENTER to add a block'
    return invalidate()
  }

  if (id === 'alter') {
    const lines = target().lines.map((l, i) =>
      i === s.editRow ? { ...l, text: editBlock(l.text, s.editWord, 'alter', typed) } : l)
    return applyEdit(lines, `altered to ${typed}`)
  }

  // INSERT after the cursor. On a block that is only a comment, or at the end of
  // the program, this is how a new block gets written.
  const lines = target().lines.map((l, i) =>
    i === s.editRow ? { ...l, text: editBlock(l.text, s.editWord, 'insert', typed) } : l)
  s.editWord++
  return applyEdit(lines, `inserted ${typed}`)
}

/**
 * §4.2.3 step 3: the MDI page becomes a numbered program in control memory, and
 * the page is cleared.
 *
 * Deliberately does not go to the LIST page afterwards — the manual tells the
 * operator to press [LIST PROGRAM] to find it, which means the control stayed
 * where it was. The program selected to run is left alone for the same reason.
 */
function saveMdiAs (o) {
  if (!s.mdi.lines.length) { s.message = 'nothing on the MDI page to save'; return invalidate() }
  // Filing over an existing program would take somebody's work with no warning
  // and no undo. The number is the operator's to choose: say that one is taken.
  if (s.programs.some(p => p.o === o)) {
    s.message = `${o} already exists — erase it first, or choose another number`
    return invalidate()
  }
  const persisted = fileProgram(o, '(from MDI)', [o, ...s.mdi.lines.map(l => l.text)].join('\n'))
  s.mdi = blankMdi()
  s.editRow = 0; s.editWord = 0; s.undoStack = []
  s.message = (persisted ? '' : 'NOT STORED (browser storage refused) — ') +
    `${o} saved — press LIST PROGRAM to find it`
  invalidate()
}

// ------------------------------------------------------------------ tool table

const TOOLS = 'haassender.tools'
const SETTING9 = 'haassender.setting9'

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
  if (offsetLocked()) return
  if (s.stale) { s.message = 'no position from the machine — cannot measure'; return invalidate() }
  const n = s.toolRow + 1
  s.tools = { ...s.tools, [n]: s.mpos[2] }
  writeToolToMachine(n, s.mpos[2])
  toolWritten(n, s.mpos[2] * displayScale(s.reportUnits, s.units), saveTools())
}

/**
 * With a native tool table (haasSender branch firmware), every tool length is
 * also written through to the machine with `G10 L1` — that is what makes
 * `G43 H` work in a job the board runs off its own card, where this sender is
 * not in the loop. The local table stays as the display copy and the fallback;
 * the machine's `[T:]` rows overwrite it at `$#` so the machine stays truth.
 * G10 L1 reads the MODAL unit, so convert like `G10 L2` does (a work zero
 * written without this lands 25.4x out — same trap, measured, PLAN.md).
 */
function writeToolToMachine (n, machineZ) {
  if (!s.caps.toolTable || !link || s.job) return
  link.send(`G10 L1 P${n} Z${(machineZ * displayScale(s.reportUnits, s.units)).toFixed(4)}\n`)
}

// -------------------------------------------------- this control's own settings

const SETTINGS_KEY = 'haassender.settings'

/** Returns false when the browser refused to store them; the caller must say so. */
const saveSettings = () => store.set(SETTINGS_KEY, s.set)

/**
 * Change the setting under the cursor — p.341, the horizontal keys walk a row's
 * choices. A row with `get` is not ours to store: Setting 9 is modal g-code, so
 * changing it means commanding the pair and letting `$G` come back and say so.
 */
function changeSetting (d, dir) {
  if (d.get) {
    // Setting 9 on a HAAS is a stored setting that also picks the power-up
    // default — so the choice persists and applyStatus() re-commands it.
    const unit = s.units === 'IN' ? 'MM' : 'IN'
    store.set(SETTING9, unit)
    return send(unit === 'IN' ? 'G20' : 'G21')
  }
  // The manual is explicit that the two kinds of setting take different keys, so
  // a numeric row says which one it wants rather than nudging by one — a HAAS
  // has no such nudge, and inventing it here would teach the wrong hand.
  if (!d.choices) {
    s.message = `setting ${d.n} takes a number — type ${d.min}-${d.max} and press WRITE/ENTER`
    return invalidate()
  }
  s.set = { ...s.set, [d.n]: nextChoice(d, settingValue(s, d), dir) }
  return settingWritten(d)
}

/** One report for both ways a setting changes, so both admit a refused store. */
function settingWritten (d) {
  const stored = saveSettings()
  // Setting 90 can shrink the tool page out from under its own cursor.
  if (d.n === 90) s.toolRow = Math.min(s.toolRow, maxTools(s) - 1)
  s.message = (stored ? '' : 'NOT STORED (browser storage refused) — ') +
    `setting ${d.n} ${d.name} is ${settingValue(s, d)}`
  return invalidate()
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
  if (key === 'singleBlock' && streamer) streamer.setSingleBlock(s.singleBlock)
  s.message = `${label} ${s[key] ? 'ON' : 'OFF'}` +
    (s.job && key !== 'singleBlock' ? ' — takes effect at the next CYCLE START' : '')
  return invalidate()
}

/**
 * BLOCK DELETE and OPTION STOP are the machine's own switches on grblHAL: the
 * key sends the `$` toggle and the LAMP FOLLOWS THE Pn: REPORT, not this press
 * — a lamp that tracked the key rather than the machine could lie. Mid-job,
 * OPTION STOP has a realtime byte (0x88); block delete has none, so the
 * firmware takes `$B` only between jobs — say so instead of queueing a lie.
 * ($O is inverted underneath: it toggles "optional stop DISABLE".)
 */
function toggleRunSwitch (key, label, cmd) {
  if (!s.caps.runSwitches) return toggleSwitch(key, label)
  if (!link) { s.message = 'not connected'; return invalidate() }
  if (s.job) {
    if (cmd === '$O') { link.sendRealtime(0x88); link.sendRealtime(0x3F) } else {
      s.message = 'BLOCK DELETE — the machine takes $B only when idle; press again after the cycle'
    }
    return invalidate()
  }
  link.send(cmd + '\n')
  link.sendRealtime(0x3F)      // so the lamp follows within a frame
  return invalidate()
}

// ------------------------------------------------------------- the machine's card

// A program pulled off the card lands in browser storage, which is a few megabytes
// for everything put together. The card is not: `github.nc` on this one is 4.19 MB
// on its own. Refuse rather than wedge the directory — and say what to do instead,
// because the board can run that file perfectly well without our help.
const RECEIVABLE_BYTES = 256 * 1024

/** RECEIVE: first press lists the card, second press pulls the highlighted file. */
function receive () {
  if (!link) { s.message = 'not connected'; return invalidate() }

  if (s.listPage !== 'sd') {
    s.sdFiles = []
    s.mode = 'EDIT'; s.fn = 'LIST'; s.activePane = 'list'; s.listPage = 'sd'
    s.message = 'reading the card'
    link.send('$F\n')
    return invalidate()
  }

  const f = s.sdFiles[s.sdIndex]
  if (!f) { s.message = 'no file to receive'; return invalidate() }
  if (f.size > RECEIVABLE_BYTES) {
    s.message = `${f.name} is ${(f.size / 1024).toFixed(0)} KB — too big for control memory. CYCLE START runs it off the card instead.`
    return invalidate()
  }
  // The dump arrives as bare g-code lines, terminated by `ok`. Collect until then.
  s.receiving = { name: f.name, lines: [] }
  s.message = `receiving ${f.name}`
  link.send(`$F<=${f.name}\n`)
  invalidate()
}

/**
 * SEND: put the selected program on the machine's card.
 *
 * The only one of the three that is not on the grbl stream — grblHAL can list,
 * dump, run and delete over it, but not write — so this goes to the HTTP endpoint
 * and therefore needs the network transport. Over serial or the simulator there is
 * no card to write to, and the control says that rather than failing quietly.
 */
async function sendToCard () {
  if (!s.boardHost) {
    s.message = 'SEND needs the network connection — the card is written over HTTP'
    return invalidate()
  }
  if (!s.program.lines.length) { s.message = 'no program selected to send'; return invalidate() }

  const name = `/${s.program.o || 'O00000'}.nc`
  // What lands on the card has to be runnable *by the machine*, which will read it
  // with no help from this control: the O-number line is a HAAS program name, not
  // g-code, and the board answers it with an error the moment it reads the file.
  // Everything else stays as written — comments and `/` blocks included — because
  // the board has its own block-delete switch and the file should still be the
  // program, not this panel's current opinion of it.
  const body = s.program.lines
    .filter(l => !/^O\s*\d{1,5}$/i.test(stripComments(l.text)))
    .map(l => l.text).join('\n') + '\n'
  const blob = new Blob([body], { type: 'text/plain' })

  const form = new FormData()
  form.append('path', '/')
  form.append(name + 'S', String(blob.size))       // ESP3D wants the byte count
  form.append('myfile', blob, name)                // ...and the full path as the name

  s.message = `sending ${name} to the card`
  invalidate()
  try {
    const res = await fetch(`http://${s.boardHost}/sdfiles`, { method: 'POST', body: form })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    s.message = `${name} written to the card (${blob.size} bytes)`
    if (s.listPage === 'sd') link?.send('$F\n')    // show it in the listing
  } catch (e) {
    s.message = `could not write ${name} to the card — ${e.message}`
  }
  invalidate()
}

/**
 * DNC: let the machine run the file off its own card.
 *
 * `$F=` hands the whole job to the board, which reads and executes it without a
 * sender in the loop — no streaming, no flow control, nothing for a dropped link
 * to interrupt. It is also the only way to run the files that are too big to hold
 * in control memory at all.
 */
function runFromCard () {
  const f = s.sdFiles[s.sdIndex]
  if (!f) { s.message = 'no file selected on the card'; return invalidate() }
  s.alarm = null
  s.mode = 'OPERATION'; s.fn = 'DNC'
  s.cycleStartedAt = Date.now(); s.cycleMs = 0
  s.job = { dnc: true, name: f.name, sentAll: false }
  s.message = `${f.name} — running from the card`
  link?.send(`$F=${f.name}\n`)
  invalidate()
}

// -------------------------------------------------------- the program directory

const selected = () => s.programs[s.listIndex] ?? null

/** Program O<n> from control memory as prepared lines — M98/G65 expansion. */
function programByNumber (n) {
  const o = 'O' + String(n).padStart(5, '0')
  const p = s.programs.find(p => p.o === o)
  return p ? prepare(p.text) : null
}

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

/**
 * File a program into control memory under `o` and leave the LIST cursor on it.
 * Returns false when browser storage refused, which the caller has to say.
 */
function fileProgram (o, name, text) {
  const at = s.programs.findIndex(p => p.o === o)
  const entry = { o, name, text }
  if (at >= 0) s.programs[at] = entry
  else s.programs.push(entry)
  s.programs.sort((a, b) => a.o.localeCompare(b.o))
  s.listIndex = s.programs.findIndex(p => p.o === o)
  return saveDirectory()
}

/** Import a file into control memory, filed under its O-number. */
function storeProgram (name, text) {
  const found = parseONumber(text)
  const o = found ?? nextFreeONumber()
  if (!o) { s.message = 'control memory is full'; return invalidate() }

  const persisted = fileProgram(o, name, text)

  s.mode = 'EDIT'; s.fn = 'LIST'; s.activePane = 'list'
  selectHighlighted()

  // One message carrying everything the operator needs, set last because
  // selectHighlighted writes its own. Two things must not get lost here: that we
  // invented the O-number when the file had none, and that storage refused —
  // a program that vanishes on reload without warning is worse than one that
  // never claimed to be saved.
  s.message =
    (persisted ? '' : 'NOT STORED (browser storage refused) — ') +
    (found ? `${name} filed as ${o}` : `${name} had no O-number, filed as ${o}`) +
    `, ${s.program.lines.length} blocks`
  invalidate()
}

/**
 * Load the highlighted directory entry as the active program.
 *
 * The plain half of SELECT PROGRAM, split out because two callers reach it with
 * something else already decided: importing a file, and the typed-`Onnnnn` path
 * below. Neither may go back through the keypad buffer — an import that consulted
 * whatever was left in the input bar would select a program the operator never
 * asked for and file the imported one out of sight.
 */
function selectHighlighted () {
  const p = selected()
  if (!p) { s.message = 'no program to select'; return invalidate() }
  s.program = { o: p.o, name: p.name, lines: prepare(p.text), current: 0 }
  s.plot = null                 // a different program, so not that drawing
  s.message = `${p.o} selected — ${s.program.lines.length} blocks`
  invalidate()
}

/**
 * SELECT PROGRAM. Two ways in, both the manual's.
 *
 * §3.3.2 step 2: highlight a program and press the key. §4.1 step 2: "Enter a
 * program number (Onnnnn) and press [SELECT PROGRAM] or [ENTER]" — and if it
 * does not exist the control creates it. The typed form goes through the same
 * select-or-create path WRITE/ENTER uses, because the manual names the two keys
 * in one breath and a student who types a number means the same by either.
 */
function selectProgram () {
  const typed = s.input.trim()
  if (!typed) return selectHighlighted()

  const o = parseOWord(typed)
  if (!o) { s.message = `type a program number, like O00010 — "${typed}" is not one`; return invalidate() }
  s.input = ''
  return selectOrCreateProgram(o)
}

function eraseProgram () {
  // T2.10: in MDI mode this key clears the MDI page — it must never reach into
  // the directory from there. Deleting the wrong object is the worst kind of
  // key: it looked like it worked.
  if (s.activePane === 'mdi') {
    // Not mid-cycle: the page is what the machine is running, and taking it away
    // would leave the running-block highlight pointing at blocks that are gone.
    if (s.job) { s.message = 'cannot clear the MDI page while it is running'; return invalidate() }
    s.mdi = blankMdi()
    s.editRow = 0; s.editWord = 0; s.undoStack = []
    s.input = ''
    s.message = 'MDI cleared'
    return invalidate()
  }
  if (s.activePane !== 'list') {
    s.message = 'ERASE PROGRAM works from LIST PROGRAM (or clears MDI in MDI mode)'
    return invalidate()
  }
  const p = selected()
  if (!p) { s.message = 'no program to erase'; return invalidate() }
  if (s.job) { s.message = 'cannot erase while a program is running'; return invalidate() }

  // §3.3.4: "You cannot delete the active program." The key refuses rather than
  // deleting it and quietly unloading it — a control that empties the program
  // pane out from under CYCLE START has done two things when it was asked for
  // one, and the operator is told to pick another program instead.
  if (p.o === s.program.o) {
    s.message = `${p.o} is the active program — select another before erasing it`
    return invalidate()
  }

  // §3.3.4 step 4: ask, then delete. The manual puts its own NOTE above this
  // step — "You cannot undo this process… You cannot press [UNDO] to recover a
  // deleted program" — and the prompt is the only thing standing between a
  // mis-hit key and a program that is gone.
  s.pendingErase = p.o
  s.message = `erase ${p.o}? — Y to delete, N to cancel`
  invalidate()
}

/** Y at the §3.3.4 prompt. Erases by O-number: the cursor may have moved since. */
function eraseConfirmed (o) {
  const at = s.programs.findIndex(p => p.o === o)
  if (at < 0) { s.message = `${o} is no longer in the directory`; return invalidate() }

  s.programs.splice(at, 1)
  s.listIndex = Math.max(0, Math.min(s.listIndex, s.programs.length - 1))
  const persisted = saveDirectory()
  s.message = persisted ? `${o} erased` : `${o} erased, but browser storage refused — it will be back on reload`
  invalidate()
}

/**
 * WRITE/ENTER. What it does depends on which pane is active — that is the whole
 * point of the active-pane model, and the reason exactly one pane is white.
 *
 * On a data-entry pane it commits the typed value into the highlighted cell. On
 * the MDI page it writes the typed block onto the page — T2.4 gives this key one
 * job, "answers prompts and writes input", and CYCLE START is what runs things.
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
    // §3.12 p.104: a typed value + ENTER ADDS to the number in the cell; F1
    // replaces it. A machinist nudges an offset by typing the correction —
    // an ENTER that replaced would put every touch-up 100% wrong.
    return offsetEntry(Number(v), 'add')
  }

  // p.341: a setting with a range is changed by typing a number and pressing
  // ENTER. Out-of-range is refused rather than clamped quietly — a student who
  // typed 200 tools should learn this control holds twenty, not watch it become
  // twenty behind their back.
  if (s.activePane === 'setting') {
    const d = SETTINGS[s.setRow]
    s.input = ''
    if (!v) return invalidate()
    if (d.get || d.choices) {
      s.message = `setting ${d.n} is changed with CURSOR ◀ ▶, not by typing`
      return invalidate()
    }
    const n = Number(v)
    if (!/^\d+$/.test(v) || !Number.isFinite(n)) {
      s.message = `"${v}" is not a number`
      return invalidate()
    }
    if (n < d.min || n > d.max) {
      s.message = `setting ${d.n} takes ${d.min} to ${d.max} — ${n} is outside it`
      return invalidate()
    }
    s.set = { ...s.set, [d.n]: clampSetting(d, n) }
    return settingWritten(d)
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

  // LIST pane: `Onnnnn` + WRITE/ENTER selects that program, or creates it when
  // it does not exist — §3.3.2/§4.1, the way a new program is born on the
  // pendant. Anything else typed here is not a machine command.
  if (s.activePane === 'list') {
    s.input = ''
    if (!v) return invalidate()
    const o = parseOWord(v)
    if (!o) { s.message = `type a program number, like O00010 — "${v}" is not one`; return invalidate() }
    return selectOrCreateProgram(o)
  }

  // Typed text becomes a block in exactly one place: the MDI page. On every other
  // pane a HAAS commits it with the pane's own key (INSERT, ALTER, F1…), and text
  // that fell through from the EDIT page ran code the student thought they were
  // merely typing. The buffer survives the refusal — switching to MDI and pressing
  // ENTER again does what they meant.
  if (s.activePane !== 'mdi') {
    if (v) s.message = 'WRITE/ENTER writes nothing from this pane — press MDI/DNC to write a block'
    return invalidate()
  }

  s.input = ''
  if (!v) return invalidate()
  if (runningTarget()) { s.message = 'not while the page is running'; return invalidate() }

  // A `$` command is the one thing typed here that is not a program block: it is
  // grbl's own control language, it has no HAAS equivalent, and it has no business
  // on a page CYCLE START runs. It also has to reach a machine sitting in alarm,
  // which is exactly when CYCLE START refuses — so `$X` goes straight out.
  if (v[0] === '$') {
    send(v)
    if (link) s.message = `${v} sent — a $ command goes to the machine now, it is not a program block`
    return invalidate()
  }

  appendBlock(v)
}

/**
 * One entry point for both offset tables and both entry modes — ENTER adds,
 * F1 replaces, exactly the §3.12 pair. `value` arrives in the DISPLAY unit.
 */
function offsetEntry (value, mode) {
  if (offsetLocked()) return
  if (s.offsetPage === 'tool') {
    const n = s.toolRow + 1
    const typedMm = value * displayScale(s.units, s.reportUnits)
    const machineZ = mode === 'add' ? (s.tools[n] ?? 0) + typedMm : typedMm
    s.tools = { ...s.tools, [n]: machineZ }
    writeToolToMachine(n, machineZ)
    return toolWritten(n, machineZ * displayScale(s.reportUnits, s.units), saveTools())
  }
  const w = WCS[s.offsetRow]
  const currentMm = (s.offsets[w.report] ?? [0, 0, 0, 0])[s.offsetCol]
  const current = currentMm * displayScale(s.reportUnits, s.units)
  return writeOffset(mode === 'add' ? current + value : value)
}

/**
 * Walk the PROGRAM listing.
 *
 * The cursor and the running-block mark are one value, `current`, because they
 * are one thing on the machine: the control drives it while the program runs,
 * the operator drives it when it stops. Setting 36 restarts from wherever it was
 * left, which only makes sense if they are the same row.
 *
 * `current` is 1-based and 0 means "no pointer" — what RESET leaves under
 * Setting 31 — so a clamp from 0 lands on line 1 with no special case.
 */
function programCursor (d) {
  const n = s.program.lines.length
  if (!n) {
    s.message = 'no program selected — press LIST PROGRAM, then SELECT PROGRAM'
    return invalidate()
  }
  // While this program is streaming, the mark belongs to the machine: every
  // status report writes it, so a keypress would be overwritten within the
  // frame and the cursor would appear broken rather than busy.
  if (s.job?.prog === s.program) {
    s.message = 'not while the program is running'
    return invalidate()
  }
  s.program.current = Math.max(1, Math.min(n, s.program.current + d))
  return invalidate()
}

/** A typed `Onnnnn`: select it, or create it — §3.3.2 step 2, §4.1 step 2. */
function selectOrCreateProgram (o) {
  const at = s.programs.findIndex(p => p.o === o)
  if (at >= 0) {
    s.listIndex = at
    return selectHighlighted()
  }
  s.programs.push({ o, name: '(new)', text: o })
  s.programs.sort((a, b) => a.o.localeCompare(b.o))
  s.listIndex = s.programs.findIndex(p => p.o === o)
  const persisted = saveDirectory()
  selectHighlighted()
  s.message = `${o} created` + (persisted ? '' : ', but browser storage refused — it will vanish on reload')
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
  // A settings write answers with a bare `ok`, never an echo — so nothing would
  // ever tell the PARAMETER page that `$30=5000` happened, and it would go on
  // showing the old number until the operator re-read `$$` by hand. Re-read here
  // for the same reason `writeOffset` re-reads `$#`: the machine is the record,
  // and a write the board REJECTED must not leave a changed value on screen.
  // This is also what keeps `$13` honest, which decides what `MPos:` means.
  if (/^\$\d+=/.test(line)) link.send('$$\n')
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

  // An explicit HANDLE CONTROL choice wins. One percent a click, fixed — the
  // manual is specific about that, and it is not scaled by the jog increment
  // keys, which govern axis motion only.
  if (s.handleMode === 'feed') return override(dir > 0 ? 0x93 : 0x94)
  if (s.handleMode === 'spindle') return override(dir > 0 ? 0x9C : 0x9D)

  // "This is used to jog axes (select in [HANDLE JOG] Mode); also used to
  // scroll through program code or menu items while editing" — T2.1. The MODE
  // decides, not the pane: in SETUP the wheel always jogs, even with the
  // OFFSET grid up — the canonical touch-off is jog-while-watching-the-cell,
  // and a wheel that scrolled the grid instead broke exactly that. Outside
  // SETUP, a pane with a cursor takes the handle, routed through press() so
  // each pane keeps owning its own cursor.
  if (s.mode !== 'SETUP' && hasCursor()) return press(dir > 0 ? 'up' : 'down')

  // "This is used to jog axes (select in [HANDLE JOG] Mode)" — the axis is
  // whichever one the operator last touched with a jog key, which is how the
  // machine works and what the key press is *for* beyond its own single step.
  jogAxis(s.jogAxis, dir)
}

/** Panes with something for the handle to scroll. */
const hasCursor = () =>
  editing() || s.activePane === 'list' || s.activePane === 'offset' ||
  s.activePane === 'param' || s.activePane === 'setting' ||
  s.activePane === 'program'

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
  if (inAlarm()) {
    s.message = 'machine is in alarm — RESET unlocks it, ALARMS says what it costs'
    return invalidate()
  }

  // Standing on the card page, CYCLE START runs the highlighted file *on the
  // board* rather than streaming it from here. That is what DNC means, and it is
  // the only way to run the files too big to fit in control memory.
  if (s.activePane === 'list' && s.listPage === 'sd') return runFromCard()

  // §4.2.3 p.114 step 2: on the MDI page, CYCLE START executes the blocks on the
  // page. The page is a program like any other, so it goes down the same wire,
  // through the same run switches and the same streamer — nothing about running
  // it is special, which is the point of holding it in the same shape.
  const isMdi = s.activePane === 'mdi'
  const run = isMdi ? s.mdi : s.program

  if (!run.lines.length) {
    s.message = isMdi
      ? 'the MDI page is empty — type a block and press WRITE/ENTER'
      : 'no program selected — press LIST PROGRAM, then SELECT PROGRAM'
    return invalidate()
  }

  // Build the wire program now, so the switches read at CYCLE START are the ones
  // that govern the whole cycle. `rows` keeps the running-block highlight pointing
  // at the source line, which a switch that removes blocks would otherwise skew.
  // M97/M98/G65 are expanded here; a program that cannot stream faithfully
  // (M99 loop, missing sub, macro arguments) refuses with the reason.
  let wire, rows, endedBy
  try {
    ({ wire, rows, endedBy } = wireProgram(run.lines, {
      ...s, getProgram: programByNumber, dryRunFeed: DRY_RUN_FEED[s.units][s.incIndex]
    }))
  } catch (e) {
    if (!(e instanceof WireError)) throw e
    s.message = e.message
    return invalidate()
  }
  if (!wire.length) {
    s.message = 'every block is switched out — nothing to run'
    return invalidate()
  }

  // §3.8: on the GRAPHICS page CYCLE START runs the program against a simulated
  // machine and draws it. Same wire program as a real cycle — the same expanded
  // subprograms, the same run switches — so what is drawn is what would be cut.
  if (s.activePane === 'graphics') return plotWire(wire)

  // A program that asks for a tool offset nobody measured gets zero, which is the
  // one number certain to be wrong. Run anyway — refusing would be worse on a
  // machine with no tools fitted — but never let it happen quietly.
  const unmeasured = toolsUsed(run.lines).filter(n => n > 0 && s.tools[n] === undefined)
  if (unmeasured.length) {
    s.message = `no tool length measured for ${unmeasured.map(n => 'H' + n).join(', ')} — running with no offset`
  } else {
    // Manual p.322: "Only one M-code is allowed per line of code." grbl runs
    // such a block happily, which teaches a habit a real HAAS rejects — warn,
    // run anyway. The unmeasured-tool warning outranks this one.
    const multiM = run.lines.find(l => (stripComments(l.text).match(/\bM\d/gi) || []).length > 1)
    if (multiM) s.message = `line ${multiM.n}: two M-codes in one block — a real HAAS allows one per line (runs here anyway)`
  }

  // A block that failed last time is still on the MDI page with its error printed
  // against it. Running again is the operator's answer to that, so the mark goes.
  for (const l of run.lines) delete l.error

  s.alarm = null
  // MDI runs from the MDI page and stays on it — the mode bar reads EDIT: MDI
  // right through the cycle, as it does on the machine, and the blocks stay in
  // front of the operator who typed them. A program run goes to OPERATION: MEM
  // with the DRO up: pane 2 already carries the listing with the running-block
  // highlight, and the DRO is what an operator actually watches.
  if (!isMdi) { s.mode = 'OPERATION'; s.fn = 'MEM'; s.activePane = 'position' }
  s.cycleStartedAt = Date.now(); s.cycleMs = 0
  s.job = { sentAll: false, rows, prog: run, mdi: isMdi, m30: endedBy === 30 }
  streamer.setSingleBlock(s.singleBlock)
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
      // Pin it to the source block that caused it, so the MDI page shows the error
      // against the line the student typed rather than only as a code in a banner.
      // `rows` maps wire back to source, because the run switches and the G43
      // split may have moved things in between. The streamer's text already
      // carries the HAAS note for the code.
      const row = s.job?.rows?.[streamer.error.line - 1]
      const bad = row === undefined ? null : s.job?.prog?.lines[row]
      if (bad) bad.error = `error ${streamer.error.code}: ${streamer.error.text}`
      // The ALARMS page is the history of what went wrong, and a rejected block
      // belongs in it whether it came from a program or from the MDI page. Only
      // the hand-sent lines reach the bare `error:` branch below, so without this
      // every streamed rejection would be missing from the log.
      logAlarm('ERROR', streamer.error.code, streamer.error.text, null)
      s.job = null
      // A cycle that stopped on a bad block is over, so the timer stops with it.
      // Nothing else clears it — the completion path needs a job to reach — and a
      // clock still counting after an MDI block was rejected is a plain lie about
      // what the machine is doing. Same treatment the DNC error path already gives.
      s.cycleStartedAt = null
      // Bench-found firmware latch (2026-08-07, present on stock grblHAL too):
      // after an ok'd block, one errored block makes EVERY later g-code line
      // repeat the error until a `$` command clears it. A `$G` costs nothing,
      // refreshes the modal display, and un-bricks the next CYCLE START. It is
      // very likely what produced history/g28-false-alarm.md.
      link?.send('$G\n')
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
    // Nothing streamed produced this — the streamer claims its own errors above,
    // with the HAAS note and the block it belongs to. What is left is a line this
    // control sent by hand: a `$` command from the MDI page, or a key's own g-code.
    const n = Number(line.slice(6))
    const full = describeError(n)
    s.message = `error ${n} — ${full}`
    logAlarm('ERROR', n, full, null)
    // A job the board is running off its own card has stopped. Nothing here is
    // streaming it, so nothing else would ever notice — and the cycle timer would
    // count on for a program that is no longer running.
    if (s.job?.dnc) { s.job = null; s.cycleStartedAt = null }
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

  // A file dump from the card: bare g-code lines until `ok`. Everything in
  // between belongs to the file, not to the console, so it is swallowed here
  // rather than posted a line at a time as a status message.
  if (s.receiving) {
    if (line === 'ok') {
      const text = s.receiving.lines.join('\n')
      const name = s.receiving.name.replace(/^\//, '')
      s.receiving = null
      s.listPage = 'memory'
      return storeProgram(name, text)
    }
    if (line.startsWith('error:')) {
      s.message = `could not read ${s.receiving.name} — error ${line.slice(6)}`
      s.receiving = null
      return invalidate()
    }
    s.receiving.lines.push(line)
    return
  }

  // A bare `ok` is the machine acknowledging a block we sent by hand. It is not
  // news, and posting it wipes the message that explained what just happened —
  // "G55 Y set to -12.5000" became "ok" a quarter of a second later.
  if (line === 'ok') return

  const fb = parseFeedback(line)
  if (!fb) { s.message = line; return invalidate() }

  if (fb.kind === 'OPT') {
    // Every grblHAL `$I` emits `[OPT:]`, and only `$I` does — so this line is
    // the receipt for the whole burst, including the `[PLUGIN:]` rows that come
    // a few lines behind it. Stop re-asking.
    s.idSeen = true
    const opt = parseOpt(fb.value)
    if (opt.rx && streamer) streamer.rxBuffer = opt.rx
    if (opt.planner) s.plannerSize = opt.planner
    s.caps.toolTable = (opt.tools ?? 0) > 0
  } else if (fb.kind === 'NEWOPT') {
    s.caps.expr = /\bEXPR\b/.test(String(fb.value))
  } else if (fb.kind === 'PLUGIN' && /^HAAS parity v0\.2\b/.test(String(fb.value))) {
    s.caps.haas = true
  } else if (fb.kind === 'GC') {
    s.modal = fb.value
    s.units = /\bG20\b/.test(fb.value) ? 'IN' : 'MM'
    const wcs = fb.value.match(/G5[4-9](\.\d)?/)
    if (wcs) s.wcs = wcs[0]
    // The modal string carries the selected tool, which is the only place this
    // control can learn it — the board has no tool table to ask.
    const t = fb.value.match(/\bT(\d+)/)
    if (t) s.tool = Number(t[1])
  } else if (fb.kind === 'T' && s.caps.toolTable) {
    // A native tool-table row: [T:3|0.000,0.000,-20.000,0.000|0.000|…]. The
    // machine's table is the truth; the local copy is display and fallback.
    // The board prints ALL 32 rows, unset ones as zeros (bench 2026-08-07) —
    // adopting those would overwrite "never measured" with a confident 0.000
    // and silence the unmeasured-tool warning forever.
    // ponytail: a tool honestly measured at exactly 0.000 is lost to this
    // filter; track a per-tool measured flag if that ever matters.
    const [id, coords] = String(fb.value).split('|')
    const z = Number((coords ?? '').split(',')[2])
    if (Number.isFinite(z) && z !== 0 && Number(id) > 0) s.tools = { ...s.tools, [Number(id)]: z }
  } else if (fb.kind === 'TLO') {
    s.tlo = fb.value[2] ?? 0
  } else if (fb.kind === 'FILE') {
    // `[FILE:/meter.nc|SIZE:6351]` — the card's directory, one line per file.
    const [name, size] = String(fb.value).split('|SIZE:')
    s.sdFiles = [...s.sdFiles, { name, size: Number(size) || 0 }]
    s.sdIndex = Math.min(s.sdIndex, s.sdFiles.length - 1)
  } else if (/^G5[4-9](\.[1-3])?$/.test(fb.kind)) {
    s.offsets = { ...s.offsets, [fb.kind]: fb.value }
  } else if (fb.kind === 'MSG') {
    // The HAAS firmware emits this before an SD/DNC M30 completes. Streamed
    // jobs already carry their parsed terminator; this closes the path where the
    // board owns the file and the browser cannot inspect its last block.
    if (fb.value === 'HAAS:M30' && s.job) s.job.m30 = true
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
  // A job the board is running off its own card has no wire list here to track:
  // it is over when the machine goes back to Idle, and it has not started until
  // it has left Idle at least once.
  if (s.job?.dnc) {
    if (!s.job.sentAll && st.state !== 'Idle') s.job.sentAll = true
  } else if (s.job && st.bf && s.plannerSize) {
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
    // Onto whichever program is running — the selected one, or the MDI page.
    s.job.prog.current = row + 1

    const block = s.job.prog.lines[row]?.text
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
    const { prog, mdi, m30 } = s.job
    s.job = null
    s.message = mdi ? 'MDI complete' : 'program complete'
    if (prog) prog.current = 0
    // A cycle that finished is a part made, and the counter is what a shop
    // actually watches. Only a completed cycle counts — one stopped by RESET
    // clears the timer without incrementing anything, and a handful of blocks
    // typed into MDI is not a part either: that pane is labelled M30 CNT.
    if (!mdi) {
      s.lastCycleMs = s.cycleMs
      if (m30) s.parts++
    }
    s.cycleStartedAt = null
    // A program can leave the modal state, the work offsets and the tool length
    // offset anywhere at all. Re-read rather than assume they survived the cycle.
    link?.send('$G\n')
    link?.send('$#\n')
  }
  // The firmware's run switches surface as Pn: chars — L block delete, T
  // optional-stop-DISABLE (inverted: lamp on means T absent), Q single block.
  // The lamps follow the machine's word, never a local boolean. Pn is omitted
  // entirely when no signal is set, so absence means all three are clear.
  if (s.caps.runSwitches) {
    const pins = st.pins ?? ''
    s.blockDelete = pins.includes('L')
    s.optionStop = !pins.includes('T')
    // Firmware powers up with M1 live (disable flag clear); a HAAS powers up
    // with OPTION STOP off. Sync once per connection so the lamp starts where
    // a student expects it — unless the board already carries T from before.
    if (!s.optSynced && !s.job) {
      s.optSynced = true
      if (!pins.includes('T')) link?.send('$O\n')
      // Setting 9's power-up half: the machine boots G21; if the stored
      // dimensioning says INCH, command it now, once per connection.
      const unit9 = store.get(SETTING9, null)
      if (unit9 === 'IN') { link?.send('G20\n'); link?.send('$G\n') }
    }
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
    s.tsc = st.accessory.includes('M')     // the TSC pump rides the mist bit
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

// Eighteen asks, five seconds apart: ninety seconds, which is deliberately past
// the sixty the firmware's session reaper takes to drop a dead peer and hand the
// input stream back (6b4ae87). Give up sooner and the control would sit refusing
// programs through the very minute the board was about to start answering.
const ID_TRIES = 18
const ID_RETRY_MS = 5000
let idTries = 0
let idGaveUp = false
let lastIdAskAt = 0

/**
 * Everything this control has to ask the machine before it can be trusted to
 * stream: what the firmware can do (`$I`), where the offsets are (`$#`), what
 * the modal state is (`$G`), and what the settings say (`$$` — one dump of ~40
 * lines that pays for the PARAMETER page, `$13`, and `$130`+).
 *
 * Asked more than once, because the answer can be dropped on the floor.
 * grblHAL has ONE input stream: whoever connected last owns it, and a peer that
 * vanished without a clean close goes on owning it (firmware 814ed68, and the
 * reaper it switched back on in 6b4ae87). A client that opens in that window
 * gets the websocket handshake, gets `?` answered — realtime bytes are handled
 * per connection — and gets silence for every line command it sends. Nothing
 * about the link looks wrong.
 *
 * Bench, 2026-08-22: the burst was sent once at connect, that once was lost,
 * and `caps.haas` stayed false for the rest of the session. Every program with
 * an M30 in it was then refused with "requires the paired HAAS parity v0.2
 * firmware" — against a board whose `$I` says `[PLUGIN:HAAS parity v0.2]` —
 * until the page was reloaded. Never heard from is not the same as answered no,
 * and this control must not confuse the two.
 */
function askIdentity () {
  idTries++
  lastIdAskAt = performance.now()
  link.send('$I\n')
  link.send('$G\n')
  link.send('$#\n')
  link.send('$$\n')
}

async function connect () {
  const kind = $('kind').value
  // Let go of the previous link first. Without this, reconnecting leaves the old
  // transport alive with its callback still pointing here — an orphaned simulator
  // goes on pushing `Idle|MPos:0,0,0,0` at 4 Hz and overwrites the readings from
  // the machine that is actually connected. Observed: the DRO sat at 0.000 through
  // a jog that had really happened.
  try { await link?.disconnect() } catch { /* already gone */ }
  link = null

  // Remember the operator's choice as soon as they commit to it, NOT once the
  // machine answers. A connect that fails is exactly when the address matters
  // most — a board that is switched off, or a typo worth correcting rather
  // than retyping — and saving only on success threw the address away in both
  // cases. The resolution order is unchanged: ?board= still wins, then the
  // serving host, then this.
  store.set(KIND, kind)
  if (kind === 'websocket' && $('host').value) remember.set($('host').value)

  try {
    link = kind === 'websocket' ? websocketTransport({ host: $('host').value })
      : kind === 'serial' ? serialTransport()
        : simTransport()

    // A new connection is a new firmware: relearn what it can do.
    s.caps = { runSwitches: true, toolTable: false, expr: false, haas: false }
    s.optSynced = false
    s.idSeen = false
    idTries = 0
    idGaveUp = false

    link.onLine(onLine)
    await link.connect()

    streamer = new Streamer(wire => link.send(wire), 128)
    lastReportAt = 0

    $('link').textContent = link.describe()
    $('link').className = 'ok'
    s.link = link.kind.toUpperCase()
    // Only the network transport can write to the card — see sendToCard().
    s.boardHost = kind === 'websocket' ? $('host').value : null
    askIdentity()
    s.powered = true        // a machine that answers is a machine that is on
    $('power').close()      // connected: get out of the way
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
  const now = performance.now()
  const quiet = now - lastReportAt
  if (link && quiet > STATUS_IDLE_MS) link.sendRealtime(0x3F)

  // Ask again until the machine tells us what it is — see askIdentity(). The
  // status poll above is no evidence either way: `?` answers from a board whose
  // input stream belongs to somebody else, so a live DRO sits happily above a
  // control that has learned nothing.
  // `idTries > 0`: this poller only ever RE-asks. The first ask belongs to
  // connect(), after the handshake — without this the interval can fire into a
  // socket that is still CONNECTING and burn a try on a send that goes nowhere.
  // `!s.job`: four lines the streamer did not count would be four lines of rx
  // buffer it thinks it still has. Waiting costs nothing — the retry picks up
  // again when the cycle ends.
  if (link && idTries > 0 && !s.idSeen && !idGaveUp && !s.job && now - lastIdAskAt > ID_RETRY_MS) {
    if (idTries < ID_TRIES) askIdentity()
    else {
      // Once, and then stop asking. Said out loud, because the alternative is a
      // refusal an hour later that blames the firmware for this.
      idGaveUp = true
      s.message = 'the machine never answered $I — another client may hold its input stream. G28, M00 and M30 are refused until it does; reconnect to ask again'
      invalidate()
    }
  }

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

// Which machine this seat talks to, remembered alongside its address. A bench
// running USB serial should come back up on USB serial, not on whatever the list
// happens to start with.
const KIND = 'haassender.kind'
const rememberedKind = ['sim', 'websocket', 'serial'].includes(store.get(KIND, null))
  ? store.get(KIND, null)
  : null

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

// An explicit ?board= names a network target, so it wins; otherwise the seat comes
// back up on whatever it was last connected to.
if (rememberedKind) $('kind').value = rememberedKind

if (wantedBoard && (!rememberedKind || rememberedKind === 'websocket' ||
    new URLSearchParams(location.search).get('board'))) {
  $('host').value = wantedBoard
  $('kind').value = 'websocket'
  // Knowing which machine this is and not connecting to it is the worst of both:
  // the pendant looks live while the readouts sit at zero, which is precisely the
  // lie a trainer must not tell. If we know where the machine is, go there.
  connect()
}

$('connect').onclick = connect
// Importing from *this computer* into control memory. It is the one step of the
// workflow with no pendant equivalent — a real HAAS reads a USB stick and a
// browser cannot — which is why it sits in the power dialog with the other things
// that are not really part of the machine. Getting a program off the machine's own
// card is RECEIVE, and putting one back is SEND; both are on the pendant.
$('file').onchange = async (e) => {
  const f = e.target.files[0]
  if (!f) return
  storeProgram(f.name, await f.text())
  e.target.value = ''          // so re-importing the same file fires change again
  $('power').close()
}

// Physical keyboard shortcuts for the keys a student uses constantly.
// The arrows follow the pendant's CURSOR group whenever anything on screen has
// a cursor, and only stand in for the jog keys in SETUP:JOG with no cursor up —
// an ArrowDown in EDIT must move the edit cursor, never the machine.
addEventListener('keydown', (e) => {
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return

  // The MDI page takes typed g-code, and hunting for it one panel key at a time
  // is the wrong lesson. A physical keyboard goes in through press() — the same
  // path the ALPHA and NUMERIC keys take — so SHIFT, WRITE/ENTER and CANCEL keep
  // the panel's behaviour rather than growing a second one beside it. Only on the
  // MDI page: a letter typed on POSITION would fill an input bar nobody can see.
  if (s.activePane === 'mdi' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (e.key === 'Enter' || e.key === 'Backspace') {
      e.preventDefault()
      return press(e.key === 'Enter' ? 'enter' : 'cancel')
    }
    const typed = keyForChar(e.key)
    if (typed) {
      e.preventDefault()
      if (typed.shift) s.shifted = true      // the panel's own one-shot latch
      return press(typed.id)
    }
  }

  const jogging = s.mode === 'SETUP' && s.fn === 'JOG' && !hasCursor()
  const map = jogging
    ? { ArrowLeft: 'jog-x-plus', ArrowRight: 'jog-x-minus',
        ArrowUp: 'jog-y-plus', ArrowDown: 'jog-y-minus',
        PageUp: 'jog-z-plus', PageDown: 'jog-z-minus' }
    : { ArrowLeft: 'left', ArrowRight: 'right',
        ArrowUp: 'up', ArrowDown: 'down',
        PageUp: 'page-up', PageDown: 'page-down' }
  if (map[e.key]) { e.preventDefault(); press(map[e.key]) }
})

addEventListener('beforeunload', () => link?.disconnect())

paint()
