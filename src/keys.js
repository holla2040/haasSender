// The pendant keyboard, transcribed from figure F2.26 of the 2014 Mill Operator's
// Manual (96-8200, PDF page 55) and cross-checked against images/haas2.jpg.
//
// The manual groups the keys into eight functional areas and this file keeps that
// grouping, because it is how the manual — and therefore a student — refers to them.
//
// Key shape:
//   id      dispatch name
//   lines   label lines, top to bottom, exactly as printed on the key
//   variant face colour: 'grey' (default) | 'cyan' | 'reset' | 'mode'
//   sup     small yellow shifted-character printed above the label
//   corner  yellow corner wedge on the rotary-axis keys: 'tl' | 'br'
//   glyph   arrow character rendered large next to the label
//   span    grid columns to occupy (default 1)
//   rule    draw the divider line the MDI/DNC key carries

const k = (id, lines, extra = {}) => ({ id, lines: [].concat(lines), ...extra })

// [1] Function keys ----------------------------------------------------------
export const FUNCTION = {
  id: 'function', columns: 4,
  rows: [
    [k('reset', 'RESET', { variant: 'reset', span: 2 }),
     k('power-up', ['POWER', 'UP', 'RESTART'], { variant: 'cyan' }),
     k('recover', 'RECOVER', { variant: 'cyan' })],

    [k('f1', 'F1', { big: true }), k('f2', 'F2', { big: true }),
     k('f3', 'F3', { big: true }), k('f4', 'F4', { big: true })],

    [k('tool-offset-measure', ['TOOL', 'OFFSET', 'MEASURE']),
     k('next-tool', ['NEXT', 'TOOL']),
     k('tool-release', ['TOOL', 'RELEASE']),
     k('part-zero-set', ['PART', 'ZERO', 'SET'])]
  ]
}

// [7] Jog keys ---------------------------------------------------------------
export const JOG = {
  id: 'jog', columns: 5, panel: 'cyan',
  rows: [
    [k('chip-fwd', ['CHIP', 'FWD'], { variant: 'cyan' }),
     k('jog-b-plus', ['+B', '-A/C'], { corner: 'tl' }),
     k('jog-z-plus', '+Z', { glyph: '▲' }),
     k('jog-y-minus', '-Y', { glyph: '◥' }),
     k('coolant-up', ['CLNT', 'UP'], { variant: 'cyan' })],

    [k('chip-stop', ['CHIP', 'STOP'], { variant: 'cyan' }),
     k('jog-x-plus', '+X', { glyph: '◀', inline: 'before' }),
     k('jog-lock', ['JOG', 'LOCK']),
     k('jog-x-minus', '-X', { glyph: '▶', inline: 'after' }),
     k('coolant-down', ['CLNT', 'DOWN'], { variant: 'cyan' })],

    [k('chip-rev', ['CHIP', 'REV'], { variant: 'cyan' }),
     k('jog-y-plus', '+Y', { glyph: '◣' }),
     k('jog-z-minus', '-Z', { glyph: '▼' }),
     k('jog-a-plus', ['+A/C', '-B'], { corner: 'br' }),
     k('aux-coolant', ['AUX', 'CLNT'], { variant: 'cyan' })]
  ]
}

// [8] Override keys ----------------------------------------------------------
export const OVERRIDES = {
  id: 'overrides', columns: 4, panel: 'black', title: 'OVERRIDES',
  rows: [
    [k('feed-minus', ['-10%', 'FEEDRATE']), k('feed-100', ['100%', 'FEEDRATE']),
     k('feed-plus', ['+10%', 'FEEDRATE']), k('handle-feed', ['HANDLE', 'CONTROL', 'FEED'])],

    [k('spindle-minus', ['-10%', 'SPINDLE']), k('spindle-100', ['100%', 'SPINDLE']),
     k('spindle-plus', ['+10%', 'SPINDLE']), k('handle-spindle', ['HANDLE', 'CONTROL', 'SPINDLE'])],

    [k('spindle-cw', 'CW', { big: true }), k('spindle-stop', 'STOP', { big: true }),
     k('spindle-ccw', 'CCW', { big: true }), { label: 'SPINDLE' }],

    [k('rapid-5', ['5%', 'RAPID']), k('rapid-25', ['25%', 'RAPID']),
     k('rapid-50', ['50%', 'RAPID']), k('rapid-100', ['100%', 'RAPID'])]
  ]
}

// [3] Display keys -----------------------------------------------------------
export const DISPLAY = {
  id: 'display', columns: 4, panel: 'black', title: 'DISPLAY',
  rows: [
    [k('page-program', 'PROGRAM'), k('page-position', 'POSITION'),
     k('page-offset', 'OFFSET'), k('page-current', ['CURRENT', 'COMMANDS'])],

    [k('page-alarms', 'ALARMS'), k('page-param', ['PARAMETER', 'DIAGNOSTIC']),
     k('page-setting', ['SETTING', 'GRAPHIC']), k('page-help', 'HELP')]
  ]
}

// [2] Cursor keys ------------------------------------------------------------
export const CURSOR = {
  id: 'cursor', columns: 3, panel: 'cyan',
  rows: [
    [k('home', 'HOME', { variant: 'cyan' }), k('up', '', { glyph: '▲' }),
     k('page-up', ['PAGE', 'UP'], { variant: 'cyan' })],

    [k('left', '', { glyph: '◀' }), { label: 'CURSOR' }, k('right', '', { glyph: '▶' })],

    [k('end', 'END', { variant: 'cyan' }), k('down', '', { glyph: '▼' }),
     k('page-down', ['PAGE', 'DOWN'], { variant: 'cyan' })]
  ]
}

// [4] Mode keys --------------------------------------------------------------
// The first key of each row is a mode selector and is drawn with the notched left
// edge the manual gives it. Rows 1-3 are Edit mode, 4-5 Setup, and MEMORY is
// Operation — see T2.11.
export const MODE = {
  id: 'mode', columns: 5,
  rows: [
    [k('mode-edit', 'EDIT', { variant: 'mode' }), k('insert', 'INSERT'),
     k('alter', 'ALTER'), k('delete', 'DELETE'), k('undo', 'UNDO')],

    [k('mode-memory', 'MEMORY', { variant: 'mode' }), k('single-block', ['SINGLE', 'BLOCK']),
     k('dry-run', ['DRY', 'RUN']), k('option-stop', ['OPTION', 'STOP']),
     k('block-delete', ['BLOCK', 'DELETE'])],

    [k('mode-mdi', ['MDI', 'DNC'], { variant: 'mode', rule: true }), k('coolant', 'COOLANT'),
     k('orient-spindle', ['ORIENT', 'SPINDLE']), k('atc-fwd', ['ATC', 'FWD']),
     k('atc-rev', ['ATC', 'REV'])],

    [k('mode-jog', ['HANDLE', 'JOG'], { variant: 'mode' }), k('inc-0001', ['.0001', '.1']),
     k('inc-001', ['.001', '1.']), k('inc-01', ['.01', '10.']), k('inc-1', ['.1', '100.'])],

    [k('mode-zero-return', ['ZERO', 'RETURN'], { variant: 'mode' }), k('zero-all', 'ALL'),
     k('zero-origin', 'ORIGIN'), k('zero-single', 'SINGLE'), k('zero-home', ['HOME', 'G28'])],

    [k('mode-list', ['LIST', 'PROGRAM'], { variant: 'mode' }),
     k('select-program', ['SELECT', 'PROGRAM']), k('send', 'SEND'),
     k('receive', 'RECEIVE'), k('erase-program', ['ERASE', 'PROGRAM'])]
  ]
}

// [6] Alpha keys -------------------------------------------------------------
const alpha = (ch) => k('alpha-' + ch.toLowerCase(), ch, { big: true })

export const ALPHA = {
  id: 'alpha', columns: 6,
  rows: [
    [k('shift', 'SHIFT', { shift: true }), ...'ABCDE'.split('').map(alpha)],
    ['FGHIJK'.split('').map(alpha)].flat(),
    ['LMNOPQ'.split('').map(alpha)].flat(),
    ['RSTUVW'.split('').map(alpha)].flat(),
    [alpha('X'), alpha('Y'), alpha('Z'),
     k('semicolon', ';', { big: true, sup: '/' }),
     k('paren-open', '(', { big: true, sup: '[' }),
     k('paren-close', ')', { big: true, sup: ']' })]
  ]
}

// [5] Numeric keys -----------------------------------------------------------
const num = (d, sup) => k('num-' + d, d, { big: true, sup })

export const NUMERIC = {
  id: 'numeric', columns: 3, panel: 'black',
  rows: [
    [num('7', '&'), num('8', '@'), num('9', ':')],
    [num('4', '%'), num('5', '$'), num('6', '!')],
    [num('1', '*'), num('2', "'"), num('3', '?')],
    [k('minus', '−', { big: true, sup: '+' }), num('0', '='), k('dot', '·', { big: true, sup: '#' })],
    [k('cancel', 'CANCEL'), k('space', 'SPACE'), k('enter', 'ENTER')]
  ]
}

export const GROUPS = { FUNCTION, JOG, OVERRIDES, DISPLAY, CURSOR, MODE, ALPHA, NUMERIC }

/**
 * The small yellow characters printed above some keys, reached with SHIFT.
 *
 * Taken from the key definitions rather than written out again, so the panel and
 * the keyboard cannot drift apart. This matters more here than on a real HAAS:
 * `$` is SHIFT+5, and without it there is no way to type `$X` to clear an alarm
 * or `$H` to home from the pendant at all.
 */
export const SHIFTED = Object.fromEntries(
  Object.values(GROUPS)
    .flatMap(g => g.rows.flat())
    .filter(k => k.id && k.sup)
    .map(k => [k.id, k.sup])
)

/**
 * A character typed on a real keyboard → the pendant key that types it.
 *
 * The MDI page is where g-code actually gets typed, and hunting for it one panel
 * key at a time is a lesson in patience rather than in machining. Letters, digits
 * and the yellow SHIFT legends come from the key definitions above so the two
 * keyboards cannot drift apart; the six punctuation keys are spelled out because
 * their legends are drawn with typographic glyphs (− and ·) no keyboard sends.
 *
 * `shift` means the character lives on a yellow legend: the caller arms the
 * panel's own one-shot SHIFT latch, so `$` types the same way from either keyboard.
 */
const PUNCTUATION = {
  ' ': 'space', '-': 'minus', '.': 'dot',
  ';': 'semicolon', '(': 'paren-open', ')': 'paren-close'
}

const SHIFT_CHARS = Object.fromEntries(Object.entries(SHIFTED).map(([id, ch]) => [ch, id]))

export function keyForChar (ch) {
  if (/^[A-Za-z]$/.test(ch)) return { id: 'alpha-' + ch.toLowerCase(), shift: false }
  if (/^[0-9]$/.test(ch)) return { id: 'num-' + ch, shift: false }
  if (PUNCTUATION[ch]) return { id: PUNCTUATION[ch], shift: false }
  if (SHIFT_CHARS[ch]) return { id: SHIFT_CHARS[ch], shift: true }
  return null
}

/** Key id to the legend printed on it, for messages that need to name a key. */
export const LEGEND = Object.fromEntries(
  Object.values(GROUPS)
    .flatMap(g => g.rows.flat())
    .filter(k => k.id)
    .map(k => [k.id, k.lines.join(' ').trim() || k.id])
)

/**
 * Keys that actually work, drawn with a green tint so it is obvious at a glance
 * what is real and what is still just a legend on a button.
 *
 * The bar for being on this list is deliberately high: the key's action must be
 * wired AND exercised by a passing test or observed working end to end. Several
 * keys are wired but not listed, because "wired" is not the same as "works" —
 * F2-F4 are legends only, and the rapid and spindle override keys send the right
 * byte but nothing has confirmed the machine acts on it. The cursor ◀ ▶ keys are
 * the same case: they change inch/metric on the SETTING page and do nothing
 * anywhere else, which is not what a green key promises.
 *
 * Add to this list as each phase lands, not when the handler is first written.
 *
 * Three states are drawn, because three are true: green here means it works,
 * faded means it can never work (see UNAVAILABLE), and a plain key means not
 * yet. Once most of the pendant is live, invert the first one — fade what is
 * still missing instead of tinting what is done.
 */
export const VERIFIED = new Set([
  // display pages with real content behind them
  'page-position', 'page-program',
  // SETTING carries the settings this control has — inch/metric, observed
  // switching the board's modal state and the DRO's units together — and, on a
  // second press, the GRAPHICS page (§3.8), checked against the simulator
  'page-setting',
  // OFFSET, and the two ways to write a cell in it: a typed value committed with
  // WRITE/ENTER, and PART ZERO SET storing the machine position. Both watched
  // going out as `G10 L2` and coming back through `$#`, in millimetres and in
  // inches — 30 mm stored from inch mode read back as 30.000 mm.
  'page-offset', 'part-zero-set', 'enter',
  // TOOL OFFSET MEASURE stores the machine Z into the sender's own tool table,
  // and `G43 H3 Z50.` with T03 measured at -20 left the board at Z30.000
  'tool-offset-measure',
  // ORIGIN zeroes the sender's own OPERATOR readout; no machine needed
  'zero-origin',
  // modes whose behaviour exists: jogging and running a program
  'mode-jog', 'mode-memory',
  // control memory — observed importing, filing by O-number, selecting and
  // erasing, and running the selected program on the real board
  'mode-list', 'select-program', 'erase-program',
  // the machine's SD card, over the grbl stream: RECEIVE listed it and pulled
  // meter.nc across as 535 blocks, SEND wrote a program back, and CYCLE START on
  // the card page ran it on the board itself — mode bar reading OPERATION: DNC
  'send', 'receive',
  // the run switches, each watched changing what reached the board: BLOCK DELETE
  // greying and skipping a `/` block, DRY RUN dropping M3/M8, OPTION STOP taking
  // the machine to Hold:0 on M01 and CYCLE START resuming it, SINGLE BLOCK
  // stepping one source block per press
  'block-delete', 'dry-run', 'option-stop', 'single-block',
  // handle-jog increments — observed changing the step and the resulting move
  'inc-0001', 'inc-001', 'inc-01', 'inc-1',
  // linear jog, $J= confirmed against both the simulator and the real board
  'jog-x-plus', 'jog-x-minus', 'jog-y-plus', 'jog-y-minus', 'jog-z-plus', 'jog-z-minus',
  // the rotary pair drives the fourth axis, and the board has one: `[AXS:4:XYZA]`.
  // Watched A go 5.000 → 25.000 → 15.000 on the real machine.
  'jog-b-plus', 'jog-a-plus',
  // CHIP FWD/STOP drive the IO-5 relay (M31/M33), AUX CLNT the IO-0 TSC pump
  // (M88/M89) — wired 2026-08-07, watched acking on the bench, A:M for TSC.
  'chip-fwd', 'chip-stop', 'aux-coolant',
  // F1 replaces the highlighted offset where WRITE/ENTER adds to it (§3.12
  // p.104) — watched in the browser writing G54 X. F2-F4 are still unbuilt,
  // and on a real HAAS F1 does nothing on most other pages either.
  'f1',
  // ZERO RETURN as a mode — the bar reads SETUP: ZERO. `HOME G28` is a move to a
  // stored position rather than a homing search, so it needs no limit switches
  // and is verified: watched taking the machine from X15 Y8 Z12 back to zero.
  // `ALL` and `SINGLE` are homing and stay unverified.
  'mode-zero-return', 'zero-home',
  // every override byte, each watched moving `Ov:` on the real board
  'feed-minus', 'feed-100', 'feed-plus',
  'spindle-minus', 'spindle-100', 'spindle-plus',
  'rapid-25', 'rapid-50', 'rapid-100',
  // flood toggle 0xA0 — seen turning `A:F` on and off on the board
  'coolant',
  // the handle as an override knob, 1% a click: four clicks read back Ov:104
  'handle-feed', 'handle-spindle',
  // JOG LOCK latches a jog key into a continuous move and the next press cancels
  // it with 0x85 — watched X run from 0 to 33.666 and stop under its own brakes
  'jog-lock',
  // M3/M4/M5, covered by the deferred M-code test and seen driving the spindle pane
  'spindle-cw', 'spindle-stop', 'spindle-ccw',
  // soft reset 0x18
  'reset',

  // EDIT: the word-level cursor and the four keys that act on it. Watched
  // altering, inserting and deleting a word, unwinding all three with UNDO, and
  // writing the result back into control memory.
  'mode-edit', 'insert', 'alter', 'delete', 'undo',
  // MDI — §4.2.3: the page holds the typed blocks, the editor keys work on it,
  // CYCLE START runs it, and a bad block comes back pinned to the line that
  // caused it
  'mode-mdi',
  // The cursor group. Every pane with something to point at now responds: the
  // EDIT word cursor, the PROGRAM listing, the offset grid, the tool table,
  // control memory, and the SETTING list. On a pane with no cursor they do
  // nothing, which is what the machine's do too.
  'left', 'right', 'up', 'down', 'home', 'end', 'page-up', 'page-down',
  // Typing. These feed the input bar, which is the entry buffer WRITE/ENTER
  // commits into whichever pane is active — offsets, tool lengths, MDI blocks and
  // the words EDIT inserts were all typed with these.
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(c => 'alpha-' + c.toLowerCase()),
  ...'0123456789'.split('').map(d => 'num-' + d),
  'minus', 'dot', 'space', 'cancel', 'semicolon', 'paren-open', 'paren-close',
  // SHIFT reaches the yellow legend above a key. Watched typing `$X` — SHIFT then
  // 5 then X — to clear a soft-limit alarm, which is the only way to reach `$` on
  // this keypad at all.
  'shift',
  // ALARMS shows the history with the cause and the recovery
  'page-alarms',
  // The last three display pages: CURRENT COMMANDS breaks out the `$G` modal
  // state by group, PARAMETER/DIAGNOSTIC reads `$$` off the machine read-only,
  // and HELP says where this replica stops being a HAAS
  'page-current', 'page-param', 'page-help'
])

/**
 * Keys the control can never honour, and the reason, in the words it should say
 * when one is pressed.
 *
 * This is a different state from "not implemented yet" and the pendant draws it
 * differently. A key that is merely unwired will light up green one day; these
 * will not, because there is nothing underneath them — either grbl has no such
 * command at all, or the machine has no such hardware. Telling a student "not
 * done yet" about a key that is never coming is its own small lie.
 *
 * Kept deliberately short. POWER UP RESTART and the RS-232 SEND/RECEIVE keys are
 * NOT here: they are unimplemented, not impossible, and claiming otherwise would
 * overstate what we know.
 *
 * Everything here is a property of the *class* of machine — no such hardware, or
 * no such command in grbl — rather than of one firmware build. `G28` was briefly
 * and wrongly in this table on the strength of a flaky measurement; see
 * `history/g28-false-alarm.md` for how that happened and what it cost. If a key
 * is only failing on the bench today, it does not belong here.
 */
export const UNAVAILABLE = new Map([
  // grbl's rapid override is a three-position switch: 0x95/0x96/0x97. There is no
  // fourth byte, so this key has nothing to send.
  ['rapid-5', 'RAPID 5% not supported — this control has 100%, 50% and 25%'],

  // A hobby-class grblHAL mill has no chip conveyor and no tool changer, and the
  // bench ClearCore has no mechanics attached at all.
  ['chip-rev', 'no reverse — the conveyor output is a single relay (M31/M33 only)'],

  ['next-tool', 'no tool changer fitted to this machine'],
  ['tool-release', 'no tool changer fitted to this machine'],
  ['atc-fwd', 'no tool changer fitted to this machine'],
  ['atc-rev', 'no tool changer fitted to this machine'],
  ['recover', 'no tool changer fitted to this machine'],

  // P-Cool: a positionable coolant spigot. Flood and mist exist (0xA0), the
  // spigot does not.
  ['coolant-up', 'no programmable coolant fitted to this machine'],
  ['coolant-down', 'no programmable coolant fitted to this machine'],

  // Spindle orientation. A grbl machine has no such thing — there is no encoder
  // and no closed loop to hold an angle, so `M19` is not a gap in this build, it
  // is a capability the class of machine does not have. The board answers
  // `error:20`, which is the parser agreeing.
  ['orient-spindle', 'no spindle orientation on a grbl machine — nothing to hold an angle']
])

// ---------------------------------------------------------------- mode mapping

/**
 * T2.11 — which mode each mode key selects, and what the mode bar reads.
 * Three modes only: Setup, Edit and Operation.
 */
export const MODES = {
  'mode-zero-return': { mode: 'SETUP', fn: 'ZERO' },
  'mode-jog': { mode: 'SETUP', fn: 'JOG' },
  // EDIT puts the program in the main display, where it is big enough to work in.
  'mode-edit': { mode: 'EDIT', fn: 'EDIT', activePane: 'program' },
  'mode-mdi': { mode: 'EDIT', fn: 'MDI', activePane: 'mdi' },
  // LIST PROGRAM shows control memory in the main display, so selecting the mode
  // and selecting the pane are the same act.
  'mode-list': { mode: 'EDIT', fn: 'LIST', activePane: 'list' },
  'mode-memory': { mode: 'OPERATION', fn: 'MEM' }
}

/** Display keys select which pane is active — the white one, per the manual. */
export const DISPLAY_PANES = {
  'page-program': 'program',
  'page-position': 'position',
  'page-offset': 'offset',
  'page-current': 'current',
  'page-alarms': 'alarms',
  'page-param': 'param',
  'page-setting': 'setting',
  'page-help': 'help'
}
// `mdi` and `list` are panes too, but they are reached by their MODE key rather
// than by a display key — which is how the machine does it.

/** Handle-jog increments, in the order the keys sit on the panel. */
export const INCREMENTS = {
  'inc-0001': 0.0001, 'inc-001': 0.001, 'inc-01': 0.01, 'inc-1': 0.1
}
