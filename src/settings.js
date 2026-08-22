import { TOOL_COUNT } from './grbl.js'

/**
 * The control's own settings — T6.2 p.337-340 of the 2014 Mill Operator's Manual.
 *
 * Only settings THIS control can honour on its own belong on this page. The
 * dividing line is not "sender-side" in the loose sense, it is: does the front
 * panel or the screen decide the behaviour, or does the motion firmware? The
 * panel and the screen are ours on any board — a ClearCore, a stock grbl Uno,
 * the sim. Motion is the board's, and a setting whose behaviour lives there
 * would sit here reading ON while changing nothing, which teaches a student that
 * the page is decoration. Those need a `caps` gate and a bench check first.
 *
 * `def` is the power-up value. `choices` makes a row the cursor keys cycle;
 * `min`/`max` makes one a typed number. A row with `get` does not store anything
 * — its value lives somewhere that is already the authority for it.
 */
export const SETTINGS = [
  { n: 6, name: 'FRONT PANEL LOCK', choices: ['OFF', 'ON'], def: 'OFF',
    note: 'ON disables SPINDLE CW / CCW. ATC FWD/REV already refuse — no changer fitted.' },

  // Setting 9 is stored on a HAAS and modal g-code here, so the machine's `$G`
  // is the authority and this row only shows what it last said. Changing it
  // commands G20/G21; `haassender.setting9` keeps the power-up half.
  // No `choices` list: every branch that could read one checks `get` first, so
  // the pair is commanded as G20/G21 rather than picked off a list, and a list
  // here would be documentation pretending to be behaviour.
  { n: 9, name: 'DIMENSIONING',
    get: (s) => (s.units === 'IN' ? 'INCH' : 'METRIC'),
    note: 'Modal G20/G21, not a stored setting — the machine\'s $G is the authority.' },

  { n: 31, name: 'RESET PROGRAM POINTER', choices: ['OFF', 'ON'], def: 'ON',
    note: 'ON: RESET moves the program pointer to the top. OFF leaves it where it stopped.' },

  // p.360 gives the range as 1 to 200 tools. This control has TOOL_COUNT of
  // them, so that is the ceiling — a row that let you ask for 200 and showed 20
  // would be a worse lie than the smaller number.
  { n: 90, name: 'MAX TOOLS TO DISPLAY', min: 1, max: TOOL_COUNT, def: TOOL_COUNT,
    note: `Rows on the TOOL OFFSET page. 1 to ${TOOL_COUNT} — this control holds ${TOOL_COUNT} tools.` },

  { n: 119, name: 'OFFSET LOCK', choices: ['OFF', 'ON'], def: 'OFF',
    note: 'ON: the OFFSET pages refuse edits. A running program may still change offsets.' }
]

const BY_N = new Map(SETTINGS.map(d => [d.n, d]))

/** The value shown on the page — the machine's where a row defers to it. */
export const settingValue = (s, d) => (d.get ? d.get(s) : s.set?.[d.n] ?? d.def)

/** An ON/OFF row as the boolean its guard wants. */
export const settingOn = (s, n) => settingValue(s, BY_N.get(n)) === 'ON'

/** How many tool rows the TOOL OFFSET page shows — Setting 90. */
export const maxTools = (s) => Number(settingValue(s, BY_N.get(90))) || TOOL_COUNT

/** What a control that has never stored a setting powers up with. */
export const settingDefaults = () =>
  Object.fromEntries(SETTINGS.filter(d => d.def !== undefined).map(d => [d.n, d.def]))

/**
 * Merge stored settings over the defaults, dropping anything this build no
 * longer has a row for. A value left behind by a removed setting would sit in
 * storage forever and come back if the number were ever reused for something
 * else — which is exactly how a settings file rots.
 */
export const settingsFromStore = (stored) => {
  const out = settingDefaults()
  for (const [k, v] of Object.entries(stored ?? {})) {
    const d = BY_N.get(Number(k))
    if (!d || d.get) continue                          // gone, or not ours to store
    if (d.choices) { if (d.choices.includes(v)) out[d.n] = v; continue }
    const n = Number(v)
    if (Number.isFinite(n)) out[d.n] = clampSetting(d, n)
  }
  return out
}

/** A typed number, held inside the row's range. p.341: the range is the range. */
export const clampSetting = (d, v) => Math.max(d.min, Math.min(d.max, Math.round(v)))

/** The next choice in a row's list — p.341, the horizontal cursor keys walk it. */
export const nextChoice = (d, current, dir) => {
  const at = d.choices.indexOf(current)
  return d.choices[(at + dir + d.choices.length) % d.choices.length]
}

/** Row index of a setting number, for the type-the-number jump. -1 if not ours. */
export const rowOfSetting = (n) => SETTINGS.findIndex(d => d.n === n)
