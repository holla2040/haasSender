import { html, nothing } from 'lit-html'
import { WCS, TOOL_COUNT, words, modalGroups, describeSetting } from '../grbl.js'
import { UNAVAILABLE, VERIFIED, GROUPS } from '../keys.js'

// Counted from the key tables rather than written down, so the HELP page cannot
// drift out of step with the panel it is describing.
const TODO_KEYS = Object.values(GROUPS).flatMap(g => g.rows.flat())
  .filter(k => k.id && !UNAVAILABLE.has(k.id) && !VERIFIED.has(k.id)).length

// The control display: one fixed layout of thirteen panes, per figure F2.27 and
// section 2.3.4 of the 2014 Mill Operator's Manual. The panes do not change; what
// they contain changes with the mode, and exactly one pane is active (white) at a
// time — that is the only pane the operator can enter data into.

const AXES = ['X', 'Y', 'Z', 'A']

/**
 * A machine readout. When no status report has arrived for a while every number
 * on this screen is a memory rather than a reading, so show nothing at all: a
 * frozen DRO after a dropped socket tells a student exactly the same lie as a
 * disconnected control sitting at 0.000.
 */
export const fmt = (v, inches, stale) => (stale ? '—' : (v ?? 0).toFixed(inches ? 4 : 3))

/**
 * How much to multiply a reported coordinate by before showing it.
 *
 * grbl reports position in whatever `$13` says, and G20/G21 does not change that
 * — verified on the ClearCore, where `G20` is accepted and the next `MPos:` still
 * arrives in millimetres. So switching the control to inches is not a matter of
 * printing another decimal place: 20 mm shown as `20.0000` because the operator
 * picked inches is a four-digit lie about where the tool is.
 */
export const MM_PER_IN = 25.4
export const displayScale = (reportUnits, units) =>
  reportUnits === units ? 1 : units === 'IN' ? 1 / MM_PER_IN : MM_PER_IN

/** Cycle time, the way a control shows it: HH:MM:SS, counting up from zero. */
export const clock = (ms) => {
  const t = Math.max(0, Math.floor((ms ?? 0) / 1000))
  return [Math.floor(t / 3600), Math.floor(t / 60) % 60, t % 60]
    .map(v => String(v).padStart(2, '0')).join(':')
}

const droRow = (label, values, s, unknown = false) => {
  const k = displayScale(s.reportUnits, s.units)
  const inches = s.units === 'IN'
  return html`
    <b>${label}</b>${values.map(v => html`<span>${fmt(v * k, inches, s.stale || unknown)}</span>`)}`
}

/**
 * The four readouts a HAAS shows on the POSITION page.
 *
 * DIST TO GO is passed `unknown` when the running block cannot say how far is
 * left, so it draws dashes rather than a hopeful zero — see distanceToGo().
 */
function positionBody (s) {
  const work = s.mpos.map((v, i) => v - s.wco[i])
  return html`
    <div class="dro big">
      <b></b>${AXES.map(a => html`<span class="dim">${a}</span>`)}
      ${droRow('OPERATOR', s.mpos.map((v, i) => v - s.operator[i]), s)}
      ${droRow(`WORK (${s.wcs})`, work, s)}
      ${droRow('MACHINE', s.mpos, s)}
      ${droRow('DIST TO GO', s.dtg ?? [0, 0, 0, 0], s, s.dtg === null)}
    </div>`
}

/**
 * A block with the edit cursor on it — a *word* picked out, not a character,
 * because that is the unit a HAAS cursor moves in and the unit INSERT, ALTER and
 * DELETE all act on. Shared by the two windows §4.2.1 says are editable: the
 * EDIT:EDIT program and the EDIT:MDI page.
 */
const cursorWords = (text, at) => {
  const w = words(text)
  return w.map((word, j) => html`<span
    class=${j === at ? 'cur' : ''}>${word}</span>${j < w.length - 1 ? ' ' : ''}`)
}

/** The program with the EDIT cursor on it. */
function editBody (s) {
  const from = Math.max(0, Math.min(s.editRow - 4, s.program.lines.length - 10))
  return html`<pre>${s.program.lines.slice(from, from + 10).map((l, i) => {
    const row = from + i
    if (row !== s.editRow) return html`<div class=${l.del && s.blockDelete ? 'skipped' : ''}>${l.text}</div>`
    return html`<div>${cursorWords(l.text, s.editWord)}</div>`
  })}</pre>`
}

function programBody (s) {
  if (s.mode === 'EDIT' && s.fn === 'EDIT' && s.program.lines.length) return editBody(s)
  if (!s.program.lines.length) {
    return html`<pre class="dim">no program selected

Press LIST PROGRAM, highlight
one, then SELECT PROGRAM.</pre>`
  }
  // Window the listing around the running block rather than rendering thousands
  // of lines; the pane only shows a dozen or so anyway.
  const cur = Math.max(0, s.program.current - 1)
  const from = Math.max(0, cur - 4)
  const slice = s.program.lines.slice(from, from + 16)
  // The listing always shows the file as written, slashes and all. BLOCK DELETE
  // greys the blocks it will skip rather than hiding them — a student needs to
  // see what the switch is doing to the program in front of them.
  return html`<pre>${slice.map((l, i) => html`<div
    class=${(from + i === cur ? 'cur' : '') + (l.del && s.blockDelete ? ' skipped' : '')}
    >${l.text}</div>`)}</pre>`
}

/**
 * The one setting this control really has.
 *
 * A HAAS keeps inch/metric as Setting 9, a stored machine setting. On grbl it is
 * modal g-code — G20 and G21 — so there is nothing stored to read back and the
 * machine's own `$G` is the only authority. This pane shows what `$G` last
 * reported, not what we last asked for, which is the difference between a
 * display and a guess.
 */
function settingBody (s) {
  const inch = s.units === 'IN'
  return html`<pre>  9  INCH / METRIC        <span class="k">${inch ? 'INCH' : 'METRIC'}</span>   <span class="dim">${inch ? 'G20' : 'G21'}</span>

<span class="dim">CURSOR ◀ ▶ changes it. Modal g-code here, not a stored
setting, so a program commanding G20 or G21 changes it too.</span></pre>`
}

/**
 * The OFFSET page: nine work coordinate systems, four axes each, with a cell
 * cursor. This is the pane the active-pane model exists for — it is the first
 * one an operator types into.
 *
 * Values arrive from `$#` in the machine's report unit and are converted for
 * display exactly as the DRO is, so switching to inches moves these too.
 */
/**
 * The TOOL OFFSET page, and the one table on this control the *machine* knows
 * nothing about. The board's firmware is built with N_TOOLS 0 and base grbl has
 * only a dynamic offset, so this table lives in the browser and is turned into
 * `G43.1` on the way out — see wireProgram().
 *
 * The stored number is the machine Z where the tip touched, which is what TOOL
 * OFFSET MEASURE records and exactly what `G43.1` wants. Nothing is negated
 * anywhere, which is one fewer sign to get backwards.
 */
function toolBody (s) {
  const k = displayScale(s.reportUnits, s.units)
  const inches = s.units === 'IN'
  const from = Math.max(0, Math.min(s.toolRow - 3, TOOL_COUNT - 7))
  return html`<pre>  TOOL     LENGTH (Z)
${Array.from({ length: 7 }, (_, i) => {
    const n = from + i + 1
    const v = s.tools[n]
    return html`<div>  T${String(n).padStart(2, '0')}  ${
      n === s.tool ? '*' : ' '}${('          ' + (v === undefined
        ? '—'
        : fmt(v * k, inches, s.stale))).slice(-11)}</div>`
  })}
<span class="dim">TOOL OFFSET MEASURE stores the machine Z. A dash is never measured.</span></pre>`
}

function offsetBody (s) {
  if (s.offsetPage === 'tool') return toolBody(s)
  const k = displayScale(s.reportUnits, s.units)
  const inches = s.units === 'IN'
  return html`<pre>          ${AXES.map(a => ('       ' + a).slice(-9)).join('')}
${WCS.map((w, row) => {
    const v = s.offsets[w.report] ?? [0, 0, 0, 0]
    // The one the machine is actually in, per `$G`. An operator setting a part
    // zero into G55 while the program runs G54 is a scrapped part.
    const label = (w.report === s.wcs ? '*' : ' ') + w.name
    return html`<div>${(label + '        ').slice(0, 9)}${AXES.map((a, col) => html`<span
      class=${row === s.offsetRow && col === s.offsetCol ? 'cur' : ''}
      >${('        ' + fmt(v[col] * k, inches, s.stale)).slice(-9)}</span>`)}</div>`
  })}</pre>`
}

/**
 * MDI — §4.2.3 p.114. A program page, not a command line: "your input stays on
 * the MDI input page until you delete it", and CYCLE START is what runs it.
 *
 * So it draws like the EDIT window, with the same word cursor and the same
 * running-block mark — and with the error printed against the block that caused
 * it, which is half of what makes MDI the place to learn g-code.
 */
function mdiBody (s) {
  const lines = s.mdi.lines
  if (!lines.length) {
    return html`<pre class="dim">the MDI page is empty

Type a block and press WRITE/ENTER to put it
on the page. CYCLE START runs the whole page,
ERASE PROGRAM clears it.
<span class="k">&gt; ${s.input}_</span></pre>`
  }
  const from = Math.max(0, Math.min(s.editRow - 4, lines.length - 8))
  return html`<pre>${lines.slice(from, from + 8).map((l, i) => {
    const row = from + i
    return html`<div class=${(l.error ? 'k' : '') + (l.del && s.blockDelete ? ' skipped' : '')}
      >${row === s.mdi.current - 1 ? '▶' : ' '} ${
      row === s.editRow ? cursorWords(l.text, s.editWord) : l.text}${
      l.error ? '   ' + l.error : ''}</div>`
  })}
<span class="k">&gt; ${s.input}_</span></pre>`
}

/**
 * The ALARMS page: what went wrong, in the machine's own numbers and in English,
 * newest first, with what clears it.
 *
 * Deliberately not dressed up with invented HAAS alarm numbers. A student sitting
 * at a real HAAS will read "102 SERVO OVERLOAD"; this machine has no such code
 * and making one up would teach a number that does not exist. What it can honestly
 * give is the grbl code, the cause and the recovery — which is more than the
 * machine itself prints.
 */
function alarmBody (s) {
  if (!s.alarms.length) {
    return html`<pre class="dim">no alarms since power-up

An ALARM stops the machine and locks out
g-code until it is cleared. An error rejects
one block and halts the program.</pre>`
  }
  return html`<pre>${s.alarms.map(a => html`<div><span class="k">${a.kind} ${a.code}</span>  ${a.text}</div>
<div class="dim">      ${a.recovery ?? ''}</div>`)}</pre>`
}

/**
 * CURRENT COMMANDS — the modal state, broken out by group.
 *
 * All of this comes from the one `$G` string the ACTIVE CODES pane already shows
 * whole. Broken out and named, it is readable by a student who cannot yet read a
 * modal string, which is most of the point of a trainer.
 */
function currentBody (s) {
  const rows = modalGroups(s.modal)
  if (!rows.length) {
    return html`<pre class="dim">nothing from the machine yet

CURRENT COMMANDS shows the modal state —
what the control will do if you give it a
move with no other words on the line.</pre>`
  }
  return html`<pre class="two-col">${rows.map(r => html`<div>${(r.group + '             ').slice(0, 13)}<span
    class="k">${(r.code + '     ').slice(0, 6)}</span><span class="dim">${r.meaning}</span></div>`)}</pre>`
}

/**
 * PARAMETER / DIAGNOSTIC — the machine's own settings, as it reports them.
 *
 * Deliberately not curated. grblHAL answers `$$` with something like ninety
 * numbers and deciding which ten a student "should" see is a judgement this
 * control has no business making silently — the numbers are the machine's, and
 * `$$` is what it says.
 *
 * Three columns: the number, the value, and what the setting IS. That third one
 * is the difference between a page of numbers and a page a student can read, and
 * it comes from the firmware's own `setting_detail[]` tables so it says what
 * grblHAL says. Nothing is editable here: writing a setting is a different kind
 * of act from writing a work offset, and not one to do by accident.
 */
function paramBody (s) {
  const keys = Object.keys(s.settings)
  if (!keys.length) {
    return html`<pre class="dim">no settings read yet

Press WRITE/ENTER on an empty input bar
here to ask the machine for $$.</pre>`
  }
  const from = Math.max(0, Math.min(s.paramRow - 4, keys.length - 8))
  return html`<pre>${keys.slice(from, from + 8).map((k, i) => html`<div
    class=${from + i === s.paramRow ? 'cur' : ''}>${('  $' + k + '       ').slice(0, 7)}${
    ('          ' + s.settings[k]).slice(-11)}  <span class="dim">${
    describeSetting(k) ?? '—'}</span></div>`)}<span class="dim">Read-only, and the machine's own. $13 decides what MPos: means.</span></pre>`
}

/**
 * The machine's own SD card, listed by `$F` over the grbl stream.
 *
 * Separate from control memory on purpose: these files live on the machine, not
 * in this control, and the difference matters. A file small enough to hold can be
 * pulled across with RECEIVE; one too big can still be *run*, by the board, off
 * its own card — which is what CYCLE START does here and what DNC means.
 */
function cardBody (s) {
  if (!s.sdFiles.length) {
    return html`<pre class="dim">${s.receiving ? 'receiving…' : 'no files on the card, or not read yet'}

RECEIVE reads the card.</pre>`
  }
  const from = Math.max(0, Math.min(s.sdIndex - 4, s.sdFiles.length - 9))
  return html`<pre>${s.sdFiles.slice(from, from + 9).map((f, i) => html`<div
    class=${from + i === s.sdIndex ? 'cur' : ''}>${(f.name + '                        ').slice(0, 24)}${
    ('        ' + (f.size > 1024 ? (f.size / 1024).toFixed(0) + ' KB' : f.size + ' B')).slice(-9)}</div>`)}
<span class="dim">RECEIVE copies it here, CYCLE START runs it on the machine,
SEND writes back, LIST PROGRAM returns.</span></pre>`
}

/** Control memory: what LIST PROGRAM shows, filed by O-number. */
function listBody (s) {
  if (s.listPage === 'sd') return cardBody(s)
  if (!s.programs.length) {
    return html`<pre class="dim">control memory is empty

Import a file with the picker above the
pendant. It is filed by the O-number on
its first line.</pre>`
  }
  const from = Math.max(0, Math.min(s.listIndex - 5, s.programs.length - 10))
  return html`<pre>${s.programs.slice(from, from + 10).map((p, i) => {
    const at = from + i
    return html`<div class=${at === s.listIndex ? 'cur' : ''}>${p.o}   ${
      p.o === s.program.o ? 'A' : ' '} ${p.name}</div>`
  })}
<span class="dim">A is the active program. SELECT PROGRAM loads, ERASE PROGRAM removes.</span></pre>`
}

const MAIN_TITLE = {
  position: 'POSITION',
  program: 'PROGRAM',
  list: 'LIST PROGRAM',
  mdi: 'MDI',
  current: 'CURRENT COMMANDS',
  alarms: 'ALARMS',
  param: 'PARAMETER / DIAGNOSTIC',
  setting: 'SETTING / GRAPHIC',
  help: 'HELP'
}

/**
 * HELP — on a real HAAS this is the manual on the control. Here the useful thing
 * is what is different, because a student moving between this and a real machine
 * needs to know exactly where the replica stops. It carries the g-code and
 * m-code list for the same reason: which codes this machine answers to is the
 * other half of that question, and no HAAS book can tell them.
 *
 * The count of keys that can never work is read from `UNAVAILABLE` rather than
 * written down, so this page cannot drift out of step with the keypad.
 */
/**
 * HELP, as lines rather than one block, so it can be paged.
 *
 * A real control pages its manual with PAGE UP and PAGE DOWN, which is also what
 * lets this say what it needs to: the page had been cut twice to fit a screen
 * that had to clear 1080, and the second cut lost things worth knowing. Length is
 * no longer the constraint — legibility is.
 *
 * Each entry is [label, text, url?]; a blank label continues the one above it,
 * and a url turns the label into a link to that code's reference page.
 *
 * The reference bases. LinuxCNC's g-code pages are the definition grblHAL says
 * it implements, so they are the first place to send a student; the grblHAL wiki
 * covers the codes that are grblHAL's own, which LinuxCNC has never heard of.
 * Every anchor below was taken from the pages themselves, not guessed.
 */
const LC_G = 'https://linuxcnc.org/docs/html/gcode/g-code.html#gcode:'
const LC_M = 'https://linuxcnc.org/docs/html/gcode/m-code.html#mcode:'
const HAL = 'https://github.com/grblHAL/core/wiki/Additional-G--and-M-codes#user-content-'
const HAL_ALL = HAL + 'codes-available-for-all-drivers-and-configurations'
const HAL_PLUGIN = HAL + 'codes-available-if-driver-or-plugins-supports-them'
const HAL_LATHE = HAL + 'codes-available-in-lathe-mode-requires-driver-and-hardware-encoder-support'

/**
 * The g-codes this machine runs, verified one at a time against the parser in
 * `src/grbl/gcode.c` of the firmware this control is built for — not against the
 * g-code standard, and not against grblHAL's own documentation, both of which
 * describe codes this build compiles out. A help page that lists a code the
 * machine answers with `error:20` teaches a student to distrust the page.
 */
const G_CODES = [
  ['G0', 'rapid to the point. Positioning, never cutting.', LC_G + 'g0'],
  ['G1', 'straight cut at the F feed rate.', LC_G + 'g1'],
  ['G2 G3', 'arc clockwise / anti-clockwise, by I J K or R.', LC_G + 'g2-g3'],
  ['G4', 'dwell P seconds before the next block.', LC_G + 'g4'],
  ['G5', 'cubic spline, I J P Q.', LC_G + 'g5'],
  ['G5.1', 'quadratic spline, I J.', LC_G + 'g5.1'],
  ['G10 L2 L20', 'set work offset P to values, or to where it is.', LC_G + 'g10-l2'],
  ['G10 L1 L10', 'write tool P into the tool table. L11 too.', LC_G + 'g10-l1'],
  ['G17 G18 G19', 'plane for arcs and cycles: XY, ZX, YZ.', LC_G + 'g17-g19.1'],
  ['G20 G21', 'inch / millimetre.', LC_G + 'g20-g21'],
  ['G28 G28.1', 'go to stored position 1 / store it from here.', LC_G + 'g28-g28.1'],
  ['G30 G30.1', 'go to stored position 2 / store it from here.', LC_G + 'g30-g30.1'],
  ['G38.2-G38.5', 'probe toward / away. .3 and .5 do not alarm.', LC_G + 'g38'],
  ['G40', 'cutter compensation off — the only state here.', LC_G + 'g40'],
  ['G43', 'tool length offset from the table, H picks it.', LC_G + 'g43'],
  ['G43.1', 'dynamic tool length offset, given in the block.', LC_G + 'g43.1'],
  ['G43.2', 'add another tool length to the one in force.', LC_G + 'g43.2'],
  ['G49', 'cancel the tool length offset.', LC_G + 'g49'],
  ['G50 G51', 'cancel / set axis scaling. grblHAL, not NIST.', HAL_ALL],
  ['G53', 'move in machine coordinates, this block only.', LC_G + 'g53'],
  ['G54-G59', 'work coordinate systems 1 to 6.', LC_G + 'g54-g59.3'],
  ['G59.1-G59.3', 'three more systems. G154 P1-P3 on a HAAS.', LC_G + 'g54-g59.3'],
  ['G61', 'exact path mode — the only mode in this build.', LC_G + 'g61'],
  ['G65', 'call macro P<n>.macro off the card. n is 100+.', HAL_PLUGIN],
  ['G66 G67', 'call it after every motion / stop doing that.', HAL_PLUGIN],
  ['G73', 'peck drill breaking the chip. Q peck, R plane.', LC_G + 'g73'],
  ['G80', 'cancel the canned cycle.', LC_G + 'g80'],
  ['G81', 'drill: feed to Z, rapid out.', LC_G + 'g81'],
  ['G82', 'drill and dwell P at the bottom.', LC_G + 'g82'],
  ['G83', 'peck drill, full retract each peck. Q peck.', LC_G + 'g83'],
  ['G85', 'bore: feed in, feed back out.', LC_G + 'g85'],
  ['G86', 'bore: spindle stops at the bottom, rapid out.', LC_G + 'g86'],
  ['G89', 'bore: dwell P at the bottom, then feed out.', LC_G + 'g89'],
  ['G90 G91', 'absolute / incremental positions.', LC_G + 'g90-g91'],
  ['G91.1', 'arc centres are incremental — always true here.', LC_G + 'g90.1-g91.1'],
  ['G92', 'shift the coordinate system by what you give.', LC_G + 'g92'],
  ['G92.1 G92.2', 'clear that shift / suspend it.', LC_G + 'g92.1-g92.2'],
  ['G92.3', 'restore the suspended shift.', LC_G + 'g92.3'],
  ['G93 G94', 'feed as inverse time / units per minute.', LC_G + 'g93-g94-g95'],
  ['G98 G99', 'canned cycles return to initial Z / the R plane.', LC_G + 'g98-g99']
]

/**
 * The m-codes, same rule. The last five are this firmware's own: they exist so a
 * student's HAAS habits reach something on this machine, and no standards page
 * documents them — the 2014 Mill Operator's Manual does, and it is on paper.
 */
const M_CODES = [
  ['M0', 'program stop. CYCLE START carries on.', LC_M + 'm0-m1'],
  ['M1', 'optional stop, when OPT STOP is on.', LC_M + 'm0-m1'],
  ['M2', 'program end.', LC_M + 'm2-m30'],
  ['M30', 'program end, rewind to the top.', LC_M + 'm2-m30'],
  ['M60', 'pallet change pause. A plain stop here.', LC_M + 'm60'],
  ['M3 M4 M5', 'spindle on CW / on CCW / off. S sets rpm.', LC_M + 'm3-m4-m5'],
  ['M6', 'tool change: it holds and waits for you.', LC_M + 'm6'],
  ['M7', 'mist coolant on. Same output as M88.', LC_M + 'm7-m8-m9'],
  ['M8', 'flood coolant on.', LC_M + 'm7-m8-m9'],
  ['M9', 'all coolant off.', LC_M + 'm7-m8-m9'],
  ['M48 M49', 'enable / disable the feed and speed overrides.', LC_M + 'm48-m49'],
  ['M50', 'feed override control. P0 turns it off.', LC_M + 'm50'],
  ['M51', 'spindle override control. P0 turns it off.', LC_M + 'm51'],
  ['M53', 'feed hold control. P0 turns it off.', LC_M + 'm53'],
  ['M61', 'set the current tool number to Q. No change.', LC_M + 'm61'],
  ['M70 M71', 'save the modal state / invalidate the saved one.', LC_M + 'm70'],
  ['M72 M73', 'restore it / save with automatic restore.', LC_M + 'm72'],
  ['M98', 'call macro P<n>.macro off the card. n is 100+.', LC_M + 'm98-m99'],
  ['', 'An O<n> sub in the same file wants $700=1.'],
  ['M99', 'return from that sub.', LC_M + 'm98-m99'],
  ['M31 M33', 'chip conveyor forward / stop. This firmware.'],
  ['M88 M89', 'through-spindle coolant on / off. On M7 mist.'],
  ['M97', 'HAAS sub: run N<p> to M99, L times. Off the card'],
  ['', 'only — a streamed job has no file to seek in.']
]

/**
 * Codes the parser knows and this machine still refuses, which is the pair a
 * student hits and cannot explain: the book says the code exists, the control
 * says error 20. Each line says which piece of hardware or build option is the
 * one missing, because that is the answer to "why not".
 */
const REFUSED = [
  ['G7 G8', 'lathe diameter / radius mode. This is a mill.', LC_G + 'g7'],
  ['G96 G97', 'surface speed / rpm mode. Lathe mode only.', HAL_LATHE],
  ['G33 G76', 'synchronised feed and threading: no encoder.', LC_G + 'g33'],
  ['G84', 'tapping wants the spindle to report at-speed.', LC_G + 'g84'],
  ['G95', 'feed per revolution needs that encoder too.', LC_G + 'g93-g94-g95'],
  ['G61.1 G64', 'exact stop and blending are not in this build.', LC_G + 'g64'],
  ['M56', 'parking override control. Parking is not on.'],
  ['M62-M68', 'digital and analogue I/O: no ports registered.', HAL_PLUGIN]
]

/** A section rule, drawn to the width the pane's text column already uses. */
const rule = (title) => ['', `── ${title} ${'─'.repeat(Math.max(0, 52 - title.length))}`]

/** Where the replica stops being a HAAS — the page's original job. */
const DIVERGENCES = [
  ['', 'A HAAS-lookalike control driving a grblHAL machine. The'],
  ['', 'keypad, the panes and the modes are the real layout. The'],
  ['', 'machine underneath is not a HAAS. Where that shows:'],
  ['', ''],
  ['', 'Cursor left and right jump between the four sections.'],
  ['', 'Every code listed is a link to its reference page.'],
  ['', ''],
  ['Handwheel', 'Turn it, or scroll on it. It moves the axis a jog'],
  ['', 'key last picked — the icon bar shows which — by one'],
  ['', 'increment a detent. On any page with a cursor it'],
  ['', 'scrolls that instead. HANDLE CONTROL FEED or SPINDLE'],
  ['', 'makes it an override knob at 1% a detent.'],
  ['', ''],
  ['Faded keys', `${UNAVAILABLE.size} keys can never work on this machine: no chip`],
  ['', 'conveyor, no tool changer, no programmable coolant,'],
  ['', 'no spindle orient, and no 5% rapid in grbl. Another'],
  ['', `${TODO_KEYS} are simply not built yet. Press either and it says`],
  ['', 'which of the two it is.'],
  ['', ''],
  ['MDI', 'A program page, not a command line. WRITE/ENTER puts'],
  ['', 'the typed block ON the page; CYCLE START runs the whole'],
  ['', 'page; ERASE PROGRAM clears it. The cursor keys and'],
  ['', 'INSERT / ALTER / DELETE work on it as they do in EDIT.'],
  ['', 'HOME, type Onnnnn, ALTER files the page in memory.'],
  ['', 'Two divergences: a $ command is not a program block and'],
  ['', 'goes to the machine the moment you press WRITE/ENTER,'],
  ['', 'and the ; key is a comment here, not the HAAS end-of-'],
  ['', 'block — one line is one block.'],
  ['', ''],
  ['Tool offsets', 'With the haasSender firmware the machine holds a real'],
  ['', '32-tool table and G43 H&#8202;n goes straight through. On a'],
  ['', 'stock board this control owns the table and sends'],
  ['', 'G43.1 Z<length> instead. TOOL OFFSET MEASURE stores'],
  ['', 'the machine Z where the tip is. A dash: never measured.'],
  ['', ''],
  ['Work offsets', 'G154 P1-P3 are this machine\'s G59.1-G59.3. A real'],
  ['', 'HAAS goes on to G154 P99; P4 and up do not exist here.'],
  ['', 'PART ZERO SET stores the machine position into the'],
  ['', 'cell and steps to the next axis, as the manual teaches.'],
  ['', ''],
  ['Inch / metric', 'Modal g-code here (G20/G21), not a stored setting,'],
  ['', 'so a program that commands either changes it too.'],
  ['', 'SETTING page, cursor left and right.'],
  ['', ''],
  ['The card', 'RECEIVE lists the machine\'s SD card and copies a file'],
  ['', 'into control memory. CYCLE START on that page runs it'],
  ['', 'on the board itself, off its own card — the only way'],
  ['', 'to run one too big to copy. SEND writes back.'],
  ['', ''],
  ['$ commands', 'SHIFT then 5 types the $ character. $X clears an',
    'https://github.com/gnea/grbl/wiki/Grbl-v1.1-Commands'],
  ['', 'alarm, $H homes. The ALARMS page says which is which.'],
  ['', ''],
  ['EMERGENCY', 'A software reset. It is NOT a hardware E-stop and'],
  ['STOP', 'cannot be one from a browser.'],
  ['', ''],
  ['Homing', 'Wired, but never tested: the bench machine has no'],
  ['', 'limit switches. It says so when pressed.']
]

/**
 * The page, one flat list of lines, and the row each section starts on.
 *
 * Four sections is more than PAGE UP and PAGE DOWN want to walk a line at a
 * time, so the cursor's left and right — which this pane had no use for —
 * jump section to section. The indices are counted while the list is built
 * rather than written down, which is the same reason the faded-key count is.
 */
const SECTIONS = [
  ['WHERE THIS CONTROL DIFFERS', DIVERGENCES],
  ['G CODES THIS MACHINE RUNS', G_CODES],
  ['M CODES THIS MACHINE RUNS', M_CODES],
  ['CODES IT WILL REFUSE', REFUSED]
]

export const HELP = []
export const HELP_SECTIONS = []

for (const [title, lines] of SECTIONS) {
  HELP_SECTIONS.push(HELP.length)
  HELP.push(rule(title), ...lines, ['', ''])
}

/** How many lines of HELP the pane shows at once. */
export const HELP_ROWS = 10

/**
 * A code with a reference is a link to it. The pendant it copies is a sealed
 * control with a paper manual beside it; this one is a browser, and a student
 * who wants to know what G83's Q actually does is one click from the page that
 * defines it. Only the label links — underlining the padding as well draws a
 * yellow rule across the pane.
 */
function helpBody (s) {
  const from = helpFrom(s)
  return html`<pre>${HELP.slice(from, from + HELP_ROWS).map(([label, text, url]) => html`<div
    ><span class="k">${url
      ? html`<a href=${url} target="_blank" rel="noopener">${label}</a>`
      : label}${' '.repeat(Math.max(0, 14 - label.length))}</span>${text}</div>`)}</pre>`
}

/** Clamped so PAGE DOWN cannot walk off the end and leave a blank page. */
export const helpFrom = (s) => Math.max(0, Math.min(s.helpRow ?? 0, HELP.length - HELP_ROWS))
export const helpTotal = HELP.length

const PLACEHOLDER = {}

/** Two panes carry two pages behind one key, so the title has to say which. */
const mainTitle = (s) =>
  s.activePane === 'offset'
    ? (s.offsetPage === 'tool' ? 'TOOL OFFSET' : 'WORK OFFSET')
    : s.activePane === 'list'
      ? (s.listPage === 'sd' ? 'MACHINE SD CARD' : 'LIST PROGRAM')
      // HELP is longer than the pane, so the title carries the position — it
      // costs no row, and without it nothing says there is more below.
      : s.activePane === 'help'
        ? `HELP  ${helpFrom(s) + 1}-${Math.min(helpFrom(s) + HELP_ROWS, helpTotal)} / ${helpTotal}`
        : (MAIN_TITLE[s.activePane] ?? '')

function mainBody (s) {
  if (s.activePane === 'position') return positionBody(s)
  if (s.activePane === 'program') return programBody(s)
  if (s.activePane === 'setting') return settingBody(s)
  if (s.activePane === 'list') return listBody(s)
  if (s.activePane === 'mdi') return mdiBody(s)
  if (s.activePane === 'alarms') return alarmBody(s)
  if (s.activePane === 'offset') return offsetBody(s)
  if (s.activePane === 'current') return currentBody(s)
  if (s.activePane === 'param') return paramBody(s)
  if (s.activePane === 'help') return helpBody(s)
  return html`<pre class="dim">${PLACEHOLDER[s.activePane] ?? ''}</pre>`
}

const pane = (id, title, body, active) => html`
  <section class=${'pane pane-' + id + (active ? ' active' : '')}>
    ${title ? html`<h3>${title}</h3>` : nothing}
    ${body}
  </section>`

export const screen = (s) => s.powered ? lit(s) : html`<div class="screen off"></div>`

/**
 * A control with its power off. Not a black rectangle — an unlit LCD is never
 * quite black, and one that were would read as a broken display rather than a
 * cold one. The glass is still there; nothing behind it is.
 *
 * Deliberately empty. There is no "press POWER ON" prompt because a machine does
 * not have one: the panel is dark and one button on it is lit green, which is how
 * anyone has ever worked out how to start a machine tool.
 */
const lit = (s) => html`
  <div class="screen">
    <div class="modebar">
      <span>${s.mode}: ${s.fn}</span>
      <span>${(s.activePane ?? '').toUpperCase()}</span>
    </div>

    ${pane('program', 'PROGRAM', programBody(s), s.activePane === 'program')}

    ${pane('codes', 'ACTIVE CODES', html`<pre>${s.modal || '—'}</pre>`, false)}

    ${pane('tool', 'ACTIVE TOOL', html`
      <pre>T${String(s.tool).padStart(2, '0')}
<span class="dim">OFFSET</span> ${fmt(s.tlo * displayScale(s.reportUnits, s.units), s.units === 'IN', s.stale)}</pre>`, false)}

    ${pane('coolant', 'COOLANT', html`
      <pre class=${s.stale ? 'dim' : s.coolant ? 'k' : 'dim'}>${s.stale ? '—' : s.coolant ? 'ON' : 'OFF'}</pre>`, false)}

    ${pane('main', mainTitle(s), mainBody(s), s.activePane !== 'program')}

    ${/* F2.34 puts feed and the overrides in Main Spindle, not the status bar
          or the timers pane — the data was always held, just placed wrong. */''}
    ${pane('spindle', 'MAIN SPINDLE', html`
      <pre><span class="dim">RPM </span> ${s.stale ? '—' : Math.round(s.spindle)}  <span class="dim">DIR</span> ${s.stale || !s.spindleDir ? '—' : s.spindleDir > 0 ? 'FWD' : 'REV'}
<span class="dim">FEED</span> ${s.stale ? '—' : Math.round(s.feed)}
<span class="dim">OVR </span> ${s.stale ? '—' : `${s.ov.feed}/${s.ov.rapid}/${s.ov.spindle}`}</pre>`, false)}

    ${/* One line: X value  Y value  Z value  A value, top aligned. The axis
          letter sits with its own number rather than in a header row above, so
          the row is the whole pane and the digits get all the height there is. */''}
    ${pane('position', 'POSITION ' + s.wcs, html`
      <div class="axisrow">
        ${AXES.map((a, i) => html`<div><i>${a}</i><span>${fmt(
          (s.mpos[i] - s.wco[i]) * displayScale(s.reportUnits, s.units),
          s.units === 'IN', s.stale)}</span></div>`)}
      </div>`, false)}

    ${pane('timers', 'TIMERS', html`
      <pre><span class="dim">THIS   </span> ${clock(s.cycleMs)}
<span class="dim">LAST   </span> ${clock(s.lastCycleMs)}
<span class="dim">M30 CNT</span> ${s.parts}</pre>`, false)}

    ${pane('status', null, html`
      <pre>${s.stale
        ? html`<span class="k">LINK DOWN</span>`
        : html`${s.machineState}  ${s.link}`}  <span
        class="dim">${s.units}</span>  ${s.message ?? ''}</pre>`, false)}

    <section class=${'pane pane-alarm' + (s.alarm ? ' on' : '')}>
      <pre>${s.alarm ?? 'NO ALARM'}</pre>
    </section>

    ${pane('icons', null, html`<pre class="k">${
      ['INC ' + s.increment, 'HANDLE ' + 'XYZA'[s.jogAxis], s.shifted && 'SHIFT',
        s.singleBlock && 'SNGL BLK', s.dryRun && 'DRY RUN', s.optionStop && 'OPT STOP',
        s.blockDelete && 'BLK DEL',
        s.chipFwd && 'CHIP FWD', s.tsc && 'TSC',
        s.jogLock && (s.latched !== null ? 'JOG LOCK ▶ ' + 'XYZA'[s.latched] : 'JOG LOCK'),
        s.handleMode !== 'jog' && 'HANDLE ' + s.handleMode.toUpperCase()]
        .filter(Boolean).join('   ')
    }</pre>`, false)}

    ${pane('input', null, html`<pre>${s.input ? '> ' + s.input : ''}<span class="k">${s.input ? '_' : ''}</span></pre>`, false)}
  </div>`
