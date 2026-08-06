import { html, nothing } from 'lit-html'

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

const droRow = (label, values, s) => {
  const k = displayScale(s.reportUnits, s.units)
  const inches = s.units === 'IN'
  return html`
    <b>${label}</b>${values.map(v => html`<span>${fmt(v * k, inches, s.stale)}</span>`)}`
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
      ${droRow('DIST TO GO', s.dtg, s)}
    </div>`
}

function programBody (s) {
  if (!s.program.lines.length) {
    return html`<pre class="dim">no program in memory

Load a file, or press
LIST PROGRAM.</pre>`
  }
  // Window the listing around the running block rather than rendering thousands
  // of lines; the pane only shows a dozen or so anyway.
  const cur = Math.max(0, s.program.current - 1)
  const from = Math.max(0, cur - 4)
  const slice = s.program.lines.slice(from, from + 16)
  return html`<pre>${slice.map((l, i) => html`<div class=${from + i === cur ? 'cur' : ''}>${l.text}</div>`)}</pre>`
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

const MAIN_TITLE = {
  position: 'POSITION',
  program: 'PROGRAM',
  offset: 'OFFSET',
  current: 'CURRENT COMMANDS',
  alarms: 'ALARMS',
  param: 'PARAMETER / DIAGNOSTIC',
  setting: 'SETTING / GRAPHIC',
  help: 'HELP'
}

const PLACEHOLDER = {
  offset: 'OFFSET — phase 4',
  current: 'CURRENT COMMANDS — phase 4',
  alarms: 'ALARMS — phase 4',
  param: 'PARAMETER / DIAGNOSTIC',
  help: 'HELP'
}

function mainBody (s) {
  if (s.activePane === 'position') return positionBody(s)
  if (s.activePane === 'program') return programBody(s)
  if (s.activePane === 'setting') return settingBody(s)
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
      <pre><span class="dim">FEED</span>  ${s.stale ? '—' : Math.round(s.feed)}
<span class="dim">OVR</span>   ${s.stale ? '—' : `${s.ov.feed}% / ${s.ov.rapid}% / ${s.ov.spindle}%`}
<span class="dim">INC</span>   ${s.increment}</pre>`, false)}

    ${pane('status', null, html`
      <pre>${s.stale
        ? html`<span class="k">LINK DOWN</span>`
        : html`${s.machineState}  ${s.link}`}  <span class="dim">${s.units}</span>  ${s.message ?? ''}</pre>`, false)}

    <section class=${'pane pane-alarm' + (s.alarm ? ' on' : '')}>
      <pre>${s.alarm ?? 'NO ALARM'}</pre>
    </section>

    ${pane('icons', null, html`<pre class="dim">${s.jogLock ? 'LOCK' : ''}</pre>`, false)}

    ${pane('input', null, html`<pre>${s.input ? '> ' + s.input : ''}<span class="k">${s.input ? '_' : ''}</span></pre>`, false)}
  </div>`
