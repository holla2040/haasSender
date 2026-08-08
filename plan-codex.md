# Haas compatibility remediation plan

Date: 2026-08-07

Repositories:

- Sender: `/home/holla/haasSender`, branch `main`
- Firmware: `/home/holla/grblhal-clearcore`, branch `haasSender`
- Review being addressed: `/home/holla/haasSender/review-codex.md`
- Authority: `reference/english---mill-operator's-manual---2014.pdf`, document 96-8200

## Objective

Correct the confirmed silent semantic collisions around:

1. Haas G28 and G10 L10.
2. M-codes whose grblHAL meanings conflict with the 2014 Haas mill manual.
3. Haas M00 and M30 stop/end behavior.

The result must teach Haas behavior consistently through MDI, streamed programs, the browser simulator, and programs run directly from the ClearCore SD card. A Haas-looking command must never be passed through with an unrelated grblHAL meaning.

This is a safety-relevant compatibility task. Prefer an explicit rejection with a Haas-specific explanation over accepting a command with partial or different behavior.

## Required reading before editing

Read these sources first and record the exact behavior being implemented in the eventual change notes:

- Manual p. 40: HOME G28 and typed-axis use.
- Manual p. 245: G10, especially the example `G10 L10 P5 R2.5`.
- Manual p. 249: G28 return to machine zero and cancellation of tool-length compensation.
- Manual p. 322: M00 and the one-M-code-per-block rule.
- Manual p. 326: M30 state changes and rewind.
- Manual pp. 328-330: M48 through M61.
- `review-codex.md` sections B2, B3, and B4.
- Sender: `src/grbl.js`, `src/main.js`, `src/sim.js`, `src/ui/screen.js`, and relevant tests.
- Firmware: `src/haas_plugin.c`, `src/grbl/gcode.c`, `src/grbl/gcode.h`, and the SD streaming callbacks.

Do not rely only on comments or the existing fidelity report. Verify the manual and current code directly.

## Guardrails and baseline

Before editing:

1. Capture `git status --short` and current HEAD in both repositories.
2. Preserve unrelated work. In particular, `grblhal-clearcore/src/networking` was already dirty during the independent review; do not alter, discard, stage, or reformat it.
3. Run and record the sender baseline:

   `npm test`

4. Run and record the firmware baseline:

   `pio run`

5. Query, but do not change, the board's `$I`, `$G`, `$#`, and relevant `$$` settings.

The available ClearCore is currently a bare-controller bench setup, intentionally not connected to a mechanical stage or limit/home switches. Its disabled homing, hard limits, and soft limits (`$22=0`, `$21=0`, `$20=0`) are therefore expected and are not a defect to fix in this task. After positively confirming that no motion-producing hardware is attached, the agent may exercise G28 on the controller to inspect parser, modal, and output behavior. That cannot validate physical reference return or positioning accuracy. Full G28 motion acceptance belongs to the later stage configuration and requires its homing/limit system, clearance, and a physical E-stop.

## Architectural requirement

There are four execution paths:

| Path | Current route |
|---|---|
| MDI | Sender `wireLine` to firmware |
| Browser-memory program | Sender `wireProgram` to firmware |
| Simulator | `src/sim.js` |
| SD/DNC or another serial client | Firmware parses the file directly |

Fixing only `wireLine` leaves SD/DNC unsafe. Fixing only firmware leaves simulator teaching the wrong behavior and may leave stock-firmware fallback wrong. Implement one documented Haas compatibility policy, with:

- Sender-side translation/rejection shared by MDI and streamed programs.
- Matching simulator behavior.
- Firmware enforcement for direct serial and SD/DNC input.

If a built-in grblHAL G- or M-code cannot be intercepted cleanly through a supported callback, use the smallest compile-time-gated core change possible, named clearly as Haas compatibility. Do not silently change general upstream grblHAL behavior without a branch-specific flag and tests.

Do not claim a path is compatible if it bypasses the policy. If full firmware enforcement proves impractical, disable SD/DNC execution of unvalidated files and state that limitation prominently; do not leave raw execution available under a Haas label.

## Workstream 1: G28

### Required behavior

Implement the manual's contract:

- G28 returns all axes to machine zero when no axes are specified.
- When axes are specified, only those axes return.
- Any programmed intermediate move occurs before the final machine-zero move and honors the source block's distance mode.
- G28 cancels tool-length compensation.
- The HOME G28 pendant key uses the same compatibility implementation.
- Typing an axis letter and pressing HOME G28 returns only that axis.
- grblHAL's mutable stored G28 record must not determine the Haas destination.

### Implementation steps

1. Write pure translation tests before implementation for:

   - `G28`
   - `G28 Z0`
   - `G28 G91 Z0`, the manual's common safe-retract form
   - `G90 G28 X0 Y0`
   - mixed modal state with active G43/H
   - HOME G28 with no typed axis
   - typed `X`, `Y`, `Z`, and `A` followed by HOME G28

2. Define a single source-level translation function. It must return all wire blocks and source-row mappings needed to preserve error highlighting.

3. Do not translate Haas G28 to bare grblHAL G28. The final leg must use an explicit machine-coordinate move to the configured machine-zero coordinates, limited to the requested axes. Determine and document the ClearCore machine-coordinate convention instead of assuming every machine homes to numeric zero.

4. Resolve the order of the intermediate move and G49 from the manual and parser semantics before coding. Add a test that proves an active TLO cannot alter the final machine-zero target.

5. Prevent `G28.1` from being taught or accepted as a Haas command. It may remain an internal grblHAL maintenance operation only if it is inaccessible from student MDI/program execution and clearly labeled non-Haas.

6. Change `src/main.js` HOME G28 handling to use the same compatibility helper rather than sending bare `G28`. Consume and validate a typed single axis; reject multiple axes or unrelated input with a precise prompt.

7. Update `src/sim.js` to follow the same axis selection, intermediate-point, and TLO-cancel rules. The simulator's result must not depend on its stored `G28` record.

8. Add firmware enforcement for SD/DNC and direct input. Preferred result: a branch-specific Haas mode in which built-in G28 has Haas semantics and G28.1 is rejected to student paths. Keep the change isolated and documented if `src/grbl/gcode.c` must be patched.

9. Remove or replace the current HELP entry that describes G28/G28.1 as grblHAL stored-position operations.

### G28 acceptance criteria

- A deliberately nonzero grblHAL `[G28:...]` record cannot change the translated or simulated Haas G28 destination.
- `G28 G91 Z0` retracts only Z to machine zero, preserves X/Y/A, and ends in G49.
- Bare G28 targets all configured axes and ends in G49.
- Typed-axis HOME G28 and program G28 use the same logic.
- MDI, streaming, simulator, and SD/DNC produce equivalent observable results.
- Bare-controller tests are labeled as parser/modal/output tests, not physical motion validation.

## Workstream 2: G10 L10

### Required behavior

The manual's `G10 L10 P5 R2.5` must set H5 tool length to 2.5 in the active units. It must not write tool radius or otherwise retain grblHAL's conflicting L10 meaning.

### Implementation steps

1. Add failing tests for:

   - `G10 L10 P5 R2.5` in inch and metric modes.
   - Leading zero variants such as `G010 L010 P005 R2.5`.
   - Invalid or missing P/R.
   - P outside the supported tool table.
   - Additional words that cannot be represented faithfully.
   - Proof that the radius field is unchanged.

2. Translate the Haas form to the firmware's native tool-length write, using the same sign and unit convention as the existing tool-offset UI and `G43 H` implementation. Do not guess the sign from one stored tool; test the complete sequence of write, activate H, query TLO, and restore.

3. Put the transformation in the shared MDI/streaming compatibility layer.

4. Implement the same behavior in the simulator, including its `$#` tool-table report.

5. Enforce it in firmware for direct serial and SD/DNC input. The target branch must no longer accept L10/R as a radius write while presenting itself as Haas-compatible.

6. Update HELP to state “G10 L10 Pn Rvalue sets Hn tool length,” with a Haas manual reference. If native radius editing is still needed for maintenance, expose it only through an explicitly labeled non-Haas maintenance mechanism.

### G10 L10 acceptance criteria

- The manual's exact example changes H5 length to 2.5 and leaves radius unchanged on every execution path.
- G43 H5 subsequently reports/applies the new length with the correct sign and units.
- Invalid forms fail before changing the table.
- Tests save and restore any real tool-table row they touch. Use a reserved, backed-up row and a `finally`-style restoration procedure; never use an in-service student tool entry.

## Workstream 3: conflicting M-code meanings

### Compatibility policy

At minimum, handle every confirmed collision:

| Code | Haas 2014 meaning | Required trainer disposition |
|---|---|---|
| M48 | Check validity of current pallet program | Reject as unavailable unless the exact Haas check is implemented |
| M49 | Set pallet status | Reject: no pallet system |
| M50 | Execute pallet change | Reject: no pallet system |
| M51 | Set optional user relay 1 | Reject unless that exact relay exists |
| M53 | Set optional user relay 3 | Reject unless that exact relay exists |
| M61 | Clear optional user relay 1 | Reject unless that exact relay exists |
| M60, M70-M73 | No matching 2014 meanings for the currently advertised grblHAL operations | Remove from Haas-facing HELP and reject from student paths |

Do not preserve the current grblHAL meanings under the same student-facing codes. In particular, these commands must not enable/disable overrides, alter feed-hold control, change the current tool, or invoke LinuxCNC-style program operations.

### Implementation steps

1. Add a centralized collision table used by validation and HELP text so the two cannot drift.

2. Make `wireLine`/`wireProgram` raise a `WireError` with the Haas meaning and the reason the trainer cannot perform it. This must cover both MDI and browser-memory programs.

3. Make the simulator return a deterministic unsupported-command error and leave all override, relay, coolant, tool, and motion state unchanged.

4. Add branch firmware rejection before any built-in grblHAL side effect occurs, including for SD/DNC and raw serial input. Check mode must reject the same block.

5. Replace the LinuxCNC/grbl descriptions and links in `src/ui/screen.js` with Haas meanings and explicit “not fitted/unavailable” status.

6. Retain existing non-conflicting custom functions only after checking their Haas meaning and documenting why they are safe. Run regression tests for M31/M33, M88/M89, and M97.

### Conflicting-M acceptance criteria

- Each listed code fails clearly on MDI, streaming, simulator, check mode, raw serial, and SD/DNC.
- Snapshot state before and after each rejection; no override, feed-hold, tool, output, or modal state may change.
- HELP never describes a conflicting grblHAL meaning as Haas behavior.
- The existing one-M-code-per-block warning is not weakened. Consider changing it to a hard Haas-compatibility error as a separate, clearly scoped improvement.

## Workstream 4: M00 and M30

### Required behavior

M00:

- Complete the current block, stop axis execution, stop the spindle, and turn off all coolant.
- Enter a program hold.
- CYCLE START resumes at the next block; it must not silently restore spindle or coolant.

M30:

- Stop program execution, spindle, coolant, and TSC.
- Cancel tool-length compensation.
- Rewind the program pointer.
- Increment the M30 counter exactly for M30, not for M2 or falling off the end.

### Implementation steps

1. Add sender translation tests that preserve end-of-block ordering. If safety actions are emitted as extra wire blocks, map every generated block back to the original source row and document the Single Block implication.

2. Add sender-side compatibility for streamed programs and MDI:

   - M00 must result in spindle-off and coolant-off actions before the hold becomes observable.
   - M30 must result in spindle/coolant/TSC off and G49 before completion.
   - Generated wire must obey the Haas one-M-code-per-block rule.

3. Add firmware program-flow handling for raw serial and SD/DNC. Use the existing chained callback pattern in `src/haas_plugin.c` and supported spindle/coolant/TLO APIs where possible. Preserve all previous handlers. Do not mutate parser globals directly without explaining why no supported API can provide the required transition.

4. Update the simulator's deferred effects:

   - M00 clears spindle direction/speed and flood/mist before setting Hold.
   - M30 clears spindle/coolant, clears TLO/G43 state, and terminates/rewinds.
   - M2 remains distinct from M30 where the manual distinguishes them.

5. Correct the sender's counter logic in `src/main.js`. Carry the actual terminating flow through job metadata or a firmware completion event. Do not infer M30 merely because a job became Idle.

6. After completion, query and render `$G` and `$#` as the sender already does. Tests must verify the returned state, not only the emitted command sequence.

### M00/M30 acceptance criteria

- Starting from spindle-on plus flood/mist-on, M00 reaches Hold with spindle and all coolant off; CYCLE START continues at the next source block.
- Starting with G43 H active, M30 finishes with G49/TLO zero, spindle off, coolant/TSC off, and the program pointer at the top.
- M30 increments the counter once. M2, RESET, an alarm, M00, and normal fall-through do not.
- Repeated status frames or reconnects cannot double-count an M30.
- Behavior matches across streamed programs, MDI where meaningful, simulator, and SD/DNC.

## Test matrix

Add automated coverage before any hardware exercise:

| Layer | Required tests |
|---|---|
| `test/grbl.test.js` | Exact wire translation, rejection, row mapping, units, end-code metadata, counter inputs |
| `test/sim.test.js` | Final positions/modal state, TLO/tool table, M00 hold/resume, M30 cleanup, no side effects from rejected M-codes |
| UI/browser tests | Typed-axis HOME G28, HELP wording, MDI error messages, M30 counter behavior |
| Firmware build/tests | Compile-time Haas mode, callback chaining, parser rejection, SD flow completion |

Then perform non-motion board tests:

1. Use check mode for all conflicting M-codes and invalid G10 forms.
2. Verify M30 TLO cancellation with `G43 Hn`, `M30`, `$G`, and `$#`; restore the original modal/tool state.
3. Verify G10 L10 only on a reserved, backed-up tool row and restore it exactly.
4. Run a non-motion SD file that exercises rejection and M30 cleanup.
5. Do not energize spindle, coolant pumps, relays, or motion without confirming the loads are disconnected or obtaining explicit operator authorization.
6. With the ClearCore positively confirmed to be mechanically disconnected, G28 may be issued to observe parser/modal/output behavior. Record that this does not prove a machine-zero return.

A physical G28 motion test after a stage is connected is a separate gated activity. Its prerequisite checklist is:

- Physical E-stop tested.
- Homing switches fitted and homing verified.
- Hard/soft limits enabled and tested.
- Servo fault monitoring enabled.
- Stage clear, low speed/acceleration selected, and operator present.
- Original `$#` and settings backed up.

## Recommended work order and commits

Keep changes reviewable:

1. Tests and shared compatibility policy.
2. G10 L10 sender/simulator/firmware implementation.
3. Conflicting M-code rejection and HELP correction.
4. M00/M30 sender/simulator/firmware implementation and counter fix.
5. G28 translation and HOME G28 UI behavior.
6. Firmware G28 enforcement for direct/SD input.
7. Documentation, full regression, and controlled bench evidence.

Do not combine unrelated cleanup or formatting with these commits.

## Required final deliverables

The implementing agent should provide:

- Source and tests in both repositories as required.
- A short design note explaining the compatibility boundary and all direct-core changes.
- A manual-to-test traceability table for every acceptance criterion above.
- Full `npm test` and `pio run` output summaries.
- Browser/simulator evidence.
- Non-motion ClearCore evidence, including before/after `$G` and `$#` where relevant.
- An explicit distinction between bare-controller G28 tests and any physical stage-motion tests not performed.
- Updated README/HELP claims that distinguish implemented Haas behavior, rejected Haas behavior, and grblHAL maintenance-only operations.

## Definition of done

This task is done only when no covered Haas-looking block can silently execute a conflicting grblHAL meaning on any supported execution path. Passing sender unit tests alone is insufficient. Simulator, streamed/MDI, and direct SD/firmware behavior must agree, and all unavailable functions must fail before causing state or output changes.
