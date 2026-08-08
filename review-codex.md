# Independent critical review: `haasSender` and `grblhal-clearcore`

Date: 2026-08-07  
Reviewer: Codex (independent pass)  
Sender revision: `ff5f5f6` (`main`)  
Firmware revision: `1c3b89f` (`haasSender`)  
Primary reference: *Haas Mill Operator's Manual, 2014*, document 96-8200, in `reference/english---mill-operator's-manual---2014.pdf`

## Executive conclusion

`haasSender` is a strong visual facsimile and a capable grblHAL sender, but it is **not yet accurate enough to be presented to students as a behavioral replica of the 2014 Haas mill control**. It is suitable now for supervised pendant-layout familiarization, basic coordinate/offset exercises, program selection, elementary MDI, and selected run controls—provided an instructor explicitly teaches the differences. It is not ready for unsupervised student operation of a moving mechanical stage as a Haas-equivalent trainer.

The most serious issues are not cosmetic:

1. The available ClearCore has homing, hard limits, and soft limits disabled (`$22=0`, `$21=0`, `$20=0`), and servo-fault monitoring is compiled out. The on-screen E-stop and power buttons do not provide the physical functions their Haas counterparts provide.
2. Haas `G28` means return to machine zero and cancels tool-length compensation. grblHAL `G28` means move to a mutable stored position set by `G28.1`. `HOME G28` sends the grblHAL command unchanged. The current stored position happens to be zero, but that is configuration, not semantic equivalence.
3. Several codes are accepted with meanings different from the 2014 Haas manual. The highest-risk example is the manual's `G10 L10 P5 R2.5` tool-length write: grblHAL accepts it but writes the tool **radius**, leaving tool length unchanged. There are also conflicting meanings for M48/M49/M50/M51/M53/M61.
4. Haas M00 stops the spindle and coolant; the firmware and simulator only hold execution, leaving them on. Haas M30 cancels tool-length compensation; the live board retained `G43 H1` and a `-25.400` TLO after M30.
5. Dry Run is materially different: it removes spindle/coolant-on commands, leaves rapids as rapids, and can be toggled during a cycle. The manual says spindle operation remains adjustable, all rapids and feeds use the selected dry-run rate, and Dry Run cannot be toggled until the program finishes or RESET is pressed.
6. The simulator and live board do not have the same contract. The simulator draws G2/G3 arcs as straight endpoint moves, always sends G28 to zero, and rejects many codes advertised on the HELP page as runnable.

The previous agents made substantial, real improvements. I independently confirmed many of them. However, their cumulative `docs/fidelity-report.md` also records a sizable open backlog, and its early summary is stale relative to later fixes. The README's declaration that the project is “complete” and the count “116 of 132 keys work” should not be interpreted as a Haas-fidelity result. A key is counted as verified when some implemented action was tested; several verified keys still behave differently from the manual.

## Overall assessment

| Area | Assessment | Reason |
|---|---|---|
| Physical layout and legends | Strong | The eight keyboard groups, key placement, most legends, panel proportions, and 13-pane screen geometry closely follow figures F2.26 and F2.27. |
| Basic Haas workflow familiarity | Partial | LIST PROGRAM, offsets, MDI persistence, run switches, overrides, and mode-bar names are useful, but important sequences differ. |
| Haas program compatibility | Poor to partial | A useful subset is translated, but important unsupported codes and silent semantic collisions remain. |
| Simulator fidelity | Partial | Much improved from its earlier state, but still materially differs from both a Haas and the ClearCore firmware. |
| Mechanical-stage safety | Not acceptable as configured | No homing/limits/fault monitor; virtual E-stop/power controls; no Haas-equivalent safety chain. |
| Transport and sender engineering | Strong | Flow control, stale-link blanking, WebSocket/USB transport, control memory, and board deployment are thoughtful and well tested. |

## Review method and evidence

I performed this review independently before reading the previous agents' conclusions, then used their report only as a final cross-check.

- Read the 2014 manual sections covering power-up, keyboard, screen panes, program management, jogging, offsets, Dry Run, running/restarting programs, editing, MDI, the G-code table, the M-code table, and relevant detailed code pages. Page numbers below are the printed manual pages; PDF page is printed page + 20.
- Traced `src/main.js`, `src/grbl.js`, `src/sim.js`, `src/keys.js`, `src/ui/screen.js`, `src/ui/pendant.js`, and `src/transport.js`.
- Traced the firmware branch changes, `src/haas_plugin.c`, configuration/pin mapping, and the relevant grblHAL core parser behavior.
- Ran all 88 sender tests: all passed.
- Built the firmware with PlatformIO: success, 356,748 bytes flash (70.2%) and 78,692 bytes RAM (40.0%).
- Exercised the browser application headlessly against the real UI event handlers and simulator.
- Queried the live ClearCore over `/dev/ttyACM1` at 115200 baud without commanding axis motion.
- Used grblHAL check mode to test parser compatibility for Haas examples and macro syntax.
- Confirmed that `http://clearcore.local/` serves the exact current `dist/index.html.gz`: both SHA-256 values were `b257de47d27a48fb2e4c0824c9199655db3806ac4aeb93740c3d025bf45551d4`.

No application or firmware source code was modified. No persistent firmware setting, offset, G28 position, or tool-table entry was changed during this review. The temporary modal TLO used for the M30 test was restored with G49.

## Findings that should block student stage use

### B1. The visible safety and power controls are not their Haas equivalents

Manual basis: the physical E-stop interrupts hazardous machine operation; POWER OFF powers down the control; power-up enters SETUP:ZERO with alarms and requires RESET followed by POWER UP/RESTART (pp. 30-35, 75).

Implementation:

- EMERGENCY STOP and RESET both send grbl soft reset byte `0x18`. The UI honestly says the E-stop is software, but the red mushroom still visually represents a safety function it does not provide.
- POWER OFF disconnects the browser and turns off its display state. It does not remove power from the ClearCore, servo enables, spindle circuit, or stage. Buffered controller work can outlive the browser interaction.
- POWER ON opens a connection/file dialog; it does not power the machine.
- The firmware exposes physical Reset and Feed Hold inputs, but the hardware Cycle Start input was reassigned to the probe. There is no evidence of a hardware category-rated E-stop chain in either project.
- `HLFB_MONITOR_ENABLE` is `0`, so ClearPath servo-fault feedback is not used to alarm the controller.

Live configuration:

```text
$20=0   soft limits disabled
$21=0   hard limits disabled
$22=0   homing disabled
```

Impact: a student can believe the virtual controls provide machine-tool safeguards that they do not. The system should not operate a student-accessible stage until it has a physical E-stop/power-removal path, verified limits/homing, and fault handling independent of the browser.

### B2. `HOME G28` and program `G28` do not mean Haas machine zero

Manual basis: G28 returns the specified axes, or all axes, to **machine zero** and cancels tool-length compensation (p. 249). The HOME G28 key returns all axes to zero; with a typed axis it can return one axis (p. 40).

Implementation:

- `HOME G28` sends bare `G28` (`src/main.js`, `zero-home`).
- grblHAL reads a separately stored `CoordinateSystem_G28`; `G28.1` overwrites it. The live `$#` report confirms a distinct `[G28:...]` record.
- The app's HELP page explicitly advertises `G28.1` as “store it from here,” making it possible to change what the HOME G28 key will do.
- The simulator always drives G28 to `[0,0,0,0]` and does not support G28.1, hiding the board behavior.
- The button always homes all axes; the manual's “axis letter then HOME G28” path is not implemented.

The live board's G28 record is currently zero, which explains the previous successful bench observation. That observation proves the current value, not Haas equivalence. A later `G28.1`, NVS restore, or other client can change it.

Impact: this is a motion-command collision with crash potential. Both the key and streamed Haas programs need an explicit compatibility implementation, not pass-through.

### B3. Accepted Haas-looking code can silently do something else

The sender provides helpful notes for rejected Haas codes, but a rejection is safer than a successful command with a different meaning. The following collisions are present in the target firmware:

| Code | 2014 Haas meaning | Current grblHAL meaning/result |
|---|---|---|
| `G10 L10 P5 R2.5` | Set H5 tool length to 2.5 (manual's own example, p. 245) | Accepted; R writes tool radius. Tool length is not set. |
| `G28` / `G28.1` | G28 goes to machine zero; Haas manual does not define G28.1 as its mutable destination | Go to / set grblHAL stored position 1. |
| `G20` / `G21` | Must agree with stored Setting 9; mismatch alarms (p. 249) | Directly changes modal units; the sender treats it as Setting 9 and persists a browser preference. |
| `M48` | Check validity of current pallet program (p. 328) | Enable feed/spindle overrides. |
| `M49` | Set pallet status (p. 329) | Disable feed/spindle overrides. |
| `M50` | Execute pallet change (p. 329) | Feed-override control. |
| `M51` | Set optional user relay 1 | Spindle-override control. |
| `M53` | Set optional user relay 3 | Feed-hold override control. |
| `M61` | Clear optional user relay 1 (p. 330) | Set current tool from Q. |
| `M60`, `M70`-`M73` | Not the 2014 Haas mill meanings listed by this manual | LinuxCNC/grblHAL program/modal operations advertised on HELP. |

The live parser accepted `G10 L10 P5 R2.5`, G20, M48, M49, `M50 P0`, `M51 P0`, `M53 P0`, and `M61 Q5` in check mode. The HELP page teaches the grblHAL meanings of these M-codes without a side-by-side warning that the Haas manual assigns different meanings.

Impact: a program copied from the manual can run without an error but fail to establish the intended tool length or change unrelated state. A student can also learn code meanings that are wrong on the Haas mill.

### B4. M00 and M30 do not perform the manual's safety/state transitions

Manual basis:

- M00 stops axes and spindle and turns off all coolant; CYCLE START resumes at the next block (p. 322).
- M30 stops the program and spindle, turns off coolant/TSC, rewinds, and cancels tool-length offsets (p. 326).

Implementation and tests:

- The simulator entered `Hold:0` after `M3 S1000`, M8, M0 but reported `FS:0,1000|A:SF`: spindle and flood remained on.
- The grblHAL M00 flow path holds execution but does not clear spindle/coolant state.
- On the live board, `G43 H1` produced TLO `-25.400`; after M30 the board still reported `G43` and TLO `-25.400`. G49 was required to clear it.
- The sender's “M30 CNT” increments for every completed non-MDI job, even a program ending with M2 or falling off the end. The Haas counter increments on M30 (and optionally M99 under Setting 118), not on generic completion.

Impact: program-stop behavior is unsafe to generalize to a Haas, and retained tool compensation can alter the next program's motion.

## High-priority behavioral discrepancies

### H1. Dry Run is not the Haas proofing mode

Manual basis (p. 107): Dry Run is selected in MEM or MDI; all rapids and feeds run at the rate selected by the jog-speed buttons; commanded moves and tool changes still occur; spindle override keys remain usable; Dry Run can only change after the program finishes or RESET is pressed.

Current behavior:

- Removes M3/M4 and M7/M8, so spindle and coolant are suppressed. This is a defensible safer mode, but it is not Haas Dry Run and should not carry the same unqualified name.
- Replaces explicit F words, but rapid moves remain grbl rapids. The HELP page discloses this part.
- Can be toggled while a program is running; the icon changes immediately and the status says it applies next cycle.
- A feed move with no usable modal F in the transformed program can still depend on stale/undefined controller state.
- Graphics mode—the manual's safer no-motion proofing recommendation—is absent; SETTING/GRAPHIC only shows the inch/metric choice.

### H2. Cycle Start runs a memory program from EDIT and other pages

The manual states that the selected program is run with CYCLE START in OPERATION:MEM (p. 77), while MDI runs the MDI page (p. 114).

`cycleStart()` chooses MDI only when the active pane is MDI; otherwise it runs the selected memory program regardless of current mode or pane, then changes the display to OPERATION:MEM. Browser verification showed CYCLE START from EDIT:EDIT immediately starting the selected program.

Impact: this removes a significant mode guard and teaches that CYCLE START is globally valid. On a moving trainer it also increases the chance of an unintended start while editing or inspecting offsets.

### H3. Power-up and alarm recovery do not reproduce the Haas sequence

- Manual: POWER ON -> SETUP:ZERO with alarms -> RESET -> POWER UP/RESTART -> OPERATION:MEM (p. 75).
- Sender: connection begins in SETUP:JOG with no startup alarm; POWER UP/RESTART sends `$H`, leaves the UI in SETUP:ZERO after completion, and cannot work on the available board because `$22=0`.
- Haas RESET clears recoverable alarms. grblHAL soft reset does not unlock alarm state; students must type `$X`, a grbl-specific command. The ALARMS page explains this, but the learned recovery workflow remains different.
- The simulator performs a zero move for `$H` despite displaying settings that say homing is disabled, so it does not reveal the live behavior.

### H4. Zero-return and jog key sequences differ

| Manual | Sender |
|---|---|
| Type axis letter, then SINGLE (p. 40) | SINGLE prompts for an axis, then a second axis press is required. The first typed axis remains in the input bar. |
| Type/select an axis, then ORIGIN zeros the selected value (pp. 39, 51) | ORIGIN always zeros all four sender-side OPERATOR coordinates, independent of typed axis or active page. |
| Axis jog key can be held for continuous motion; press/release also selects the handwheel axis (pp. 42, 104) | Pointer-down sends one increment. Continuous motion exists only through the separate JOG LOCK mechanism. |
| JOG LOCK, then an axis; press JOG LOCK again to stop (p. 42) | A subsequent jog key also cancels a latched jog. |
| AUX CLNT toggles TSC in MDI mode (p. 42) | AUX CLNT is accepted from any mode. |

The metric increment and rotary-direction bugs identified by the previous review are fixed; those fixes were independently confirmed in source/tests.

### H5. Run-Stop-Jog-Continue is absent

The manual's feed-hold workflow stores the interrupted position, permits controlled jog-away, returns X/Y at 5%, restores Z, holds again, and then resumes on a second CYCLE START (pp. 108-109). The sender only supports hold/resume. grbl jog commands during Hold are not an equivalent implementation.

This is a major training gap because feed hold, safe inspection, and restart are core operator skills.

## Editing, input, and program-management fidelity

### Correct and useful

- LIST PROGRAM files by O-number, marks the active program with `A`, selects by highlight or typed number, creates a missing number, refuses to erase the active program, and asks Y/N before erase.
- MDI is correctly modeled as a persistent page rather than a command line. CYCLE START runs it; ERASE PROGRAM clears it; HOME + typed O-number + ALTER saves it to memory.
- The cursor is word-based, and ALTER/DELETE/UNDO operate on words.
- Offset ENTER adds and F1 replaces, matching p. 104. PART ZERO SET advances X -> Y -> Z as the manual warns.
- Browser storage failures are surfaced instead of silently claiming persistence.

### Remaining differences

1. **EOB semantics:** The Haas semicolon key ends a program block (p. 41). Here it inserts `;`, and `stripComments()` treats semicolon as comment-to-end-of-line. A semicolon entered on an otherwise empty MDI line becomes a visible block that sends nothing. The HELP page discloses this, but it is a fundamental keypad habit.
2. **Lowercase:** SHIFT + alpha should enter lowercase (p. 41). Browser verification showed SHIFT+A entering uppercase A.
3. **INSERT position:** The manual says inserted code appears in front of the highlighted block/code (p. 112). `editBlock(..., 'insert')` splices after the highlighted word and cannot use EOB to create a normal new block at that point.
4. **Undo depth:** Haas reverses nine changes; the sender retains 50. This is user-friendly but not behavioral fidelity.
5. **Advanced editor:** Haas EDIT has active and inactive program panes; repeated EDIT switches panes; F4 exchanges them; F2 selects ranges; F1 opens menus; search is typed text + UP/DOWN (pp. 112-120). The sender has one editable program, no range selection/clipboard, and arrows move the cursor instead of searching typed text.
6. **Device manager:** The Haas tabbed memory/USB/hard-drive/net-share workflow, multi-select, F2 copy/duplicate, ALTER rename, directories, sizes, and dates are replaced by browser memory and a two-page SD-card workflow. SEND/RECEIVE are repurposed from RS-232 to the machine SD card. This is understandable architecture, but it should be treated as a different transfer lesson.
7. **Program shape:** A new Haas program starts with the O-number and EOB. The sender creates only the O-number line.
8. **Capacity:** The manual caps MEMORY at 500 programs. The sender is limited indirectly by browser localStorage and O-number availability.

## Display fidelity

The display looks convincing at a glance and preserves the most useful spatial relationship: program at upper left, modal/tool/coolant panes across the top, a large active pane, and status/input/alarm bands below. Exactly one active pane is white. These are valuable orientation cues.

However, “all thirteen display pages are real” in the README is inaccurate terminology. Figure F2.27 defines 13 **panes**, not 13 functional pages. Several panes are placeholders or reduced substitutes:

- POSITION always shows all four reference systems; repeated POSITION does not cycle reference views as described on pp. 39 and 51.
- CURRENT COMMANDS shows decoded modal state only. The Haas control has multiple pages for timers, variables, active codes, positions, tool life/load, maintenance, ATM, date/time, and editable/resettable counters (pp. 49-50).
- ALARMS does not toggle to MESSAGES on a repeated press (p. 51).
- SETTING/GRAPHIC contains only browser-persisted Setting 9 behavior and no Graphics mode.
- PARAMETER/DIAGNOSTIC displays editable-machine `$` settings as read-only grbl values. This is useful diagnostics, but it is neither the Haas factory Parameter page nor the Haas user Settings collection.
- ACTIVE CODES is a raw `$G` line rather than the Haas decoded active-code display including D/H/T/recent M details.
- The coolant pane reports pump state, while the manual's pane is a tank level gauge.
- The timer pane lacks Remaining, loops, the second M30 counter, and ORIGIN reset; its one “M30” count has the generic-completion error noted above.
- Active Tool lacks tool type, life, and load. Axis load meters are absent, consistent with HLFB monitoring being disabled.
- The icon bar is a text summary rather than the manual's 18 status fields.

These omissions are acceptable for a scoped trainer only if the scope is stated plainly. They do not support the README's implication that every display page is implemented.

## Programming dialect evaluation

### Well-handled compatibility work

The sender/firmware combination includes several thoughtful and verified adaptations:

- Integer-P Haas G04 dwell is divided by 1000; decimal-P remains seconds.
- G31 is translated to G38.2; M16 to M6.
- G43 H uses the branch's persistent 32-tool table; stock firmware has a G43.1 fallback.
- G44 is represented by a negated dynamic offset.
- P-less G82/G86/G89 receives P0, and sticky canned-cycle P behavior is preserved in streamed jobs.
- G110-G112 and G154 P1-P3 map to the three grblHAL extended coordinate systems.
- The firmware M97 plugin implements same-file N-block calls with L repeats for SD jobs; the sender expands M97 for streamed jobs.
- M98 and no-argument G65 can be expanded from browser control memory when streaming.
- Unsupported Haas families receive unusually good explanatory messages instead of bare grbl errors.
- The sender warns about more than one M-code in a Haas block.

### Important gaps and mismatches

1. **Only 3 of 99 additional work offsets:** Haas G154 P1-P99 is reduced to P1-P3. This is disclosed.
2. **Cutter compensation:** G41/G42 with D offsets is absent. This is one of the largest gaps for running ordinary Haas milling examples.
3. **Rotation and accuracy modes:** Haas G68/G69 and G187 are absent. G51 is translated only for the no-center uniform-P form; center forms are rejected because grblHAL's compiled scaling dialect uses axis words as factors about work zero.
4. **Rigid tapping and encoder-dependent codes:** G84/G74/G95 and related functions are unavailable without spindle feedback.
5. **Common Haas cycles/options:** G12/G13 pockets, G47 engraving, G70-G72 hole patterns, several boring/probing cycles, and many machine-option M-codes are unavailable. Explanatory errors mitigate but do not create transferable operating experience.
6. **Multiple M-codes:** The sender warns but still runs a block that the Haas control rejects. For a trainer, a warning followed by execution still teaches that the block is usable.
7. **Single Block counts wire lines:** A single Haas source block can become multiple wire lines (notably G44, and G43 on stock firmware), so one source block can require more than one CYCLE START.
8. **M7:** The Haas manual calls M7 optional shower coolant; the firmware uses the mist/TSC-related output. HELP says “mist coolant,” which is correct for grblHAL and wrong as Haas instruction.

### Macro support is not Haas macro control flow

The firmware branch enables `NGC_EXPRESSIONS_ENABLE`, which provides expression/parameter support and LinuxCNC-style O-word flow control. That is useful, but the 2014 Haas macro language uses constructs such as:

```text
IF [#1 EQ 0] GOTO100
WHILE [#101 LT 10] DO1
...
END1
```

In live grblHAL check mode, `#1=0` was accepted, but the Haas IF/GOTO and WHILE/DO lines both returned `error:71`. grblHAL's implemented flow syntax is O-label based (for example `O100 IF ...`), not the Haas syntax in the manual. The claim that expressions/O-word support closes Haas macro fidelity is therefore too broad.

The M97 plugin itself is a good targeted addition and passed the previous bench test. It should be described as M97 compatibility, not general Haas macro compatibility.

## Simulator versus firmware

The simulator is important because the README calls it “the classroom mode.” It must therefore be held to a higher standard than a visual demo.

Confirmed discrepancies:

- G2/G3 deletes I/J/K/R and travels in a straight line to the endpoint. Full circles have no path. This affects timing and motion understanding even without a graphics view.
- G28 always goes to numeric zero and the simulator does not implement G28.1, unlike the live board.
- The simulator's accepted-code sets are much smaller than the HELP page's “codes this machine runs” lists. Examples include G5/G5.1, G28.1/G30.1, probing, G65-G67, G92.2/G92.3, M48-M53, M61, M70-M73. A student can read HELP, enter the code in simulator mode, and receive an error for a code HELP says runs.
- `$20=0` is displayed/stored but does not disable the simulator's built-in travel check. Other settings are likewise not necessarily obeyed.
- Homing is modeled as a move to zero rather than a switch-search/reference procedure.
- M00 retains spindle and coolant, as described above.
- M2/M30 do not model Haas program-end modal reset/TLO behavior.
- The simulator's “soft limit” envelope is centered around its arbitrary zero and does not represent a homed machine-coordinate travel envelope.

The previous cross-environment fixture ending at the same XYZ position is useful, but one endpoint fixture does not establish semantic parity across modes, stops, units, offsets, arcs, code errors, or state resets.

## Firmware branch evaluation

The branch additions are generally well scoped and build cleanly:

- `N_TOOLS=32` gives native persistent G43 H support and solves a real DNC limitation.
- The M97 plugin is carefully chained into grblHAL callbacks, handles L repetition and bounded nesting, and cleans up on reset/file end.
- M31/M33 and M88/M89 connect relevant pendant habits to available outputs.
- The changed-spindle callback fixes live application of spindle settings.
- USB echo removal and the network/web deployment are practical improvements.

Concerns:

1. The tool page exposes 20 tools, firmware has 32, and the Haas table has up to 200. Tools 21-32 can exist in firmware but cannot be measured/edited through this UI.
2. The sender ignores zero-valued `[T:]` rows so “never measured” stays distinguishable, but this also cannot represent a legitimately measured zero-length tool.
3. O-word expressions are not Haas control flow, as demonstrated above.
4. M97 is meaningful only while the board has a seekable file or while the sender expands it. That architectural boundary is handled, but should remain prominent in student material.
5. Homing/limits and the manual tool-change modes remain unverified on actual mechanics.
6. Reassigning the physical Cycle Start input to probe and keeping HLFB monitoring off may be acceptable for this bench, but reduces the hardware control/safety surface expected of a training machine.
7. The current board has `$397=0`, despite documentation recommending 250 ms auto-report. The sender polls after silence, so it still works, but the deployed configuration and README are not aligned.

## Independent check of the previous agents' conclusions

### Confirmed improvements

I confirmed the prior fixes for metric jog increments, rotary jog signs, PC-keyboard routing, offset add/F1 replace, PART ZERO SET advance, input CANCEL behavior, commanded spindle speed, MDI as a persistent program page, erase confirmation, active-program protection, directory selection/creation, G04 conversion, G31/M16 aliases, native tool table, M97, run-switch plumbing, setting descriptions, staleness blanking, and the current board deployment.

The tests, firmware build, hardware identity, SD-served application, and transport claims are credible. This is not a superficial project.

### Conclusions that are overstated or incomplete

- `docs/fidelity-report.md` is an accreted work log. Its opening “top findings” still labels already-fixed items as open, while later sections record the fixes. It is valuable evidence but not a clean final acceptance report.
- That report itself lists many still-open items: continuous jog, Run-Stop-Jog-Continue, F2/F3/F4 behavior, multiple display pages, Graphics, settings, cutter compensation, numerous code families, and hardware-dependent functionality.
- The README's “Status: complete” is not supported by either the manual comparison or the prior report's own backlog.
- “116 of 132 keys work” measures implemented/tested button actions, not correctness against each manual context. For example, Dry Run, ORIGIN, SINGLE, HOME G28, SHIFT+alpha, and CYCLE START are present but not fully faithful.
- The earlier review recognized that grblHAL is a different dialect but missed the most consequential silent collisions: mutable G28, Haas G10 L10 R tool length versus grbl tool radius, M00 accessory behavior, M30 TLO persistence, and the conflicting M48-M61 meanings advertised in HELP.
- Enabling expressions was treated too close to Haas macro coverage. Live testing shows Haas IF/GOTO and WHILE/DO syntax is rejected.
- Simulator/board parity was accepted too broadly from a limited fixture; arcs, G28 state, HELP coverage, and end/stop behavior still differ.

My independent conclusion is therefore: **the previous work achieved good engineering results and corrected many real faults, but it did not establish Haas behavioral equivalence.**

## Recommended remediation order

### P0 — before students move hardware

1. Install and validate a physical E-stop/power-removal chain, limit switches, homing, and servo-fault monitoring. Do not rely on the browser for safety.
2. Relabel or gate virtual POWER OFF and EMERGENCY STOP so no student can confuse them with energy isolation. A physical trainer should expose the actual hardware controls.
3. Implement a Haas-compatibility layer for G28 and HOME G28. It must go to machine zero, honor typed-axis forms, handle the intermediate point correctly, and cancel TLO. Do not depend on the grbl G28 record being zero.
4. Reject or translate every silent semantic collision. At minimum: G10 L10/L1/L11/L12/L13, G20/G21 versus Setting 9, M48/M49/M50/M51/M53/M61, M00, and M30.
5. Restrict memory-program CYCLE START to OPERATION:MEM. Keep MDI execution in EDIT:MDI and make other modes refuse with a clear prompt.
6. Either implement Haas Dry Run or rename the current feature (for example “safe no-spindle motion check”) and make the differences unavoidable on screen.

### P1 — for transferable operator habits

1. Correct axis-first SINGLE/HOME/ORIGIN sequences and implement press-and-hold jogging.
2. Implement the power-up state transition and alarm workflow after physical homing exists.
3. Add a genuine no-motion Graphics/proofing mode before expanding less important display pages.
4. Make semicolon EOB and SHIFT+alpha lowercase behave like the keypad.
5. Correct INSERT placement and add the minimum high-value editor behaviors: F2 block selection, typed search with UP/DOWN, and the second edit pane/switching.
6. Split HELP into “2014 Haas meaning” and “trainer/grblHAL behavior.” Do not present LinuxCNC meanings under an undifferentiated Haas-looking control.
7. Build a manual-derived compatibility manifest covering every G/M code: translate, faithfully implement, explicitly reject, or declare hardware unavailable. Generate HELP and tests from it.
8. Make simulator and firmware pass the same conformance corpus, including arcs, G28/G28.1, M00/M30, units, offsets, code acceptance, and reset behavior.

### P2 — completeness and polish

- Expand CURRENT COMMANDS, POSITION cycling, ALARMS/MESSAGES, timers/counters, Active Codes, and tool/axis status.
- Add instructor lockouts corresponding to Haas Settings 16-21, 53, and 163.
- Decide which device-transfer lesson is intended and label SD/browser operations separately from Haas RS-232/USB Device Manager behavior.
- Add the second M30 counter, correct counter triggers, Remaining/Loops, and ORIGIN reset.
- Reconcile UI tool count (20), firmware tool count (32), and documented scope.

## Suggested acceptance criteria

The project should not again be called complete solely because all current tests pass. A Haas-training acceptance suite should include:

1. A table-driven test for every key description on manual pp. 35-43, including required mode and key order.
2. Executable tests for the manual's canonical workflows: power-up, work offset, tool offset, Dry Run, run, hold/jog/continue, program create/select/delete, edit, and MDI save/clear.
3. A code corpus built from the manual's G/M tables and detailed examples, with expected disposition and state changes on both simulator and board.
4. Explicit collision tests showing that no Haas code is silently accepted with a conflicting grblHAL meaning.
5. State-reset tests for RESET, M00, M02, M30, G28, tool compensation, coolant, spindle, overrides, and counters.
6. Simulator/board equivalence tests that compare more than final position: acceptance/error, path class, timing, modal state, accessories, TLO, holds, and reports.
7. Hardware acceptance with a clear travel envelope, homing switches, hard/soft limits, HLFB faults, physical E-stop, and loss-of-browser/network behavior.

## Final recommendation

Keep the project and continue from this base—the transport, UI structure, offset work, control memory, and targeted firmware additions are worth preserving. For immediate classroom use, constrain it to simulator-only, supervised exercises with a written divergence handout and no claim of full Haas behavioral equivalence. Do not connect students to a moving stage under the current safety configuration.

The next development pass should prioritize semantic collision prevention and physical safety over additional key-count or display-count improvements. Those are the changes that will actually make experience on this trainer transfer safely to a Haas mill.
