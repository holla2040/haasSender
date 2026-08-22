import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SETTINGS, settingValue, settingOn, maxTools, settingDefaults,
  settingsFromStore, clampSetting, nextChoice, rowOfSetting
} from '../src/settings.js'
import { TOOL_COUNT } from '../src/grbl.js'

const at = (n) => SETTINGS.find(d => d.n === n)

// Every row has to be one kind of row or the other, because the page prints
// which keys change it and the dispatch branches on the same thing. A row that
// were neither would render an instruction nobody can follow.
test('every setting is a choice list, a range, or borrowed from elsewhere', () => {
  for (const d of SETTINGS) {
    const kinds = [!!d.choices, d.min !== undefined, !!d.get].filter(Boolean).length
    assert.equal(kinds, 1, `setting ${d.n} must be exactly one kind of row`)
    assert.ok(d.name && d.note, `setting ${d.n} needs a name and a note`)
    // A stored row needs a power-up value; a borrowed one must not have one.
    assert.equal(d.def !== undefined, !d.get, `setting ${d.n} default`)
    if (d.choices) assert.ok(d.choices.includes(d.def))
  }
})

test('a setting reads its default until something stores otherwise', () => {
  const s = { set: settingDefaults() }
  assert.equal(settingValue(s, at(119)), 'OFF')
  assert.equal(settingValue(s, at(31)), 'ON')      // RESET returns the pointer
  assert.equal(maxTools(s), TOOL_COUNT)
  assert.equal(settingOn(s, 31), true)
  assert.equal(settingOn(s, 119), false)
})

// Setting 9 is modal g-code, not a stored setting, so the row must follow the
// machine rather than anything we wrote down. Storing one would be the display
// telling a student the control is in inches while the machine cuts millimetres.
test('setting 9 reads the machine, and nothing can store over it', () => {
  assert.equal(settingValue({ set: {}, units: 'IN' }, at(9)), 'INCH')
  assert.equal(settingValue({ set: {}, units: 'MM' }, at(9)), 'METRIC')
  // even with a stored value sitting on its number
  assert.equal(settingValue({ set: { 9: 'INCH' }, units: 'MM' }, at(9)), 'METRIC')
  assert.equal(settingsFromStore({ 9: 'INCH' })[9], undefined)
})

test('the cursor keys walk a choice list and wrap both ways', () => {
  assert.equal(nextChoice(at(31), 'OFF', 1), 'ON')
  assert.equal(nextChoice(at(31), 'ON', 1), 'OFF')     // wraps forward
  assert.equal(nextChoice(at(31), 'OFF', -1), 'ON')    // and backward
})

test('a typed number is held inside the row range', () => {
  assert.equal(clampSetting(at(90), 0), 1)
  assert.equal(clampSetting(at(90), 999), TOOL_COUNT)
  assert.equal(clampSetting(at(90), 4.7), 5)
})

// The bug this exists to stop: a stored settings blob outliving the build that
// wrote it. A removed setting must not linger in storage waiting for its number
// to be reused, and a value that is no longer a legal choice must not come back
// and put the page into a state the cursor keys cannot walk out of.
test('stored settings are merged over defaults, and junk is dropped', () => {
  const merged = settingsFromStore({
    119: 'ON',            // good
    31: 'MAYBE',          // not a choice this row has
    90: '3',              // a number that arrived as a string
    6: 'ON',
    404: 'ON'             // a setting this build does not have
  })
  assert.equal(merged[119], 'ON')
  assert.equal(merged[31], 'ON')         // fell back to the default, not MAYBE
  assert.equal(merged[90], 3)
  assert.equal(merged[6], 'ON')
  assert.equal(merged[404], undefined)
  // Nothing stored at all still gives a complete, usable set.
  assert.deepEqual(settingsFromStore(null), settingDefaults())
  assert.deepEqual(settingsFromStore(undefined), settingDefaults())
})

test('an out-of-range stored number is pulled back into the range', () => {
  assert.equal(settingsFromStore({ 90: 500 })[90], TOOL_COUNT)
  assert.equal(settingsFromStore({ 90: 0 })[90], 1)
  assert.equal(settingsFromStore({ 90: 'twenty' })[90], TOOL_COUNT)  // default
})

// The type-a-number jump (p.66). A number this control has no row for has to be
// distinguishable from row 0, or typing 200 would silently land on setting 6.
test('the number jump finds a row, and says so when there is none', () => {
  assert.equal(rowOfSetting(SETTINGS[0].n), 0)
  assert.equal(SETTINGS[rowOfSetting(119)].n, 119)   // findable, wherever it sits
  assert.equal(rowOfSetting(200), -1)
  assert.equal(rowOfSetting(NaN), -1)
})

// Setting 1000 is this control's own and has no HAAS row behind it, so the two
// things that keep it honest are tested here: it lives past every number a HAAS
// uses, and its note says out loud that it is not one of them. Lose either and
// the page starts teaching a setting that does not exist on the machine.
test('a setting this control invented is numbered and labelled as its own', () => {
  const ln = at(1000)
  assert.ok(ln, 'SHOW LINE NUMBERS must be on the page')
  assert.match(ln.note, /NOT A HAAS SETTING/)
  // 1-249 and 900-916 are the HAAS blocks; the NGC reaches into the 300s.
  for (const d of SETTINGS) {
    const ours = d.n >= 1000
    assert.equal(ours, /NOT A HAAS SETTING/.test(d.note),
      `setting ${d.n}: a number past 999 and the divergence note go together`)
  }
})

// OFF at power-up, because the machine hides them until asked (p.129), and a
// trainer that opened showing numbers no HAAS shows would be teaching the
// divergence as the default.
test('line numbers are off until someone turns them on, and then persist', () => {
  const s = { set: settingDefaults() }
  assert.equal(settingOn(s, 1000), false)

  s.set = { ...s.set, 1000: nextChoice(at(1000), settingValue(s, at(1000)), 1) }
  assert.equal(settingOn(s, 1000), true)
  assert.equal(settingOn({ set: settingsFromStore(s.set) }, 1000), true)

  // And it is a real toggle, not a one-way switch — the cursor comes back.
  assert.equal(nextChoice(at(1000), 'ON', 1), 'OFF')
  assert.equal(nextChoice(at(1000), 'ON', -1), 'OFF')
})
