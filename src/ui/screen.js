import { html, nothing } from 'lit-html'
import { WCS } from '../grbl.js'

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

/** The four readouts a HAAS shows on the POSITION page. */
function positionBody (s) {
  const work = s.mpos.map((v, i) => v - s.wco[i])
  return html`
    <div class="dro big">
      <b></b>${AXES.map(a => html`<span class="dim">${a}</span>`)}
      ${droRow('OPERATOR', s.mpos.map((v, i) => v - s.operator[i]), s)}
      ${droRow('WORK ' + s.wcs, work, s)}
      ${droRow('MACHINE', s.mpos, s)}
      ${/* null when the running block cannot say — dashes, not a hopeful zero */''}
      ${droRow('DIST TO GO', s.dtg ?? [0, 0, 0, 0], s, s.dtg === null)}
    </div>`
}

function programBody (s) {
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

<span class="dim">CURSOR ◀ ▶ changes the value.</span>

<span class="dim">On a HAAS this is a stored setting. Here it is
modal g-code, so a program that commands G20 or
G21 changes it too — this pane follows the
machine rather than the other way round.</span></pre>`
}

/**
 * The OFFSET page: nine work coordinate systems, four axes each, with a cell
 * cursor. This is the pane the active-pane model exists for — it is the first
 * one an operator types into.
 *
 * Values arrive from `$#` in the machine's report unit and are converted for
 * display exactly as the DRO is, so switching to inches moves these too.
 */
function offsetBody (s) {
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
  })}
<span class="dim">Cursor moves the cell. Type a value and press WRITE/ENTER
to set it, or PART ZERO SET to store the current machine
position. G154 P1-P3 are this control's G59.1-G59.3 —
a HAAS goes on to P20, and those do not exist here.</span></pre>`
}

/** Control memory: what LIST PROGRAM shows, filed by O-number. */
function listBody (s) {
  if (!s.programs.length) {
    return html`<pre class="dim">control memory is empty

Import a file with the picker above the
pendant. It is filed by the O-number on
its first line.</pre>`
  }
  const from = Math.max(0, Math.min(s.listIndex - 6, s.programs.length - 14))
  return html`<pre>${s.programs.slice(from, from + 14).map((p, i) => {
    const at = from + i
    return html`<div class=${at === s.listIndex ? 'cur' : ''}>${p.o}   ${
      p.o === s.program.o ? '*' : ' '} ${p.name}</div>`
  })}

<span class="dim">* is the selected program. SELECT PROGRAM
loads the highlighted one, ERASE PROGRAM
removes it.</span></pre>`
}

const MAIN_TITLE = {
  position: 'POSITION',
  program: 'PROGRAM',
  list: 'LIST PROGRAM',
  offset: 'OFFSET',
  current: 'CURRENT COMMANDS',
  alarms: 'ALARMS',
  param: 'PARAMETER / DIAGNOSTIC',
  setting: 'SETTING / GRAPHIC',
  help: 'HELP'
}

const PLACEHOLDER = {
  current: 'CURRENT COMMANDS — phase 4',
  alarms: 'ALARMS — phase 4',
  param: 'PARAMETER / DIAGNOSTIC',
  help: 'HELP'
}

function mainBody (s) {
  if (s.activePane === 'position') return positionBody(s)
  if (s.activePane === 'program') return programBody(s)
  if (s.activePane === 'setting') return settingBody(s)
  if (s.activePane === 'list') return listBody(s)
  if (s.activePane === 'offset') return offsetBody(s)
  return html`<pre class="dim">${PLACEHOLDER[s.activePane] ?? ''}</pre>`
}

const pane = (id, title, body, active) => html`
  <section class=${'pane pane-' + id + (active ? ' active' : '')}>
    ${title ? html`<h3>${title}</h3>` : nothing}
    ${body}
  </section>`

export const screen = (s) => html`
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

    ${pane('main', MAIN_TITLE[s.activePane] ?? '', mainBody(s), s.activePane !== 'program')}

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
      ['INC ' + s.increment,
        s.singleBlock && 'SNGL BLK', s.dryRun && 'DRY RUN', s.optionStop && 'OPT STOP',
        s.blockDelete && 'BLK DEL', s.jogLock && 'JOG LOCK'].filter(Boolean).join('   ')
    }</pre>`, false)}

    ${pane('input', null, html`<pre>${s.input ? '> ' + s.input : ''}<span class="k">${s.input ? '_' : ''}</span></pre>`, false)}
  </div>`
