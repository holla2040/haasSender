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
    [num('7', '&'), num('8', '@'), num('9', '°')],
    [num('4', '%'), num('5', '$'), num('6', '!')],
    [num('1', '*'), num('2', "'"), num('3', '?')],
    [k('minus', '−', { big: true, sup: '+' }), num('0', '='), k('dot', '·', { big: true, sup: '#' })],
    [k('cancel', 'CANCEL'), k('space', 'SPACE'), k('enter', 'ENTER')]
  ]
}

export const GROUPS = { FUNCTION, JOG, OVERRIDES, DISPLAY, CURSOR, MODE, ALPHA, NUMERIC }

// ---------------------------------------------------------------- mode mapping

/**
 * T2.11 — which mode each mode key selects, and what the mode bar reads.
 * Three modes only: Setup, Edit and Operation.
 */
export const MODES = {
  'mode-zero-return': { mode: 'SETUP', fn: 'ZERO' },
  'mode-jog': { mode: 'SETUP', fn: 'JOG' },
  'mode-edit': { mode: 'EDIT', fn: 'EDIT' },
  'mode-mdi': { mode: 'EDIT', fn: 'MDI' },
  'mode-list': { mode: 'EDIT', fn: 'LIST' },
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

/** Handle-jog increments, in the order the keys sit on the panel. */
export const INCREMENTS = {
  'inc-0001': 0.0001, 'inc-001': 0.001, 'inc-01': 0.01, 'inc-1': 0.1
}
