# Fidelity report — haasSender vs the 2014 Mill Operator's Manual

Validation of this replica against the reference it is built from:
`reference/english---mill-operator's-manual---2014.pdf` (96-8200 Rev B).
Page cites are **printed** page numbers; PDF page = printed + 20.

Every finding is one row: what the manual specifies, what the replica does,
and a classification:

| class | meaning |
|---|---|
| `BUG` | replica behaves differently and can be fixed sender-side |
| `MISSING` | not built; feasible on this stack |
| `DELIBERATE` | documented divergence, kept on purpose (with the reason) |
| `FIRMWARE` | needs the grblhal-clearcore `haasSender` branch firmware |
| `HARDWARE` | needs hardware this machine does not have (encoder, ATC…) |
| `OK` | matches — noted only where the match is non-obvious |

Status column: `open` → `fixed` / `deferred` / `kept` as phases land.

## Summary — what matters most

**Safety-relevant, one-line fixes (do first):**
1. K1 — metric jog increments 100× too coarse (`main.js:20`).
2. K2 — rotary jog keys move A backwards vs their printed legend (`main.js:27`).
3. K5 — PC-keyboard arrows jog the machine unconditionally, even in EDIT.

**Systemic:**
4. C2/C4 — the simulator silently mis-executes what it doesn't implement
   (offset writes become rapids, G43.1 drives Z, canned cycles plunge once,
   M0/M6/M97 vanish, mid-line G91 doubles axes). The classroom seat is a
   materially different machine from the bench. Empirically verified §5.
5. C1 — `G04 P500` = 0.5 s on a HAAS, 8⅓ min here (integer-P = ms per manual).
6. W-cross — typed input falls through to the machine as g-code from panes
   where ENTER is never a machine command on a HAAS (W3/W5/W6 root cause).
7. W1/W2 — offset entry: HAAS ENTER **adds**, F1 replaces; replica replaces
   on ENTER and has no F1. A student's touch-off habit breaks on real iron.

**Firmware branch (in progress, flashed, bench-verify pending):** native tool
table + G43 H, O-words/expressions, M97; candidates added by this report:
HLFB axis-load meters (D-row), honest per-code error tables.

**Counts:** ~35 BUG, ~40 MISSING, ~20 DELIBERATE (kept), ~25 HARDWARE,
8 FIRMWARE rows across four clusters. Verified-correct areas are recorded at
the end of each section so they don't get re-litigated.

## Fixed on the `fidelity` branch, 2026-08-06 (tests 64/64 green)

- **K1** metric jog increments ×100 (`main.js`); **K2** rotary jog signs;
  **K5** PC-keyboard arrows now follow the cursor keys outside SETUP:JOG.
- **C2/C4** simulator overhauled to match the branch firmware: whole-block
  validation with the board's error numbers (20/21/28/36), G10 L2/L1, native
  G43 H + tool table + `[T:]`/`[OPT:…,32]`/`EXPR`, canned cycles G81/82/83
  (real pecks) + G73/85/86/89, M0/M1/M6 holds, `$B`/`$S`/`$O` + 0x88/0x89 +
  `Pn:` chars, real dwells, G92/G51/G28/G59.x, C4 target resolution fixed.
- **C1** G04 integer-P→seconds in the new shared `wireLine` transform, which
  MDI now also uses (closes the G43-bypass BUG); G31→G38.2, M16→M6,
  G154 P1-3→G59.x ride the same transform.
- **Subprograms**: `wireProgram` expands M97 (N-splice, L repeats, highlight
  follows the sub), M98/G65 (from control memory, pinned to the calling row),
  with honest WireError refusals (M99 loop, missing target, macro args,
  depth > 4); nothing after M30 streams.
- **Native run switches**: BLOCK DELETE/OPTION STOP drive `$B`/`$O`, lamps
  track `Pn:`, `M01` and `/` blocks ride the wire; `$O` synced at connect
  (firmware powers up with M1 live, a HAAS doesn't). SINGLE BLOCK deliberately
  still sender-side pending the bench judgement on `$S` feel.
- **Tool table**: capability-detected from `[OPT:]`; lengths write through via
  `G10 L1`; `[T:]` rows read back as truth; G43 H passes through natively.
- Small fixes: K3/W4 ERASE PROGRAM mode check (MDI clears MDI); W7 PART ZERO
  SET advances to the next axis; CANCEL deletes one char; SHIFT latch no
  longer leaks; 9-key `:` legend; RESET clears input; SPINDLE CW/CCW use the
  commanded S; AUX CLNT reason names TSC; HELP says G154 P99 and documents
  both tool-table paths; active program marked `A`; `WORK (G54)` label;
  PLAN.md stale counts + the $B/$S/$O box closed.

## Fixed in the second pass, 2026-08-07 (tests 70/70 green)

- **W-cross root cause**: WRITE/ENTER is a machine command ONLY in MDI; LIST
  takes `Onnnnn` (select **or create** — W5); EDIT and every other pane refuse
  with the buffer kept. **W1/W2**: offset entry ADDS on ENTER, **F1 replaces**
  (`offsetEntry`, both tables). **K4**: the handwheel gates on MODE — in SETUP
  it always jogs, even with the OFFSET grid up. **K3/W4** ERASE PROGRAM mode
  check. **POWER UP RESTART** wired ($H via the §3.1 sequence). **Dry run**
  substitutes every F with the jog-rate feed (T2.8 bottom legends); rapids stay
  rapids, disclosed. **D1** bottom band (input left / status center / alarm
  right / icons above), **D3** FEED+OVR into Main Spindle. Bench corrections:
  **G51 MACH3** translation in `wireLine` + sim; **G86 error:28** mirrored;
  `[T:]` zero rows no longer overwrite "never measured" (all-32-row report
  matched in the sim); streamer sends `$G` after an error halt to clear the
  firmware latch.

### §5 live results recorded (browser, sim seat)

- ENTER-adds verified on screen: entries 25 then +3 → the pane read the
  machine's `$#` back as **28.000** (work DRO −28.000).
- D1 and D3 confirmed rendered; mode bar `SETUP: JOG` + right-side display
  name confirmed; three-state power flow (off → dialog → live sim) confirmed.

## Overnight pass, 2026-08-07 (tests green)

- **HAAS-aware error explanations**: a rejected block now says what the
  student's code MEANS — "G12/G13 is circular pocket milling on a HAAS. No
  pocket cycle here — mill it with G2/G3 arcs" — in the MDI pin, the streamer
  halt and the alarm log. ~35 note families covering the manual's G/M tables;
  the table never invents a HAAS behaviour.
- **Dialect batch**: G44 H → negated G43.1 (own block); G110-G112 → G59.1-3;
  P-less G82/G86/G89 gain the HAAS default P0; the canned-cycle P is sticky
  across cycle changes until G0/G1/G80, per p.232; two-M-codes-in-a-block
  warns at CYCLE START (p.322 — runs anyway, grbl allows it); Setting 9 is
  persisted and re-commanded at connect, its power-up half. G52 gets an
  honest note (a stateless transform cannot express a delta shift).
- **Bench**: G43.2 additive TLO verified (−25.4 + −5 → −30.400); M6 always
  suspends into the Tool state on this build awaiting CYCLE START ($341=1
  needs a homed machine → error:46 on this bench); and the **"error latch"
  is resolved** — grblHAL's designed post-error sync hold at compat level 0,
  acknowledged by an empty line or $ command (the sender already complies;
  `grblhal-clearcore/docs/error-latch-repro.md` has the full story, and
  g28-false-alarm.md is thereby fully explained).

## Morning I/O pass, 2026-08-07 — CHIP and AUX CLNT are real now

The owner's question ("can the chip/CLNT keys get pins?") became a pin trade,
bench-verified end to end:

- **IO-0 freed** (debug console off) → it is the mist output again, and the
  **AUX CLNT key drives it as the TSC pump** via new firmware M-codes
  `M88`/`M89` riding the coolant mist channel — the lamp follows `A:M` in
  the status report, watched on the bench.
- **IO-5 freed** (probe moved to A-12; the hardware CYCLE START input it
  displaced was never wired — cycle start stays soft) → **CHIP FWD / CHIP
  STOP drive a conveyor relay** via new `M31`/`M33` (DRV8844 ch1, EN PB03 /
  IN PB12, coil from Vsupply to IO-5 per the hardware manual).
- CHIP REV stays faded with a new honest reason: single relay, no reverse.
- Key states: UNAVAILABLE 13→10, VERIFIED 112→115. Sim implements all four
  M-codes; the HAAS-notes table dropped its M31/M33 row and narrowed
  M80-M89 to M80-M87. Icon bar shows CHIP FWD and TSC.
- A first attempt registered IO-5 with the core ioports layer and it faulted
  driver_setup (board dead until reflash over the ICE); replaced with a
  two-line driver helper. ponytail: ioports return when a second aux pin exists.

**Still open (biggest first):** Run-Stop-Jog-Continue; the MISSING backlog
(G70-72 bolt patterns, M48 pre-flight, M76/M77, instructor-lockout settings
group, timers pane Remaining/M30 #2, beacon states); Web Serial bench test
(the ClearCore USB is plugged in — needs a human click on the port picker);
one foreground glance at the wheel-jog and run-screen renders (throttled-tab
blocked); whether to send upstream a DOCS note about the compat-0 post-error
sync hold (owner's call). $341 manual tool-change modes stay untestable until
limit switches exist. Deliberate sim divergence, kept: the sim does not
replicate the post-error sync hold — the sender always syncs, and a held
parser would teach nothing.

---

## OPERATION:MEM row verified end to end, 2026-08-07 (tests 80/80 green)

All five keys of the MEM row (T2.6 p.38) driven against the sim seat with a
program carrying a `/` block, an `M01`, an `M3 S1000` and a `G1 F500`:

- **MEMORY** — mode bar `OPERATION: MEM`.
- **SINGLE BLOCK** — one block per CYCLE START, watched stepping `G21 G90`,
  `M3 S1000` (RPM 1000 FWD) and `G0 X10` (X→10.000) one press at a time.
- **DRY RUN** — `M3` stripped so the spindle never started (RPM 0, DIR —) and
  every `F` substituted with the jog-rate feed: `F500` reached the machine as
  `F25.4` (T2.8 bottom legend, MM index 1), confirmed in the modal string.
- **OPTION STOP** — toggled mid-job (realtime `0x88`), machine went `Hold:0`
  at the `M01`, CYCLE START resumed it.
- **BLOCK DELETE** — `BLK DEL` lamp from the `Pn:` report, `/G0 X20` greyed in
  both listings **and skipped at the machine**: X stayed 10.000 across it.

**One real bug found and fixed.** Turning SINGLE BLOCK *off* mid-program
stalled the job permanently: `pump()` runs only from `start()`, `release()` and
an incoming `ok`, and in single block the last `ok` has already arrived, so
clearing the switch left the remaining blocks unsent with the machine idle and
CYCLE START answering "already running" forever. `Streamer.setSingleBlock()`
now owns the invariant and both call sites go through it; a regression test
fails without the pump. Pre-existing — it is not in the MDI change below.

## MDI pass, 2026-08-07 — W3/W4/W6 closed (tests 79/79 green)

MDI was a command line: ENTER sent the typed text to the machine and kept a
12-entry scrolling history. §4.2.3 p.114 describes something else entirely —
a **program page**. "Your input stays on the MDI input page until you delete
it", and [CYCLE START] is what executes it. T2.4 gives [ENTER] one job,
"answers prompts and writes input"; it is not a run key anywhere on the panel.

- The page is now a program in the same shape as the selected one, so the
  editor and CYCLE START each point at one of two things instead of the MDI
  page having its own half-built copy of both. §4.2.1 step 1 is explicit that
  EDIT:EDIT and EDIT:MDI are the same editor.
- **WRITE/ENTER writes the block onto the page**; nothing goes to the machine.
- **CYCLE START runs the page** — same `wireProgram`, same run switches, same
  streamer, same running-block mark. The mode bar stays `EDIT: MDI` through the
  cycle and the blocks stay in front of the operator who typed them.
- **ERASE PROGRAM clears the page** (was already fixed; the row was stale).
- **HOME → `Onnnnn` → ALTER files the page in control memory and clears it**
  (§4.2.3 step 3). It refuses to overwrite an existing O-number, and it does
  not jump to LIST — the manual tells the operator to press [LIST PROGRAM] to
  find it, which means the control stayed where it was.
- The editor keys reach the page: cursor by word, INSERT / ALTER / DELETE /
  UNDO, HOME and END. Edits are refused while the page is the running program.
- An MDI cycle no longer counts as a part — that pane is labelled M30 CNT.
- Errors still pin to the block that caused them, now via the streamer's
  `rows` map, so the HAAS note comes with them.
- Fixed alongside: a cycle stopped by a rejected block left the THIS timer
  counting forever (nothing cleared `cycleStartedAt` once the job was gone).

**Two deliberate divergences, both said on the HELP page.** A `$` command is
not a program block: it is grbl's own control language, it has no HAAS
equivalent, and `$X` has to reach a machine sitting in alarm — which is exactly
when CYCLE START refuses. So `$…` + WRITE/ENTER goes straight out. And the `;`
key is comment-to-end-of-line here, not the HAAS end-of-block, so one line is
one block.

**Not done:** the second press of [MDI/DNC] selecting DNC (T2.7, Setting 55).
The card page already *is* DNC on this control — RECEIVE opens it and CYCLE
START there hands the file to the board — so the key's second function would be
a shortcut to a page that already exists. Add it if the shortcut is wanted.

Verified in the browser on the sim seat: two blocks typed and held on the page
with nothing sent, CYCLE START moving X to 10.000 with M30 CNT still 0, `G12`
coming back pinned to its block with the pocket-milling note, HOME+`O10`+ALTER
filing `O00010` and clearing the page, and `$G` reporting that it went straight
to the machine.

## 1. Operator workflows (§3.1, §3.3, §3.12–3.15, §4.2.1, §4.2.3, §4.7)

### Top findings — mis-teach or surprise a student

| # | cite | manual says | replica does | class | status |
|---|---|---|---|---|---|
| W1 | §3.12 p.104 | Value + ENTER **adds to** the cell; **F1 replaces** | ENTER replaces (`commitInput` → `setWorkOffset`, `main.js:806`, `grbl.js:126`); same on tool page | BUG | open |
| W2 | §3.12 p.104 | F1 is the replace key | F1 unimplemented (`keys.js:211` absent) | MISSING | open |
| W3 | §4.2.3 p.114 | In MDI, CYCLE START executes the MDI blocks | Fixed: the MDI page is a program buffer and CYCLE START runs it through the same wire, switches and streamer (`cycleStart`) | BUG | **fixed** |
| W4 | §4.2.3 p.114 | ERASE PROGRAM clears the MDI page | Fixed: from MDI the key clears the page and never reaches the directory (`eraseProgram`) | BUG | **fixed** |
| W5 | §4.1 p.111, §3.3.2 p.77 | Type `Onnnnn` + SELECT PROGRAM selects **or creates** it | Typed O-number ignored; ENTER on LIST pane falls through and is **sent to the machine as g-code** (`main.js:751-757`, `:823-830`); no create-from-pendant | BUG + MISSING | open |
| W6 | §4.2.1 p.112 | ENTER is not a machine command in EDIT; MDI window is editable | Fixed: ENTER never reaches the machine as g-code, and the cursor keys + INSERT/ALTER/DELETE/UNDO work on the MDI window (`editing()` covers both windows) | BUG + MISSING | **fixed** |
| W7 | §3.12.2 F3.11 p.105 | PART ZERO SET advances to the next axis column after each press | Writes the highlighted cell and stays (`partZeroSet main.js:423-427`); taught procedure sets X twice, never Y | BUG | open |

### Remaining workflow findings

| cite | manual says | replica does | class | status |
|---|---|---|---|---|
| §3.1 p.75 | Power-on lands in SETUP:ZERO with alarms until RESET | Lands in SETUP:JOG, no start-up alarm state (`main.js:43`, `:291-294`) | BUG (small) | open |
| §3.1 p.75 | RESET clears each alarm | RESET is 0x18; grbl needs `$X`; local `s.alarm=null` blinks the banner off until next report re-raises (`main.js:253-264`, `:1208`) | FIRMWARE/BUG | open |
| §3.1 p.75 | POWER UP/RESTART homes the machine | Key unimplemented; homing only via ZERO RETURN→ALL | MISSING | open |
| §3.13 p.107 | Dry run: rapids AND feeds run at the **jog-speed-button** rate; spindle runs; tool changes execute | Only strips M3/M4/M7/M8; no feed substitution (`grbl.js:436`) | MISSING + DELIBERATE (spindle strip kept — safety; disclose on HELP) | open |
| §3.13 p.107 | Dry run toggles only when a program has finished / after RESET | Toggles any time, applied at next CYCLE START | DELIBERATE (minor) | kept |
| §3.15 p.108 | Run-Stop-Jog-Continue: hold → jog away → return → resume | Absent; `jogAxis` would also `$J=` into a machine in Hold, which grbl rejects (`main.js:871`) | MISSING | open |
| §3.12.1 p.104 | Jog keys **held** = continuous jog | One increment per press; continuous only behind JOG LOCK (`main.js:877-892`) | MISSING | open |
| §3.12.3 F3.12 p.106 | PAGE UP reaches the tool Coolant/Length/Radius page; Geometry columns | PAGE UP moves cursor 10 rows; single LENGTH column (`main.js:156-159`, `screen.js:142-156`) | BUG (nav) + DELIBERATE (columns) | open |
| §4.2.1 p.112 | F2 highlights a block / range | No F2; word cursor only | MISSING | open |
| §4.2.1 p.113 | UNDO reverses last 9 changes | 50-deep stack | DELIBERATE (better) | kept |
| §3.3.4 p.79 | ERASE PROGRAM prompts Y/N; active program cannot be deleted | Deletes immediately, including the selected one (unloads it) | BUG | open |
| §3.3.2 p.78 | Type program number + UP/DOWN switches programs in MEM | Not wired | MISSING | open |
| §3.3.3/3.3.6/3.3.7 p.78-80 | F2 copy/duplicate, ALTER renames | None of the F2/ALTER file operations | MISSING / DELIBERATE | open |
| §3.3 p.76 | Device manager: tabbed MEMORY/USB/… with sizes, dates | Two pages: control memory + machine SD card | DELIBERATE | kept |
| §3.3.2 p.78 | Active program marked `A` | Marked `*` (`screen.js:303`) | DELIBERATE (cosmetic) | open (cheap fix) |
| §3.14 p.107 | Load, set offsets, CYCLE START | Works; warns on unmeasured `H` — a genuine improvement | OK | — |
| §4.7.1 p.146 | `G43 Hnn` with H = T per Setting 15; Alarm 332 on mismatch | H row *is* the T number by construction; no mismatch alarm | OK (+minor MISSING) | — |
| §4.7.2 p.146 | G54-59, G110-129, G154 P1-99 | G54-59 + G154 P1-P3 (=G59.1-.3); disclosed on HELP | DELIBERATE + FIRMWARE (see §4) | open |
| §3.12.3 F3.12 p.106 | Tool length = machine Z at touch-off | Stores raw `mpos[2]` — exactly what G43.1 wants | OK (non-obvious) | — |

### Cross-cutting workflow issue

**The input bar falls through to the machine.** W3/W5/W6 share one root cause:
`commitInput` (`main.js:823-830`) treats "not a data-entry pane" as "send it as
g-code". On a HAAS, ENTER is never a machine command outside MDI. Fix once in
the dispatch, not per-pane.

---

## 2. Keyboard (§2.3.1–2.3.3, F2.26, T2.1, T2.5–T2.10)

Method note: F2.26 is vector art; the tiny yellow legends were read from a
400 dpi render (`pdftoppm`), which settled the rotary-key legends, the 9 key's
shifted character, and the 2 key's apostrophe.

### Top findings

| # | cite | manual says | replica does | class | status |
|---|---|---|---|---|---|
| K1 | p.39 T2.8 | Metric increments are the first legend ×10: **.001/.01/.1/1. mm** ("`.0001` becomes 0.001 mm") | `INCREMENTS.MM = [0.1, 1, 10, 100]` — **100× too coarse at every position** (`main.js:20`; the misreading is documented in its own comment) | BUG (safety) | open |
| K2 | p.35 F2.26, p.42 | Rotary jog: key printed **−A/C** jogs A negative, **+A/C** positive | Both signs inverted — `jog-b-plus` (reads −A/C) → `[3,+1]`, `jog-a-plus` (reads +A/C) → `[3,−1]` (`main.js:27`) | BUG (safety) | open |
| K3 | p.40 T2.10 | ERASE PROGRAM: deletes selected program in LIST mode, **clears the MDI page in MDI mode** | No mode check — in MDI it deletes the highlighted directory program (`main.js:759-773`) (= W4) | BUG | open |
| K4 | p.32 T2.1 | HANDLE JOG wheel jogs axes in HANDLE JOG **mode**; scrolls while **editing** | Gates on pane, not mode (`hasCursor()` includes 'offset') — in SETUP:JOG with OFFSET up, the wheel scrolls the grid instead of jogging, breaking the canonical touch-off workflow | BUG | open |
| K5 | not in manual | — | Physical PC-keyboard arrows/PageUp/Dn jog X/Y/Z **unconditionally** (`main.js:1365-1373`) — ArrowDown in EDIT jogs the machine | BUG (safety) | open |

### Remaining keyboard findings

| cite | manual says | replica does | class | status |
|---|---|---|---|---|
| p.39 T2.8 | Bottom legend row = dry-run jog rates | Never used | MISSING | open |
| p.39 T2.9 | SINGLE: press the **axis letter first**, then SINGLE | Inverted — SINGLE prompts for the letter; typed-letter-first leaves it in the input bar | BUG | open |
| p.39 T2.9 | ORIGIN zeroes **whatever is selected** on the active page | Always zeroes the OPERATOR readout regardless of pane (`main.js:339-344`) | BUG | open |
| p.41 | CANCEL deletes the **last character** | Clears the whole input buffer (`main.js:346-350`) | BUG | open |
| p.41 | SHIFT+letter = lowercase | SHIFT+A returns 'A' and the shift latch **leaks** to the next key (SHIFT,A,5 types "A$") (`main.js:378-389`) | BUG | open |
| p.35 F2.26 | The 9 key's yellow legend is `:` | Has `°` (`keys.js:158`) | BUG | open |
| p.35 | RESET clears alarms, **input text**, overrides | Never clears `s.input`; override reset unverified (grbl soft-reset may cover it) | BUG + FIRMWARE | open |
| p.43 | SPINDLE CW/CCW start the spindle at the commanded speed | Hardcodes `M3 S1000`/`M4 S1000`, overwriting the student's S (`main.js:266-268`) | BUG | open |
| p.42 | AUX CLNT = Through-Spindle Coolant | Faded key's message gives the P-Cool reason, not the TSC one (`keys.js:340`) | BUG (wording) | open |
| p.32 T2.1 | Wheel clockwise scrolls forward | `dir > 0 → press('up')` — likely inverted (`main.js:931`) | BUG | live-check |
| p.36 | TOOL OFFSET MEASURE — no page precondition; records for the active tool | Works only on the tool pane; writes to the **cursor row**, not the active tool | BUG (minor) | open |
| p.35 | POWER UP RESTART homes and initializes | Unwired (= W-row) | MISSING | open |
| p.36 | F1–F4 mode-dependent functions | Unwired | MISSING | open |
| p.37 | Repeat-press display keys show additional screens (CURRENT COMMANDS, ALARMS/messages, SETTING/GRAPHIC) | Only OFFSET cycles on repeat press | MISSING | open |
| p.43 | Settings 19/20/21 can disable override keys | No settings to do so (see §4 settings block) | MISSING | open |
| p.38 T2.5 | INSERT from input line **or clipboard**; DELETE a **selected block** | Input line/word only; no block selection (F2) | MISSING | open |
| p.39 T2.7 | Second MDI/DNC press selects DNC drip-feed | Second press re-applies MDI; DNC lives on the SD page via CYCLE START (run-from-card — right call for grblHAL, key interaction absent) | MISSING/DELIBERATE | open |
| p.40 T2.9 | HOME G28 homes a single typed axis too | Bare `G28` always; typed axis ignored (`main.js:330-332`) | MISSING | open |
| p.33-34 T2.2-T2.4 | Right-side panel (USB, lock keyswitches, Second Home, worklight), **beacon light**, beeper | Absent. Beacon is the cheap high-value one — five states map onto Idle/Run/Hold/Alarm | MISSING/HARDWARE | open |
| p.42 | Hold an axis key to jog continuously | pointerdown-only; one increment per press (= W-row continuous jog) | MISSING | open |
| p.42 | B axis via SHIFT+rotary | Not in SHIFTED (wedge legends); board has no B anyway `[AXS:4:XYZA]` | DELIBERATE | kept |
| p.38 T2.5 | UNDO last **9** | 50 kept | DELIBERATE (better) | kept |
| p.32 T2.1 | E-STOP kills servos/spindle/changer | 0x18 + honest "not a hardware E-stop" label | HARDWARE | kept |

Verified-correct worth recording (non-obvious): mode-bar strings match T2.11
exactly, incl. `EDIT: MDI`; all six feed/spindle override bytes; handle-control
1%-per-detent (0x93/0x94, 0x9C/0x9D), deliberately unscaled by increment keys;
+X carries the manual's left-arrow table-motion convention and X/Y/Z jog signs
are correct (only the rotary pair is inverted); F2.26's eight-group grid and
all shifted legends except the 9 key; JOG LOCK exactly per manual; FEED
HOLD/CYCLE START ordering catches M01 holds; PARAMETER page correctly refuses
typed values.

---

## 3. Control display (§2.3.4, F2.27–F2.34, T2.11–T2.31)

Scope corrections established during validation: T2.14–T2.31 are the
**Icon Bar's eighteen field tables**, not program-display fields — §2.3.4 gives
no field-level spec for the program pane. And the "13 display pages" claim is a
**documentation bug**: `screen.js:10` correctly says thirteen *panes* (all 13
verified against F2.27); README.md:21 and PLAN.md:31/:57/:377 conflate that
with main-display *pages* (10 activePane values / 12 titles).

### Top findings — data already held, placed wrong

| # | cite | manual says | replica does | class | status |
|---|---|---|---|---|---|
| D1 | p.51, p.53 | Bottom band: **input bar bottom-left**, status bar bottom-center | Icon bar sits in the input bar's corner; status/alarm one row high (`haas.css:489-490`) | BUG | open |
| D2 | p.46 | EDIT mode shows **two program panes with different content** | Panes 2 and 3 render byte-identical `programBody` whenever `activePane==='program'` — all of EDIT and every running program (`screen.js:449,460`) | BUG | open |
| D3 | p.64 F2.34 | Overrides belong to the **Main Spindle** pane | Rendered in TIMERS (`screen.js:480`); F<feed> also sits in the status bar instead of Main Spindle | BUG (wrong pane) | open |

### Remaining display findings

| cite | manual says | replica does | class | status |
|---|---|---|---|---|
| p.46 T2.11 | Six bar strings only | `OPERATION: DNC` invented (`main.js:696`) — honest, but not a T2.11 string | BUG (minor) | open |
| p.46 F2.28 | Right side of bar = the display function's **name** | Raw `activePane.toUpperCase()` → `PARAM`, `CURRENT` | BUG (format) | open |
| p.47 F2.29 | Active Codes pane shows a **decoded table** + `Dnn Hnn Mnn Tnn` column | Raw `$G` string on one line; the decode exists but only on CURRENT COMMANDS (`screen.js:451` vs `:217-228`) | MISSING | open |
| p.47 T2.12 | "Program Tool Offsets" / "Work Offsets" titles | `TOOL OFFSET` / `WORK OFFSET` | BUG (wording) | open |
| p.48 F2.30 | Active Tool: type, max load, % life | `T##` + OFFSET only; load/life have no data source here | MISSING + HARDWARE | open |
| p.48 | Coolant pane = tank **level gauge**, flashing when low | Pump ON/OFF state (which belongs to icon field 18) | HARDWARE (no sensor) | kept |
| p.48-50 | Timers: This/Last/**Remaining**, **two** M30 counters, Loops Remaining; cursor+ORIGIN resets | THIS/LAST + single parts counter; pane never active so the reset procedure has nowhere to run (`screen.js:476-479`) | MISSING | open |
| p.51 T2.13 | `WORK (G54)` label; `POSITION: OPERATOR` title format; POSITION key **cycles** reference points in other modes; `(IN)` units header | `WORK G54`, `POSITION G54`, no cycling, no units header | BUG (format) + MISSING | open |
| p.52 F2.31-32 | F2 axis-selection pop-up with check marks | Absent | MISSING | open |
| p.45/p.53 F2.33 | Per-axis **LOAD %** meters (pane 10 alternate) | Absent — but obtainable: ClearPath-SD servos expose torque via HLFB (bipolar-PWM mode), pins already wired (grblhal PLAN.md:47, RESOURCES.md:33); needs firmware plumbing into the status report | FIRMWARE (was HARDWARE) | open |
| p.53 | Icon bar = 18 image fields | One text flag string; JOG LOCK/SINGLE BLK/DRY RUN/OPT STOP/BLOCK DELETE present, 13 other fields absent; INC/HANDLE/SHIFT flags added | DELIBERATE + MISSING | open |
| p.64-65 F2.34 | Spindle pane: programmed **and** actual speed/feed, surface speed, chip load, load kW + bar, gear | RPM + DIR only. Half the fields are computable from held state; load/gear are HARDWARE | MISSING + HARDWARE | open |
| p.45 | Pane 13 alternates Spindle/**Editor Help**; pane 7 alternates Timers/**Tool Management**; pane 10 alternates Position/**Load Meters**/**Clipboard** | Single-purpose panes | MISSING | open |

Verified correct (don't re-litigate): all 13 F2.27 panes exist with correct
upper-grid geometry; T2.11's six strings exact; T2.13's four reference points
all present; OFFSET two-table toggle per spec.

---

## 4. Programming surface (§6.2 G-codes, §6.3 M-codes, §6.4 settings)

### Two headline findings

**C1 — G04 dwell is silently 1000× wrong.** Manual p.244-245: *"`G04 P10.` is a
dwell of 10 seconds; `G04 P10` is a dwell of 10 milliseconds"* — integer P is
**milliseconds**. grblHAL's P is always seconds. `G04 P500` = 0.5 s on a HAAS,
**8⅓ minutes** on this stack, no error either way. Fix: sender translates
integer-P G04 (÷1000, emit decimal). G04 **only** — canned-cycle P is stated
per-cycle ("in seconds" for G73/G83) and every manual example writes it with a
decimal; do not divide there. Sim must also actually dwell (today G4 is
instantaneous). CLASS: BUG. status: open.

**C2 — the simulator's swallow-everything default makes it actively
misleading.** `sim.gcode` (`sim.js:199-277`) knows G0/G1/G4/G20/G21/G90/G91/
G54-59, M2/M3/M4/M5/M8/M9/M30; everything else falls through — and because
unrecognized letters are read as axis words, the failure is not "nothing" but
"a different plausible thing":
- `G10 L2 P1 X-250` → **rapids to X-250** instead of writing the offset (the pendant's own offset writes!)
- `G43.1 Z-50` (the sender's own G43 translation) → **rapids Z to −50**
- `G81 Z-1.5 R0.1 F15.` → one plunge, no cycle; `G02 I3. J4.` (full circle) → nothing at all; `G28 G91 Z0` → nothing **and G91 stays latched**
- `M00`/`M01`/`M06` → no hold, no pause
Fix direction: sim rejects what it cannot execute (`error:20` — honest text
already exists in `ERRORS`) and implements the subset the board supports.
CLASS: BUG (systemic). status: open.

### G-code dispositions (vs manual table p.225-230)

Native already (board): G0/G1/G2/G3, G17-19, G20/21, G28/G30, G40 (no-op
cancel), G43.1/G49, G53, G54-59+G59.1-3, G61 (no-op), G73, G80-G83, G85, G86,
G89, G90/91, G92, G93/94, G98/99 — the sim must catch up on most (C2).

| codes | disposition | class |
|---|---|---|
| G04 | sender translates integer-P (C1) | BUG → fix |
| G09, G12/G13, G60, G76, G100/G101, G103, G150 | honest error with a HAAS-aware message ("G12 is Circular Pocket Milling on a HAAS — this control has no pocket cycle; mill it with G2/G3") | MISSING |
| G31 | sender rewrites → `G38.2` | MISSING → fix |
| G41/G42 cutter comp | honest error; **the largest genuine teaching gap** — nearly every manual example uses `G41 … D01` | MISSING (doc) |
| G43 `H<n>` | native on branch firmware (N_TOOLS); sender rewrite kept as stock fallback; **sim must stop rapiding Z** (C2) | FIRMWARE |
| G44 | error (or negate → G43.1 if wanted) | MISSING |
| G50/G51 scaling | **bench-corrected: MACH3-style** (`MACH3_SCALING`, gcode.c:50 — the earlier "word sets match" note read the `#else` branch). Axis words ARE the factors, about work zero: `G51 X2` doubled a `G0 X10` to MPos 20.000. HAAS centre+P form → error:36 (and a FAILED G51 can still leave `Sc:` set — send G50 after). Sender translates pure `G51 P<f>` → `G51 X<f> Y<f> Z<f>`; sim matches | BUG → fixed (sender+sim) |
| G52 | sender → `G92` (or `G10 L2 P0`) | MISSING |
| G64 | **accept as no-op to match G61** — today G61 is accepted and its documented cancel errors; a student writing the pair gets silence then error:20 | BUG (inconsistency) |
| G65/M98/M99 | see subprograms below | FIRMWARE/MISSING |
| G68/G69 | deferred (owner decision; core-parser edit) | FIRMWARE (deferred) |
| G70/G71/G72 bolt patterns | **sender-expands** into G81/G73 blocks — pure geometry over cycles the board already runs; no firmware needed | MISSING → fix |
| G74, G84, G174/G184 rigid tap | spindle encoder | HARDWARE |
| G87/G88 manual-retract bores | operator-retract semantics | HARDWARE |
| G110-G129 | first three → G59.1-3, honest error beyond | MISSING |
| G154 P1-P99 | P1-P3 → G59.1-3 **on the wire** (mapping documented in `grbl.js:485-487` but not implemented outbound); honest error P4+ | MISSING → fix |
| G35-37, G47, G102, G107, G136, G141/G143, G153/155/161-169, G187, G188 | HARDWARE/5-axis/probe — document | HARDWARE |
| G29, G77, G102, G107, G153-169, G174/184, G188 | **source-derived: no parse case in the very gcode.c the flashed binary was built from → error:20 guaranteed** | HARDWARE/MISSING (source-derived) |
| G95 | parses (`gcode.c:1609`) but validation requires a spindle encoder → error on this board; the `MODAL` row in `grbl.js:497` is defensible (other grblHAL boards report it) | HARDWARE (source-derived) |
| G187 | parse case exists but only under `ENABLE_ACCELERATION_PROFILES` (off) → error:20 on this build; could be enabled as a flag if smoothness-level teaching is ever wanted | FIRMWARE (flag) |

Canned-cycle semantics to encode (p.231-235): Z/R/F required; cycle repeats at
**every X-Y block** until canceled; `L0` = define-without-executing (obstacle
idiom); `G91 … L<n>` loop-drills; R/Z sticky mid-pattern; XY positioning is
**rapid**; G00/G01 also cancel; G98/G99 switchable mid-pattern; **P sticky
across blocks** and cleared by G00/G01/G80/RESET (p.232).

### M-code dispositions (vs manual table p.319-322)

| codes | disposition | class |
|---|---|---|
| M00/M01 | native on board; **sim never holds** (C2) | BUG (sim) |
| M02/M30, M03/M04/M05, M08/M09 | native everywhere | OK |
| M06 | native ($341); sim must pause/change | BUG (sim) |
| M07 | HAAS **shower** coolant vs grbl M7 mist — works, label it the HAAS way; sim lacks the g-code path entirely | BUG (sim+wording) |
| M16 | sender alias → M06 (manual lists it as a synonym) | MISSING → fix |
| **M97** | firmware branch (implemented, bench pending); sim needs it; **manual states NO nesting limit — plugin has depth 8; error text must say so** | FIRMWARE |
| **M98/M99** | **architectural finding: board-side M98 resolves against SD files, but student programs live in the browser** — M98 can never resolve for streamed jobs regardless of firmware. Sender must inline-expand (M97 splice, M98 from control memory, HAAS M99-P placement — return target on the line after the M98 in the CALLER, not Fanuc-style in the sub). `M99` alone in a main program = loop to top until RESET. Setting 118 ties M99 to the M30 counters | MISSING → fix |
| M48 | **sender-side pre-flight check** — the sender already parses the whole program; a real "check validity" is implementable client-side and worth teaching | MISSING (nice) |
| M76/M77 display inactive/active | the replica owns the display — trivially implementable here | MISSING (cheap) |
| M95 sleep | quirk: duration lives **in a comment** `M95 (hh:mm)`; `stripComments` destroys it before anything could read it | HARDWARE (note) |
| M109 | needs macro vars + UI | FIRMWARE (later) |
| M10-13, M17-28, M31-46, M49-69, M75, M78-89, M96 | machine hardware (brakes, pallets, relays, TSC, gearbox, probe I/O) | HARDWARE |

**Block-format rule unenforced (C3):** manual p.230/322 — *"only one M-code
per block"*. grbl accepts `M3 M8`; a HAAS rejects it. Sender-side warning
wanted so the replica doesn't teach an illegal habit. Also: M-codes take
effect at end of block (sim already defers — correct).

### Settings for a student-facing replica (T6.2 p.337-340)

The **instructor-lockout group** is implementable entirely sender-side:
16 Dry Run Lock Out, 17 Opt Stop Lock Out, 18 Block Delete Lock Out,
19/20/21 feed/spindle/rapid override locks, 53 Jog w/o Zero Return (auto-OFF
at power-up — the teaching point), 163 Disable .1 Jog Rate.

Also relevant: 9 Dimensioning (exists; drives power-up G20/G21 + offset
conversion-on-change, program NOT translated), 31 Reset Program Pointer,
36 Program Restart (the honest "start from cursor" — scans M08/M09/M41/M42/
M51-58/M61-68), 83 M30 Resets Overrides / 88 Reset Resets Overrides (sender
owns overrides — cheap), 103 CYC START/FH Same Key ↔ 104 Jog Handle to SNGL
BLK (mutually exclusive dead-man modes), 118 M99 Bumps M30 CNTRS, 55 Enable
DNC from MDI.

---

## 5. Live-check results

Browser pass list (sim mode, foregrounded tab):
- §2: wheel scroll direction; handwheel-vs-offset-grid gating (K4); PC-keyboard
  jog in EDIT (K5); TOOL OFFSET MEASURE cursor-row target; mode-bar per-pane.
- §3: D1 bottom-band layout (figure leader lines arguable — confirm on screen);
  D2 duplicated program panes showing identical text; D3 where OVR/F render;
  right-hand mode-bar string per pane; Active Codes rendering; `WORK G54` /
  `POSITION G54` strings + POSITION cycling; icon-bar flag string; exactly one
  white active pane.
- §1: jogAxis `$J=` into a machine in Hold (grbl rejects).

Browser pass results (2026-08-07, sim seat, element-dispatched keys):
- **W1 ENTER-adds**: entries 25 then +3 read back from `$#` as 28.000 ✓
- **W2/F1-replace**: F1 on the 28.000 cell with "2" typed → "G54 X set to
  2.0000" ✓
- **W5**: typed `O99321` + ENTER on LIST created `(new)`, marked `A`,
  selected ✓; an existing number selects instead ✓
- **K3/W4**: ERASE PROGRAM in MDI → "MDI cleared", directory untouched ✓
- **D1/D3**: bottom band and MAIN SPINDLE placement confirmed rendered ✓
- K4 wheel-jog-in-SETUP and the D2 run-screen render: code-verified
  (one-line gates); live observation blocked by background-tab timer
  throttling (the repo's documented Chrome trap) — first foreground use
  will show them.
- Cross-environment fixture: sim and `$F=` DNC legs both end at
  [10.000, 2.000, −15.400] ✓ (see §6 addendum).
- Stock regression (main firmware flashed): `[OPT:…,4,0]`, no EXPR, G43 H1
  → error:20, and the sender's fallback `G43.1 Z-25.4` → `[TLO:−25.400]` ✓;
  branch firmware restored and re-seeded afterwards.

### Headless sim verification (empirical, Node — same code a classroom seat runs)

Script: drives `VirtualGrbl` directly (`write`/`tick`/`drain`), 2026-08-06.

| claim | result |
|---|---|
| `G10 L2 P1 X-250` rapids to X−250, offset unwritten | **CONFIRMED** |
| `G43.1 Z-50` rapids Z to −50, TLO stays zero | **CONFIRMED** |
| `G81 Z-1.5 R0.1 F15` = single plunge, no cycle | **CONFIRMED** |
| `M0` never holds | **CONFIRMED** |
| `T2 M6` swallowed, state stays Idle | **CONFIRMED** |
| `G2 I3 J4` (full circle) does nothing | **CONFIRMED** |
| `G4 P2` dwell instantaneous | **CONFIRMED** |
| `M97 P100` swallowed with no error | **CONFIRMED** |
| `G28 G91 Z0` is a silent no-op | **REFUTED — it is worse** (C4 below) |

**C4 — mid-line `G91` corrupts every axis the block does not mention.**
`gcode()` seeds `target` from the planned endpoint under the **line-start**
distance mode, then applies it under the **line-end** mode (`sim.js:204` vs
`:259`). A block that switches to G91 and moves fewer than all axes therefore
re-adds the current position of the unmentioned axes:
- measured: at [3,7], `G91 G0 X5` → **[8,14]** (correct: [8,7]) — Y doubled;
- measured: at [10,0], `G28 G91 Z0` → **[20,0]** — the manual's canonical
  program ending doubles X/Y instead of returning to machine zero.
CLASS: BUG (sim, safety-relevant for training). status: open.

---

## 6. Firmware branch status (grblhal-clearcore `haasSender`)

Done and flashed to the bench board via SWD (2026-08-06):

- `N_TOOLS 32` — NVS tool table: native `G43 H`, `G43.2`, `G10 L1/L10/L11`,
  `[T:]` rows in `$#`, tool count as the trailing field of `[OPT:]`.
  NVS arithmetic: GRBL_NVS_SIZE = 1024 + 32×26 = 1856 of 4096 — fits.
- `NGC_EXPRESSIONS_ENABLE 1` — O-words (sub/if/while/repeat), `[expr]`,
  `#`-params, SD ATC macro layer. `EXPR` appears in `$I` NEWOPT.
- `src/haas_plugin.c` — **M97 P<n> [L<m>]** for board-read jobs (SD `$F=`);
  errors honestly (error 20) in streamed context. `[PLUGIN:HAAS parity]` in `$I`.
- Flash 357,524 B (70.4%), +15 KB over main. Baseline NVS block backed up
  byte-exact (`debug/backups/nvs-8k-pre-haasSender.bin`).
- First contact after flash: `$I` shows `[OPT:…,4,32]`, `EXPR`+`TC` in NEWOPT,
  `[PLUGIN:HAAS parity v0.1]`; settings at defaults (predicted NVS wipe).
  `G0 X54`→54.000, `G55`/`G90`/`G17`/`G10 L2` all ack — parser healthy.
- **Bench verification COMPLETE (2026-08-07, exclusive access).** Verified on
  the wire: tool table write + power-cycle persistence; native G43 H (TLO
  −25.400 applied and cleared); T1 M6; **M97 P100 L2 ran its N-sub exactly
  twice from `$F=`** (the plugin works); G65/M98 SD macros; o-word flow
  control; canned cycles G73/81/82/83/85/89 with G98/G99 returns; `$O`
  inversion + `Pn:T` + 0x88; `$S` hold-after-every-block + `Pn:Q` + 0x89;
  `$B` slash-skip + `Pn:L`. Corrections: **G51 is MACH3-style** (see the
  G-code table), **G86 answers error:28** (missing word TBD; sim mirrors).
  Full transcript-backed notes: `grblhal-clearcore/docs/HAASSENDER-BENCH.md`.
- **Major find — a pre-existing firmware error latch, NOT from this branch:**
  after one ok'd block, a single errored block makes every later g-code line
  repeat that error until any `$`-command clears it. Bisected across four
  builds down to main-equivalent — it ships in main today, masked because the
  sender sends `$G` after every manual command. Almost certainly the real
  mechanism behind `history/g28-false-alarm.md`. The streamer now sends `$G`
  when a job halts on an error, so the next CYCLE START is never poisoned.
  Root cause in core still open; candidate for an upstream grblHAL issue.
- Two-client interleaving invalidates bench results silently (the first sweep's
  false error:20s). Passively listen for unrequested status traffic before
  trusting any board response.

Deferred: G68/G69 (core-parser edit → submodule fork; owner deferred),
M19/G84/G33/G76/G95 (spindle encoder — pin conflict with limits), parts
counter firmware-side (sender-side instead).
