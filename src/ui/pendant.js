import { html, nothing } from 'lit-html'
import { FUNCTION, JOG, OVERRIDES, DISPLAY, CURSOR, MODE, ALPHA, NUMERIC, VERIFIED, UNAVAILABLE } from '../keys.js'

// The pendant: brushed panel, left-hand controls, screen and keyboard.
// Layout and key legends follow figure F2.26 of the 2014 Mill Operator's Manual.

const cls = (...parts) => parts.filter(Boolean).join(' ')

function keyTpl (key, press) {
  // Entries with no id are printed labels, not keys — SPINDLE and CURSOR.
  if (!key.id) return html`<div class="label">${key.label}</div>`

  const style = key.span ? `grid-column: span ${key.span}` : nothing
  // Three states, because three are true: it works, it can never work, or it is
  // simply not built yet. Now that most of the panel works, the *exceptions* are
  // what get marked — a working key looks like a key, which is the point.
  //
  // No `title` tooltips: the legend printed on a key is what a real pendant gives
  // you, and a key that cannot do its job says so on the status bar when pressed,
  // which is where an operator is already looking.
  const why = UNAVAILABLE.get(key.id)
  return html`
    <button
      class=${cls('key', key.variant, key.big && 'big', key.shift && 'shift',
                  key.rule && 'rule', key.inline && 'inline',
                  !why && !VERIFIED.has(key.id) && 'todo', why && 'na')}
      style=${style}
      data-key=${key.id}
      @pointerdown=${(e) => { e.preventDefault(); press(key.id) }}>
      ${key.corner ? html`<i class="corner ${key.corner}"></i>` : nothing}
      ${key.sup ? html`<span class="sup">${key.sup}</span>` : nothing}
      ${key.glyph && key.inline !== 'after' ? html`<span class="glyph">${key.glyph}</span>` : nothing}
      <span class="lines">${key.lines.map(l => html`<span>${l}</span>`)}</span>
      ${key.glyph && key.inline === 'after' ? html`<span class="glyph">${key.glyph}</span>` : nothing}
    </button>`
}

function groupTpl (group, press) {
  return html`
    <section
      class=${cls('group', 'grp-' + group.id, group.panel && 'panel-' + group.panel)}
      style="grid-template-columns: repeat(${group.columns}, minmax(0, 1fr))">
      ${group.title ? html`<h2>${group.title}</h2>` : nothing}
      ${group.rows.flat().map(key => keyTpl(key, press))}
    </section>`
}

/**
 * The handwheel, one detent per graduation on the ring it is drawn with.
 *
 * It is a knob, so it turns: grab it and rotate. That is the only affordance a
 * round control needs, and it was missing — the dial answered a mouse wheel and
 * nothing else, which is undiscoverable on something that looks like this. The
 * wheel still works for anyone who finds it.
 *
 * Clockwise is positive. `atan2` already grows clockwise in screen coordinates,
 * where y points down, so no sign to get wrong here.
 */
const DETENT = 9        // degrees, matching the graduations drawn on the ring

function turnDial (e, jogWheel) {
  const box = e.currentTarget.getBoundingClientRect()
  const cx = box.left + box.width / 2
  const cy = box.top + box.height / 2
  const angle = (ev) => Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI

  let last = angle(e)
  let carry = 0

  // On window, not the dial: a hand that slides off the knob mid-turn should keep
  // turning it, and should still let go when the button comes up anywhere at all.
  const move = (ev) => {
    let step = angle(ev) - last
    if (step > 180) step -= 360          // across the -180/180 seam
    if (step < -180) step += 360
    last += step
    carry += step
    while (Math.abs(carry) >= DETENT) {
      const dir = carry > 0 ? 1 : -1
      carry -= dir * DETENT
      jogWheel(dir)
    }
  }
  const up = () => {
    removeEventListener('pointermove', move)
    removeEventListener('pointerup', up)
    removeEventListener('pointercancel', up)
  }
  addEventListener('pointermove', move)
  addEventListener('pointerup', up)
  addEventListener('pointercancel', up)
}

/* A stand-in for the roundel badge. Deliberately NOT a copy of the HAAS mark —
   see the note in README about reproducing a trademark on a lookalike. */
const badge = html`
  <div class="logo" aria-hidden="true">
    <svg viewBox="0 0 100 100">
      <path d="M22 72 L44 20 h14 L36 72 Z" fill="#8c1420"/>
      <path d="M50 72 L72 20 h14 L64 72 Z" fill="#8c1420"/>
      <path d="M34 50 h40 v9 h-40 Z" fill="#8c1420"/>
    </svg>
  </div>`

export const pendant = (state, actions) => {
  const press = actions.press
  return html`
    <div class="pendant">
      <div class="column">
        ${badge}

        <div class="pair">
          <div>
            <button class="pb green" data-key="power-on" @click=${() => press('power-on')} aria-label="Power on"></button>
            <span class="legend">POWER<br>ON</span>
          </div>
          <div>
            <button class="pb red" data-key="power-off" @click=${() => press('power-off')} aria-label="Power off"></button>
            <span class="legend">POWER<br>OFF</span>
          </div>
        </div>

        <span class="legend">EMERGENCY STOP</span>
        <button class="estop" data-key="estop" @click=${() => press('estop')} aria-label="Emergency stop"><i></i></button>

        <span class="legend">HANDLE JOG</span>
        <div class="dial"
             @pointerdown=${(e) => { e.preventDefault(); turnDial(e, actions.jogWheel) }}
             @wheel=${(e) => { e.preventDefault(); actions.jogWheel(e.deltaY < 0 ? 1 : -1) }}>
          <i style="transform: rotate(${state.dial}deg)"></i>
        </div>

        <div class="pair">
          <div>
            <button class="pb green" data-key="cycle-start" @click=${() => press('cycle-start')} aria-label="Cycle start"></button>
            <span class="legend">CYCLE<br>START</span>
          </div>
          <div>
            <button class="pb red" data-key="feed-hold" @click=${() => press('feed-hold')} aria-label="Feed hold"></button>
            <span class="legend">FEED<br>HOLD</span>
          </div>
        </div>
      </div>

      <div class="stack">
        ${state.screen}
        <div class="keyboard">
          ${[FUNCTION, JOG, OVERRIDES, DISPLAY, CURSOR, MODE, ALPHA, NUMERIC]
            .map(g => groupTpl(g, press))}
        </div>
      </div>
    </div>`
}
