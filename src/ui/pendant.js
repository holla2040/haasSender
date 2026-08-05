import { html, nothing } from 'lit-html'
import { FUNCTION, JOG, OVERRIDES, DISPLAY, CURSOR, MODE, ALPHA, NUMERIC } from '../keys.js'

// The pendant: brushed panel, left-hand controls, screen and keyboard.
// Layout and key legends follow figure F2.26 of the 2014 Mill Operator's Manual.

const cls = (...parts) => parts.filter(Boolean).join(' ')

function keyTpl (key, press) {
  // Entries with no id are printed labels, not keys — SPINDLE and CURSOR.
  if (!key.id) return html`<div class="label">${key.label}</div>`

  const style = key.span ? `grid-column: span ${key.span}` : nothing
  return html`
    <button
      class=${cls('key', key.variant, key.big && 'big', key.shift && 'shift',
                  key.rule && 'rule', key.inline && 'inline')}
      style=${style}
      data-key=${key.id}
      title=${key.lines.join(' ')}
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
            <button class="pb green" @click=${() => press('power-on')} aria-label="Power on"></button>
            <span class="legend">POWER<br>ON</span>
          </div>
          <div>
            <button class="pb red" @click=${() => press('power-off')} aria-label="Power off"></button>
            <span class="legend">POWER<br>OFF</span>
          </div>
        </div>

        <span class="legend">EMERGENCY STOP</span>
        <button class="estop" @click=${() => press('estop')} aria-label="Emergency stop"><i></i></button>

        <span class="legend">HANDLE JOG</span>
        <div class="dial"
             @wheel=${(e) => { e.preventDefault(); actions.jogWheel(e.deltaY < 0 ? 1 : -1) }}
             title="Scroll to jog by the selected increment">
          <i style="transform: rotate(${state.dial}deg)"></i>
        </div>

        <div class="pair">
          <div>
            <button class="pb green" @click=${() => press('cycle-start')} aria-label="Cycle start"></button>
            <span class="legend">CYCLE<br>START</span>
          </div>
          <div>
            <button class="pb red" @click=${() => press('feed-hold')} aria-label="Feed hold"></button>
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
