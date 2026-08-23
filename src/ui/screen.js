import { html, nothing } from 'lit-html'
import { WCS, TOOL_COUNT, words, modalGroups, describeSetting, HAAS_COLLISIONS } from '../grbl.js'
import { SETTINGS, settingValue, settingOn, maxTools } from '../settings.js'
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

// Rows a scrolling pane shows at once — and therefore how far PAGE UP and PAGE
// DOWN may step. A step bigger than the window scrolls past rows the operator
// never sees, which is not paging, it is skipping.
export const PANE_ROWS = 8

// The PROGRAM pane is the tall one, so it gets its own count — and PAGE UP and
// PAGE DOWN there step by it.
//
// Measured, not guessed: the pane is 13.87 text rows tall, so 13 is what fits
// whole. It was 16, and the three rows that overflowed were clipped by the
// pane's `overflow: hidden` — invisible while the window never reached the tail,
// and then END scrolled to the last block and the last block was not on screen.
// Re-measure if the screen's height, leading or type size moves:
//   (pane height - padding - heading) / line-height, in the browser.
export const PROGRAM_ROWS = 13

/**
 * The number drawn beside a program row under Setting 1000 — the line's place in
 * the FILE, never its place in the window. `from + i`, never `i`: numbering the
 * window would renumber the program every time the operator scrolled, and every
 * number below the first page would be wrong. Width comes from the whole program
 * so the column cannot shift as the window crosses 9, 99, 999.
 */
export const lineNumber = (from, i, total) =>
  String(from + i + 1).padStart(String(total).length)

/** First row on screen: the cursor kept mid-window, then clamped to the list. */
export const paneFrom = (row, total, rows = PANE_ROWS) =>
  Math.max(0, Math.min(row - Math.floor(rows / 2), total - rows))

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

/**
 * REMAIN: what is left of the estimate the cycle started with, counted down
 * against the same wall clock THIS runs on.
 *
 * A dash whenever there is no estimate — a job running off the machine's own
 * card, or a program the simulator would not read to the end. An estimate this
 * control could not make is shown as no answer, never as a zero that looks like
 * one. It stops at zero rather than counting up: the job is simply taking longer
 * than the derate says, and a negative clock would only say it twice.
 */
export const remain = (s) => s.job?.estMs == null ? '—' : clock(s.job.estMs - s.cycleMs)

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
  // Window the listing around the cursor rather than rendering thousands of
  // lines; the pane only shows a dozen or so anyway. Cursor and running-block
  // mark are the same row, because they are the same thing on the machine: the
  // control drives it while the program runs, the operator drives it when it
  // stops. `paneFrom` keeps it mid-pane and, unlike the fixed offset this used,
  // clamps at the tail — so END shows the last page instead of two lines and
  // fourteen blanks.
  const cur = Math.max(0, s.program.current - 1)
  const from = paneFrom(cur, s.program.lines.length, PROGRAM_ROWS)
  const slice = s.program.lines.slice(from, from + PROGRAM_ROWS)
  const numbered = settingOn(s, 1000)     // Setting 1000
  // The listing always shows the file as written, slashes and all. BLOCK DELETE
  // greys the blocks it will skip rather than hiding them — a student needs to
  // see what the switch is doing to the program in front of them.
  return html`<pre>${slice.map((l, i) => html`<div
    class=${(from + i === cur ? 'cur' : '') + (l.del && s.blockDelete ? ' skipped' : '')}
    >${numbered
      // Held off the code and dimmed, because these are not Nxx and a student
      // who reads them as program text has been taught something false. p.129:
      // "never saved as part of the program like Nxx numbers would be."
      ? html`<span class="ln">${lineNumber(from, i, s.program.lines.length)}  </span>`
      : nothing}${l.text}</div>`)}</pre>`
}

/**
 * The SETTING page — §2.4 p.65, T6.2 p.337.
 *
 * A list with a cursor, because that is what it is on the machine: the operator
 * either walks to a row or types its number and presses a vertical cursor key.
 * Two rows short of the pane, so the last two carry the manual's own habit of
 * telling you how to change the row you are standing on (p.341).
 */
// Width of the setting-number column, taken from the widest number actually on
// the page plus the two spaces that keep it off the name. Hardcoded at 5 this
// fitted every HAAS number and then Setting 1000 arrived and printed
// `1000SHOW LINE NUMBERS` — the four digits ate the whole gap. Derived, the
// column cannot be outgrown by a row someone adds later.
const SET_N_WIDTH = Math.max(...SETTINGS.map(d => String(d.n).length)) + 2

function settingBody (s) {
  const rows = PANE_ROWS - 2
  const from = paneFrom(s.setRow, SETTINGS.length, rows)
  const here = SETTINGS[s.setRow]
  // p.341: "The message near the top of the screen displays how to change the
  // selected setting." Which key changes it depends on which kind of row it is,
  // and guessing wrong is the whole reason the machine prints it.
  const how = here.get
    ? 'CURSOR ◀ ▶ commands it — nothing is stored here.'
    : here.choices
      ? 'CURSOR ◀ ▶ changes it.'
      : `Type ${here.min}-${here.max} and press WRITE/ENTER.`
  return html`<pre>${SETTINGS.slice(from, from + rows).map((d, i) => html`<div
    class=${from + i === s.setRow ? 'cur' : ''}>${(' ' + d.n).padEnd(SET_N_WIDTH)}${
    (d.name + '                       ').slice(0, 23)}<span
    class="k">${settingValue(s, d)}</span></div>`)}
<span class="dim">${here.note}
${how}  Type a number and press ▼ to jump.</span></pre>`
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
  // One row of this pane is spent on the column heading.
  const rows = PANE_ROWS - 1
  // Setting 90 — how many of the tools this control holds are worth looking at.
  const shown = maxTools(s)
  const from = paneFrom(s.toolRow, shown, rows)
  // Never more rows than Setting 90 admits to. Windowing alone is not enough —
  // with the setting down at 3 the window still starts at zero and a fixed row
  // count went right on drawing T04 through T07 underneath it.
  return html`<pre>  TOOL     LENGTH (Z)
${Array.from({ length: Math.min(rows, shown) }, (_, i) => {
    const n = from + i + 1
    const v = s.tools[n]
    return html`<div>  T${String(n).padStart(2, '0')}  ${
      n === s.tool ? '*' : ' '}${('          ' + (v === undefined
        ? '—'
        : fmt(v * k, inches, s.stale))).slice(-11)}</div>`
  })}
<span class="dim">${shown < TOOL_COUNT ? `T01-T${String(shown).padStart(2, '0')} of ${TOOL_COUNT} — Setting 90. ` : ''}TOOL OFFSET MEASURE stores the machine Z.</span></pre>`
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
  const from = paneFrom(s.editRow, lines.length)
  return html`<pre>${lines.slice(from, from + PANE_ROWS).map((l, i) => {
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

Press PARAMETER/DIAGNOSTIC again, or
WRITE/ENTER on an empty input bar, to ask
the machine for $$.</pre>`
  }
  const from = paneFrom(s.paramRow, keys.length)
  return html`<pre>${keys.slice(from, from + PANE_ROWS).map((k, i) => html`<div
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

Type Onnnnn and press SELECT PROGRAM to
create one, or import a file with the
picker above the pendant — that one is
filed by the O-number on its first line.</pre>`
  }
  const from = Math.max(0, Math.min(s.listIndex - 5, s.programs.length - 10))
  return html`<pre>${s.programs.slice(from, from + 10).map((p, i) => {
    const at = from + i
    return html`<div class=${at === s.listIndex ? 'cur' : ''}>${p.o}   ${
      p.o === s.program.o ? 'A' : ' '} ${p.name}</div>`
  })}
<span class="dim">A is the active program. SELECT PROGRAM loads, ERASE PROGRAM asks first.</span></pre>`
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
  graphics: 'GRAPHICS',
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
  ['G10 L1', 'native maintenance: write tool P length.', LC_G + 'g10-l1'],
  ['G10 L10', 'HAAS: set H tool P length from R (manual p.245).'],
  ['G17 G18 G19', 'plane for arcs and cycles: XY, ZX, YZ.', LC_G + 'g17-g19.1'],
  ['G20 G21', 'inch / millimetre.', LC_G + 'g20-g21'],
  ['G28', 'HAAS machine zero; named axes only; cancels H (p.249).'],
  ['G30', 'go to stored position 2. Same caveat.', LC_G + 'g30-g30.1'],
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
  ['M0', 'stop axes/spindle/coolant. CYCLE START resumes (p.322).'],
  ['M1', 'optional stop, when OPT STOP is on.', LC_M + 'm0-m1'],
  ['M2', 'program end.', LC_M + 'm2-m30'],
  ['M30', 'end/rewind; spindle/coolant off; cancel H (p.326).'],
  ['M3 M4 M5', 'spindle on CW / on CCW / off. S sets rpm.', LC_M + 'm3-m4-m5'],
  ['M6', 'tool change: it holds and waits for you.', LC_M + 'm6'],
  ['M7', 'mist coolant on. Same output as M88.', LC_M + 'm7-m8-m9'],
  ['M8', 'flood coolant on.', LC_M + 'm7-m8-m9'],
  ['M9', 'all coolant off.', LC_M + 'm7-m8-m9'],
  ['M98', 'call macro P<n>.macro off the card. n is 100+.', LC_M + 'm98-m99'],
  ['', 'An O<n> sub in the same file wants $700=1.'],
  ['M99', 'return from that sub.', LC_M + 'm98-m99'],
  ['M31 M33', 'chip conveyor forward / stop. This firmware.'],
  ['M88 M89', 'through-spindle coolant on / off. On M7 mist.'],
  ['M97', 'HAAS sub: run N<p> to M99, L times. Off the card'],
  ['', 'only — a streamed job has no file to seek in.']
]

/**
 * Break a sentence into lines that fit the pane's text column. A word longer
 * than the column overhangs on a line of its own rather than being cut — the
 * codes and offsets in these messages are the part that must stay readable.
 */
function wrapText (text, width) {
  const out = ['']
  for (const word of text.split(/\s+/)) {
    const at = out.length - 1
    if (!out[at]) out[at] = word
    else if (out[at].length + 1 + word.length <= width) out[at] += ' ' + word
    else out.push(word)
  }
  return out
}

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
  ['M62-M68', 'digital and analogue I/O: no ports registered.', HAL_PLUGIN],
  ['', ''],
  ['', 'The rest are refused for the opposite reason: this'],
  ['', 'machine WOULD run them, under a meaning the 2014'],
  ['', 'manual gives to something else. Printed from the'],
  ['', 'same table that stops them, so the page cannot drift'],
  ['', 'from the control.'],
  ['', ''],
  // One entry per collision, wrapped into the pane's text column. Nothing here
  // is written twice: edit HAAS_COLLISIONS and this list follows.
  ...HAAS_COLLISIONS.flatMap(([label, , why]) =>
    wrapText(why, 52).map((line, i) => [i ? '' : label, line]))
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
  ['Programs', 'LIST PROGRAM shows control memory. SELECT PROGRAM'],
  ['', 'loads the highlighted one. Type Onnnnn first and it'],
  ['', 'selects that program instead, or creates it if there'],
  ['', 'is none — that is how a new program is born here.'],
  ['', 'ERASE PROGRAM asks Y/N first and refuses the active'],
  ['', 'program. There is no UNDO for a deleted program.'],
  ['', ''],
  ['The card', 'RECEIVE lists the machine\'s SD card and copies a file'],
  ['', 'into control memory. CYCLE START on that page runs it'],
  ['', 'on the board itself, off its own card — the only way'],
  ['', 'to run one too big to copy. SEND writes back.'],
  ['', ''],
  ['$ commands', 'SHIFT then 5 types the $ character. $X clears an',
    'https://github.com/gnea/grbl/wiki/Grbl-v1.1-Commands'],
  ['', 'alarm, $H homes. RESET sends the $X for you once the'],
  ['', 'cycle is gone. The ALARMS page says which is which.'],
  ['', ''],
  ['Graphics', 'SETTING/GRAPHIC twice, then CYCLE START draws the'],
  ['', 'program from above instead of cutting it. No [F2]'],
  ['', 'zoom box and no [F3]/[F4] speed: the whole path is'],
  ['', 'fitted to the pane and drawn at once.'],
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

/**
 * The GRAPHICS page, §3.8: the program drawn from above — X right, Y up — which
 * is the view an operator already has in their head from standing at the table.
 *
 * Rapids are drawn dashed and dim, cutting moves solid. The manual makes that a
 * setting (4, Graphics Rapid Path) because a 1990s control had to choose; there
 * is no reason to make anyone choose here when the two can be told apart at a
 * glance.
 *
 * The path data is built once and hung on the plot object. A repaint runs four
 * times a second off the status report, and re-walking fifty thousand points to
 * produce the same string every time is the kind of waste that shows up as a
 * control that feels slow.
 */
function graphicsBody (s) {
  const p = s.plot
  if (!p) {
    return html`<pre class="dim">press CYCLE START to draw the program

Nothing moves. The control runs it against a
simulated machine and plots the tool path
from above: X right, Y up, rapids dashed.</pre>`
  }
  if (p.pts.length < 2) return html`<pre class="dim">nothing to draw — no motion in this program</pre>`

  if (!p.d) {
    let [x0, y0] = p.pts[0]
    let [x1, y1] = p.pts[0]
    for (const [x, y] of p.pts) {
      if (x < x0) x0 = x; else if (x > x1) x1 = x
      if (y < y0) y0 = y; else if (y > y1) y1 = y
    }
    // A program that only moves along one axis has no width. Give the box
    // something to be, or the viewBox divides by zero and the pane goes blank.
    const w = Math.max(x1 - x0, 0.001)
    const h = Math.max(y1 - y0, 0.001)
    const pad = Math.max(w, h) * 0.04
    const n = (v) => Math.round(v * 1000) / 1000
    const d = { feed: '', rapid: '' }
    let kind = null
    for (let i = 1; i < p.pts.length; i++) {
      const [x, y, rapid] = p.pts[i]
      const k = rapid ? 'rapid' : 'feed'
      // Y is negated rather than transformed: machine Y climbs, SVG Y falls.
      if (k !== kind) { d[k] += `M${n(p.pts[i - 1][0])} ${n(-p.pts[i - 1][1])}`; kind = k }
      d[k] += `L${n(x)} ${n(-y)}`
    }
    p.d = d
    p.box = [x0 - pad, -(y1 + pad), w + 2 * pad, h + 2 * pad].map(n).join(' ')
    p.tick = Math.max(w, h) * 0.02
    p.extent = [x0, x1, y0, y1]
  }

  const k = displayScale('MM', s.units)         // the plot is millimetres, always
  const f = (v) => (v * k).toFixed(s.units === 'IN' ? 4 : 3)
  const [x0, x1, y0, y1] = p.extent
  return html`
    <svg class="plot" viewBox=${p.box} preserveAspectRatio="xMidYMid meet">
      <path class="rapid" d=${p.d.rapid}></path>
      <path class="feed" d=${p.d.feed}></path>
      <path class="zero" d=${`M${-p.tick} 0h${p.tick * 2}M0 ${-p.tick}v${p.tick * 2}`}></path>
    </svg>
    <pre class="dim">X ${f(x0)} to ${f(x1)}   Y ${f(y0)} to ${f(y1)}   ${s.units}</pre>`
}

function mainBody (s) {
  if (s.activePane === 'position') return positionBody(s)
  if (s.activePane === 'program') return programBody(s)
  if (s.activePane === 'setting') return settingBody(s)
  if (s.activePane === 'graphics') return graphicsBody(s)
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

    ${/* REMAIN is this control's, not a HAAS row: the 2014 pane shows only what
          has already happened. It is an estimate and it is allowed to say it has
          none — a dash, never a zero pretending to be an answer. */''}
    ${pane('timers', 'TIMERS', html`
      <pre><span class="dim">THIS   </span> ${clock(s.cycleMs)}
<span class="dim">REMAIN </span> ${remain(s)}
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
