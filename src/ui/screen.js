import { html, nothing } from 'lit-html'
import { WCS, TOOL_COUNT, words, modalGroups } from '../grbl.js'
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
      ${droRow('WORK ' + s.wcs, work, s)}
      ${droRow('MACHINE', s.mpos, s)}
      ${droRow('DIST TO GO', s.dtg ?? [0, 0, 0, 0], s, s.dtg === null)}
    </div>`
}

/**
 * The program with the EDIT cursor on it — a *word* picked out, not a character,
 * because that is the unit a HAAS cursor moves in and the unit INSERT, ALTER and
 * DELETE all act on.
 */
function editBody (s) {
  const from = Math.max(0, Math.min(s.editRow - 4, s.program.lines.length - 10))
  return html`<pre>${s.program.lines.slice(from, from + 10).map((l, i) => {
    const row = from + i
    if (row !== s.editRow) return html`<div class=${l.del && s.blockDelete ? 'skipped' : ''}>${l.text}</div>`
    const w = words(l.text)
    return html`<div>${w.map((word, j) => html`<span
      class=${j === s.editWord ? 'cur' : ''}>${word}</span>${j < w.length - 1 ? ' ' : ''}`)}</div>`
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
 * MDI — type a block, WRITE/ENTER runs it.
 *
 * The history is worth showing rather than throwing away: half of learning MDI is
 * seeing what you just told the machine, and an error against the block that
 * caused it teaches more than an error on its own.
 */
function mdiBody (s) {
  return html`<pre>${s.mdi.length
    ? s.mdi.map(h => html`<div class=${h.error ? 'k' : ''}>${h.text}${h.error ? '   ' + h.error : ''}</div>`)
    : html`<span class="dim">Type a block and press WRITE/ENTER.</span>`}
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
 * Deliberately not curated. grbl has around ninety numbered settings and deciding
 * which ten a student "should" see is a judgement this control has no business
 * making silently — the numbers are the machine's, and `$$` is what it says. What
 * is added is the handful of descriptions that matter for reading the rest of
 * this control, and nothing is editable here: writing a setting is a different
 * kind of act from writing a work offset, and it is not one to do by accident.
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
    class=${from + i === s.paramRow ? 'cur' : ''}>${('   $' + k + '        ').slice(0, 8)}${
    ('            ' + s.settings[k]).slice(-13)}  <span class="dim">${SETTING_NOTE[k] ?? ''}</span></div>`)}<span class="dim">Read-only, and the machine's own. $13 decides what MPos: means.</span></pre>`
}

/** The few settings that explain how the rest of this control behaves. */
const SETTING_NOTE = {
  13: 'report in inches — governs what MPos: means',
  20: 'soft limits',
  21: 'hard limits',
  22: 'homing cycle enabled',
  30: 'max spindle RPM',
  31: 'min spindle RPM',
  32: 'laser mode',
  130: 'X max travel',
  131: 'Y max travel',
  132: 'Z max travel'
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
      p.o === s.program.o ? '*' : ' '} ${p.name}</div>`
  })}
<span class="dim">* is selected. SELECT PROGRAM loads, ERASE PROGRAM removes.</span></pre>`
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
 * needs to know exactly where the replica stops.
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
 * Each entry is [label, text]; a blank label continues the one above it.
 */
const HELP = [
  ['', 'A HAAS-lookalike control driving a grblHAL machine. The'],
  ['', 'keypad, the panes and the modes are the real layout. The'],
  ['', 'machine underneath is not a HAAS. Where that shows:'],
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
  ['Tool offsets', 'This control owns the tool table; the machine has'],
  ['', 'none at all. G43 H&#8202;n is sent as G43.1 Z<length>, as its'],
  ['', 'own block, and TOOL OFFSET MEASURE stores the machine'],
  ['', 'Z where the tip is. A dash means never measured.'],
  ['', ''],
  ['Work offsets', 'G154 P1-P3 are this machine\'s G59.1-G59.3. A HAAS'],
  ['', 'goes on to P20; those do not exist here. PART ZERO'],
  ['', 'SET stores the machine position into the cell.'],
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
  ['$ commands', 'SHIFT then 5 types the $ character. $X clears an'],
  ['', 'alarm, $H homes. The ALARMS page says which is which.'],
  ['', ''],
  ['EMERGENCY', 'A software reset. It is NOT a hardware E-stop and'],
  ['STOP', 'cannot be one from a browser.'],
  ['', ''],
  ['Homing', 'Wired, but never tested: the bench machine has no'],
  ['', 'limit switches. It says so when pressed.']
]

/** How many lines of HELP the pane shows at once. */
export const HELP_ROWS = 10

function helpBody (s) {
  const from = helpFrom(s)
  return html`<pre>${HELP.slice(from, from + HELP_ROWS).map(([label, text]) => html`<div
    ><span class="k">${(label + '              ').slice(0, 14)}</span>${text}</div>`)}</pre>`
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

    ${pane('spindle', 'MAIN SPINDLE', html`
      <pre><span class="dim">RPM</span> ${s.stale ? '—' : Math.round(s.spindle)}
<span class="dim">DIR</span> ${s.stale || !s.spindleDir ? '—' : s.spindleDir > 0 ? 'FWD' : 'REV'}</pre>`, false)}

    ${pane('position', 'POSITION', html`
      <div class="dro">
        <b></b>${AXES.map(a => html`<span class="dim">${a}</span>`)}
        ${droRow('WORK', s.mpos.map((v, i) => v - s.wco[i]), s)}
      </div>`, false)}

    ${pane('timers', 'TIMERS', html`
      <pre><span class="dim">THIS </span> ${clock(s.cycleMs)}
<span class="dim">LAST </span> ${clock(s.lastCycleMs)}
<span class="dim">PARTS</span> ${s.parts}
<span class="dim">OVR  </span> ${s.stale ? '—' : `${s.ov.feed}/${s.ov.rapid}/${s.ov.spindle}`}</pre>`, false)}

    ${pane('status', null, html`
      <pre>${s.stale
        ? html`<span class="k">LINK DOWN</span>`
        : html`${s.machineState}  ${s.link}  F${Math.round(s.feed)}`}  <span
        class="dim">${s.units}</span>  ${s.message ?? ''}</pre>`, false)}

    <section class=${'pane pane-alarm' + (s.alarm ? ' on' : '')}>
      <pre>${s.alarm ?? 'NO ALARM'}</pre>
    </section>

    ${pane('icons', null, html`<pre class="k">${
      ['INC ' + s.increment, 'HANDLE ' + 'XYZA'[s.jogAxis], s.shifted && 'SHIFT',
        s.singleBlock && 'SNGL BLK', s.dryRun && 'DRY RUN', s.optionStop && 'OPT STOP',
        s.blockDelete && 'BLK DEL',
        s.jogLock && (s.latched !== null ? 'JOG LOCK ▶ ' + 'XYZA'[s.latched] : 'JOG LOCK'),
        s.handleMode !== 'jog' && 'HANDLE ' + s.handleMode.toUpperCase()]
        .filter(Boolean).join('   ')
    }</pre>`, false)}

    ${pane('input', null, html`<pre>${s.input ? '> ' + s.input : ''}<span class="k">${s.input ? '_' : ''}</span></pre>`, false)}
  </div>`
