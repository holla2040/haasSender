# haasSender — working plan

The living checklist. Tick items as they land; add what you learn to
**Hard-won facts** so the next person does not rediscover it.

Design rationale and the HAAS→grblHAL mapping table live in
[`history/plan.md`](history/plan.md). This file is the *what next*.

---

## If you get stuck, ask — do not work around it

**Contact the owner with the `/dm` skill.** It sends a Discord direct message.
Use it the moment you are blocked: hardware not responding, a decision that is
not yours to make, credentials or physical access you do not have, a test you
cannot run, anything ambiguous in this plan.

**Do not invent a workaround.** This is the explicit instruction and it is not a
formality. The owner can jump in and clear a blocker in minutes, and would much
rather do that than inherit a codebase quietly bent around an obstacle nobody
mentioned. A workaround hides the problem, survives long after the obstacle is
gone, and costs far more to unpick later than the interruption would have cost.

Ask early. An interruption is cheap; a plausible-looking detour is not.

---

## Where it stands

Phases 1 and 2 are done and pushed. 21 of 132 keys do something.

| | |
|---|---|
| Protocol, streaming, three transports | done, verified against the real board |
| Pendant chrome, 13-pane screen, mode bar | done |
| Jog, increments, feed override, spindle M3/M4/M5, RESET | done |
| Everything else on the keypad | draws, does nothing |

## The bench

- ClearCore at `192.168.0.113`, grblHAL 1.1f, 4 axes XYZA, **no motors and no
  mechanics attached** — it is a bare board on a bench. Motion commands are safe:
  the planner runs and the DRO advances, nothing physically moves.
- Everything on that board is bench-verified **except homing and limit switches**,
  which are built but untested for want of real switches. So `$H` is the one
  mapping in this project that cannot be confirmed against hardware yet.
- The board currently serves an **older build** of this app from SD `/www`.
  Reinstall when convenient — see README. (That old build is a good demonstration
  of the bug the watchdog fixes: it sits at `OFFLINE` with all four axes on `0.000`.)
- **The WebSocket can wedge, and only a reboot clears it.** Seen 2026-08-05: port 81
  accepted the connection, negotiated `webui-v3` and sent `currentID:` / `activeID:`
  — then passed nothing in either direction. `$I`, `?` and `[ESP800]json=yes` all
  went unanswered, from a dev-server page and from the board's own served page
  alike, while telnet (23) and HTTP (80) on the same board were perfectly healthy.
  Power-cycling the ClearCore fixed it completely. So the symptom looks exactly
  like the missing-`webui-v3` failure and is not the same thing — if the socket
  opens, negotiates and then sits mute, **check telnet before suspecting the
  client, and reboot the board before suspecting the firmware.**

---

## Cross-cutting — do these first

Small, no design risk, and the first one is a correctness-of-information bug.

- [x] **Staleness watchdog.** No status report for 2 s blanks every machine readout
      to `—` and the status bar says `LINK DOWN`. Covers the DRO (both panes), spindle
      RPM, feed, overrides, coolant and the tool offset — anything that is a reading
      rather than a sender-side value. Verified end to end against the simulator by
      cutting its output mid-jog with `link` still set, and against the real board by
      closing the websocket under it: live `X20.000 Y10.000` → all `—` and `LINK DOWN`
      after **2166 ms**, back to live readings **252 ms** after reconnecting.
      **Active Codes is deliberately not blanked** — it is the last modal state we
      were told, not a live reading. Revisit if that turns out to mislead.
- [ ] **Two-state key treatment.** Replace the green "verified" tint with the
      inverse once coverage is high: fade *unimplemented* keys, and mark
      *not-applicable* ones differently — RAPID 5%, and the ATC/chip-conveyor keys
      that depend on hardware this machine does not have. Two states, not one.
- [ ] **RAPID 5% tells the truth.** No grbl equivalent (only 100/50/25). Post
      "not supported on this control" instead of silently doing nothing.
- [ ] **Units.** Offer G20/G21 and show the active unit. Board reports `$13=0`
      (mm); HAAS shops usually run inch.
- [ ] Reinstall the current build on the board and re-verify from `http://<ip>/`.

---

## Phase 3 — Operation mode

Ends when a student can pick a program from control memory and run it without
touching anything that is not on the pendant.

- [ ] **`[LIST PROGRAM]`** — program directory stored by O-number in browser
      storage. This replaces the dev-strip file picker as the way a job is chosen.
- [ ] `[SELECT PROGRAM]` sets the active program; `[ERASE PROGRAM]` removes one.
- [ ] O-number parsing: `O1234` on the first line names the program.
- [ ] **`[SINGLE BLOCK]`** — run one block per CYCLE START. Needs the streamer to
      hold at one line in flight rather than filling the buffer.
- [ ] **`[DRY RUN]`** — run without spindle or coolant.
- [ ] **`[OPTION STOP]`** — honour `M01`.
- [ ] **`[BLOCK DELETE]`** — skip `/`-prefixed lines. `prepare()` in `grbl.js`
      currently drops them unconditionally; make it conditional.
- [ ] Timers pane: cycle time, last cycle, parts counter.
- [ ] Finish the Overrides group — rapid and spindle override keys are wired but
      unconfirmed; verify each byte actually moves `Ov:` in the status report.
- [ ] Add every key that now works to `VERIFIED` in `keys.js`.

## Phase 4 — Setup mode

The phase with real design in it. Do this before phase 5.

- [ ] **Work offsets pane** — G54–G59 plus G59.1–G59.3 (which back HAAS
      `G154 P1`–`P3`). Read with `$#`, write with `G10 L2 P<n> X.. Y.. Z.. A..`.
- [ ] **`[PART ZERO SET]`** — write current machine position into the highlighted
      work offset. The single most-used setup key on a real HAAS.
- [ ] **Tool offsets pane** — a tool table the *sender* owns, because the board has
      `N_TOOLS 0` and base GRBL has only dynamic TLO. Persist it in browser storage.
- [ ] **`G43 H<n>` → `G43.1 Z-<offset>`** translation on the outgoing stream, so
      programs written for a HAAS run on a board with no tool table.
- [ ] **`[TOOL OFFSET MEASURE]`** — record tool length during setup.
- [ ] Data entry into the active (white) pane: type a value, `[WRITE/ENTER]`
      commits. This is the interaction the whole 13-pane model exists for.
- [ ] Active Codes pane from `$G` (already parsed), Active Tool, Coolant panes.
- [ ] `[ZERO RETURN]` group: `ALL` → `$H`, `HOME G28` → `G28`, `ORIGIN`, `SINGLE`.
      **`$H` cannot be confirmed on this board** — homing is untested there. Wire it,
      test against the simulator, and mark it unverified until switches exist.
- [ ] DIST TO GO — compute from the running block's target.
- [ ] OPERATOR readout — a sender-side zeroable display; currently mirrors machine.

## Phase 5 — Edit mode and MDI

The fiddliest behaviour in the project. Budget accordingly.

- [ ] **Word-level cursor.** The HAAS cursor selects a g-code *word* (address +
      value), not a character. Everything below depends on getting this right.
- [ ] `[INSERT]` — insert a word after the cursor.
- [ ] `[ALTER]` — replace the selected word.
- [ ] `[DELETE]` — remove the selected word.
- [ ] `[UNDO]` — at least one level, ideally a stack.
- [ ] Cursor group finally does something: arrows move by word, `[HOME]`/`[END]`
      to first/last block, `[PAGE UP]`/`[PAGE DOWN]` by screen.
- [ ] **`[MDI/DNC]`** — type a block into the input bar, `[WRITE/ENTER]` executes it.
- [ ] Alpha and numeric keys type into the active pane, not just the input bar.

## Phase 6 — Hardware and install

- [x] WebSocket to the ClearCore (`webui-v3`), verified
- [x] Install to SD `/www`, served from the board, verified
- [ ] **Web Serial against real hardware** — the code path exists and has had a bug
      fixed by inspection, but no USB board has ever been plugged in. ClearCore
      enumerates as `2890:8022`.
- [ ] Alarms pane: map `ALARM:N` / `error:N` to HAAS-style alarm text, showing both
      the grbl code and the plain-English cause. Good teaching value.

---

## How to work on this

- **Blocked? `/dm` the owner.** Never route around an obstacle — see the top of
  this file. This outranks every other rule here.
- **Run it and look.** Every real bug found so far came from driving the app in a
  browser, not from reading code. Tests catch regressions; they have not caught a
  single one of the design bugs.
- **The simulator is the primary test target.** It needs no hardware and it is what
  a classroom seat uses. If it only works against the board, it is not done.
- **`npm test` must stay green.** Add a check for anything non-trivial. Do not add
  a test per function.
- **Do not tint a key `VERIFIED` until it is wired *and* exercised** by a passing
  test or observed working end to end. The tint is a claim; keep it honest.
- **Never hardcode the board address.** It resolves `?board=` → served-from-host →
  remembered. A fixed IP goes stale and does not belong in a public repo.
- **Commit ceremony:** stage named paths only (never `git add -A`), invoke the
  `commit-review` skill (it writes the gate marker — never `touch` it), trailer is
  exactly `Co-Authored-By: Claude <noreply@anthropic.com>`. Push only when asked.

## Hard-won facts

Things that cost real time to discover. Do not re-derive them.

- **The websocket needs subprotocol `webui-v3`.** Without it the handshake
  completes and nothing passes in either direction, with no diagnostic.
- **`ok` means buffered, not executed.** grbl acks when a block enters the planner.
  A job is not finished until the machine reports `Idle`.
- **`Ln:` cannot drive the running-block highlight.** It counts blocks since
  power-up, not source lines, unless the program carries `N` words. Use acked lines
  minus queued blocks, from `Bf:` and the planner size in `[OPT:]`.
- **RX buffer is 1024 on this board, not the classic 128.** Read it from `[OPT:]`.
- **The simulator must defer M-codes to execution, not parse.** The whole program
  buffers in milliseconds; applying `M5` at parse time stopped the spindle before
  the first cut.
- **The simulator must never deliver output on the caller's stack.** A synchronous
  `ok` made the streamer recurse until the stack blew.
- **Advance the simulator by real elapsed time,** clamped. A fixed slice per tick
  ran at a fortieth speed when the browser throttled a background tab.
- **Guard websocket sends on `readyState === OPEN`.** `link` is set before the
  handshake finishes and `send()` throws on a CONNECTING socket.
- **`localStorage` throws where storage is blocked.** At module scope that is a
  blank page, not a degraded feature.
- **Chrome caches ES modules.** `npm run dev` uses esbuild's server, which sends no
  cache validators, so an ordinary reload picks up edits.
- **The board's HTTP sends `Access-Control-Allow-Origin: *`,** so a dev server can
  talk to it directly. Serving from the board is same-origin anyway.
- **Web Serial needs a secure context.** Available on `localhost`, absent on the
  board-served page over plain HTTP.
- **`npm run dev` exits the moment stdin closes.** esbuild's serve mode stops when
  it loses stdin, so launching it from a non-interactive shell returns instantly
  with `[serve] stopped automatically`. Hold stdin open: `sleep 100000 | npm run dev`.
- **Test with the browser tab in the foreground.** Chrome throttles a hidden tab's
  timers to about 1 Hz, and to once a *minute* after five minutes hidden. Both the
  simulator and the watchdog are `setInterval`-driven, so a backgrounded tab makes
  the machine look dead and stretches the 2 s watchdog to 4 s or worse. Half an hour
  went into a "watchdog will not trip" that was `document.hidden === true`.
- **`connect()` must let go of the previous transport.** It did not, so every
  reconnect left the old one alive with its callback still wired here: an orphaned
  simulator kept pushing `Idle|MPos:0,0,0,0` at 4 Hz and overwrote the readings from
  the machine actually connected. The DRO sat at `0.000` through a jog that had
  really happened. Fixed, and it is exactly the class of lie the watchdog exists for.
