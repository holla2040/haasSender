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

All six phases are done except one item that needs a person at the bench. Of 132
keys: **112 work**, **13 can never work** on this control, **7 are not built
yet** — and separately, all five round pushbuttons work. All thirteen display
pages are real, and **nothing sits outside the pendant any more**: the transport
picker, the machine address and the file import all live behind POWER ON, which
is where a machine's power lives.

The seven unbuilt: POWER UP RESTART, F1-F4, and ZERO RETURN's ALL and SINGLE
(homing, untestable without limit switches).

**The one thing left is Web Serial**, which has never seen a USB board and cannot
be tested without someone plugging one in — see phase 6. It is deferred, not
assumed working.

| | |
|---|---|
| Protocol, streaming, three transports | done, verified against the real board |
| Pendant chrome, 13-pane screen, mode bar | done |
| Jog, increments, every override byte, spindle, coolant, RESET | done, confirmed on the board |
| Control memory: LIST / SELECT / ERASE, O-numbers | done |
| Run switches: SINGLE BLOCK, DRY RUN, OPTION STOP, BLOCK DELETE | done |
| Timers: this cycle, last cycle, parts | done |
| Staleness watchdog, inch/metric, three key states | done |
| Work offsets, PART ZERO SET, data entry | done, `G10 L2` P-numbers measured |
| Sender-owned tool table, `G43 H` → `G43.1` | done, verified on the board |
| EDIT word cursor, INSERT/ALTER/DELETE/UNDO, MDI | done |
| Alarms pane with causes and recovery, SHIFT for `$` | done |
| All thirteen display pages | done |
| Web Serial against a real USB board | **deferred — never tested, needs a board plugged in** |

## The bench

- ClearCore at `192.168.0.113`, grblHAL 1.1f, 4 axes XYZA, **no motors and no
  mechanics attached** — it is a bare board on a bench. Motion commands are safe:
  the planner runs and the DRO advances, nothing physically moves.
- Everything on that board is bench-verified **except homing and limit switches**,
  which are built but untested for want of real switches. So `$H` is the one
  mapping in this project that cannot be confirmed against hardware yet.
- The board serves the **current build** from SD `/www` as of 2026-08-05. The
  build it replaced is backed up outside the repo; it is the fallback if a new
  install misbehaves on the bench, and re-uploading it is the same curl command.
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
- [x] **Two-state key treatment.** Three states are drawn, because three are true:
      green = works, faded = can never work (`UNAVAILABLE` in `keys.js`, 12 keys),
      plain = not built yet. Faded covers RAPID 5%, the chip conveyor, the tool
      changer and the programmable coolant. The inversion this item also called for
      is now due and has its own entry under **Still open**.
- [x] **RAPID 5% tells the truth.** Pressing any faded key posts its reason to the
      status bar — `RAPID 5% not supported — this control has 100%, 50% and 25%`.
      One mechanism, so a key never sits mute.
- [x] **Units.** Inch/metric lives on the SETTING page as Setting 9, where a HAAS
      keeps it; cursor ◀ ▶ commands `G20`/`G21` and the pane follows the machine's
      `$G` rather than what we asked for.
      **The trap here was real and is worth not re-stepping in:** grbl reports
      position in whatever `$13` says, and **G20/G21 does not change that.**
      Verified on the ClearCore — `G20` is accepted and the very next `MPos:` still
      arrives in millimetres. So an inch display has to *convert*, not reformat.
      The first cut printed 20 mm as `20.0000` because the operator picked inches.
      `displayScale()` in `screen.js` now converts, seeded from `$13` at connect.
- [x] Reinstall the current build on the board and re-verify from `http://<ip>/`.
      20,461 bytes to SD `/www`, the old build backed up first. Verified running
      from the board: it auto-connects back to itself, all three key states draw,
      RAPID 5% posts its reason, and inch/metric converts. The exact upload
      command — including the two undocumented multipart details — is in README.

---

## Phase 3 — Operation mode

Ends when a student can pick a program from control memory and run it without
touching anything that is not on the pendant.

- [x] **`[LIST PROGRAM]`** — control memory, filed by O-number in browser storage
      and shown in the main display, cursor keys walking it. The file picker is now
      an *import* into that directory rather than the way a job is chosen; picking
      one is done on the pendant.
- [x] `[SELECT PROGRAM]` sets the active program; `[ERASE PROGRAM]` removes one,
      refuses while a job is running, and unloads it if it was the selected one.
- [x] O-number parsing: `O1234` on the first line names the program, filed as five
      digits. A file without one is given the lowest free number and the control
      says so rather than pretending it was in the file. `prepare()` now strips the
      `%` tape wrapper and the O-number line — grbl answers a bare `O1234` with
      `error:20`. Verified running a directory program on the board.
- [x] **The four run switches.** All sender-owned — grbl has no optional stop and
      no dry run — applied by `wireProgram()` at CYCLE START, so the switches that
      govern a cycle are the ones set when it started. The listing always shows the
      file as written; only the wire changes. Active switches show in the icon bar.
      - **`[SINGLE BLOCK]`** one block per CYCLE START. The streamer holds at one
        line in flight, and the release also waits for the machine to leave `Run` —
        grbl acks on *buffering*, so releasing on the ack alone let a quick second
        press chain two blocks into the planner and run straight through them.
      - **`[DRY RUN]`** strips `M3`/`M4`/`M7`/`M8`. Never `M5`/`M9`: a switch meant
        to make the machine safer must not remove the commands that turn things off.
        A bare `S` word is left alone deliberately, so the modal speed survives.
      - **`[OPTION STOP]`** on leaves `M01` in the stream and grblHAL holds on it —
        confirmed, `Hold:0` on the board, CYCLE START resumes and the program runs
        to completion. Off strips the word rather than trusting the firmware to
        ignore it, which would make behaviour depend on the build on the bench.
      - **`[BLOCK DELETE]`** skips `/` blocks and greys them in the listing rather
        than hiding them, so a student can see what the switch is doing.
- [x] **CYCLE START refuses to restart a program that stopped on an error**, and
      says which error and which block. RESET is the acknowledgement that the
      operator has looked; it is also what clears the streamer. It refuses in
      alarm too, and points at the ALARMS page for what clears that.
- [x] Timers pane: THIS CYCLE, LAST CYCLE and a parts counter, off wall-clock time
      so a throttled tab cannot make a cycle look shorter than it was. Only a
      completed cycle counts a part; RESET abandons it. FEED moved to the status
      bar and INC to the icon bar to make room for them.
      **Not persisted** — the counter starts at zero each session. A HAAS keeps its
      M30 counter across power cycles; add that if anyone wants it.
- [x] **Manual sends are refused while a program runs.** The streamer counts acks
      to know how full the controller's buffer is, so a line typed from the keypad
      returns an `ok` it credits against a block still in flight and its estimate
      drifts high until it overruns for real. Refusing is also what the machine
      does — a HAAS will not take MDI during a cycle — and a block sent mid-program
      would queue behind the planner rather than act now, which is not what a
      student pressing it would expect.
- [x] Finish the Overrides group — every byte watched moving `Ov:` on the board:
      feed ±10% and 100%, rapid 100/50/25, spindle ±10% and 100%, and the coolant
      toggle appearing in `A:`.
- [x] Add every key that now works to `VERIFIED` in `keys.js`.

## Phase 4 — Setup mode

The phase with real design in it. Do this before phase 5.

- [x] **Work offsets pane** — nine coordinate systems with a cell cursor, read from
      `$#` and written with `G10 L2 P<n>`. The active one is marked. `G154 P1`–`P3`
      are `G59.1`–`G59.3`, and **the P-numbers were measured on the board**, not
      assumed: `G10 L2 P7` moved `G59.1`, `P9` moved `G59.3`.
- [x] **`[PART ZERO SET]`** — stores the machine position into the highlighted
      cell. It converts: `MPos:` arrives in the report unit and `G10 L2` reads the
      *modal* unit, so in inch mode 30 mm goes out as `1.1811` and reads back as
      30.000 mm. Getting that wrong puts a work zero 25.4× out.
- [x] **Tool offsets pane** — 20 tools, sender-owned because the board is built with
      `N_TOOLS 0`, persisted in browser storage. Shares the OFFSET key with the work
      offsets, which cycles the two pages as the machine's does. A tool that was
      never measured shows a dash, not a zero.
- [x] **`G43 H<n>` → `G43.1`** translation, **emitted as its own block**. A HAAS
      writes `G43 H1 Z50.` on one line; folding the offset into it would put two Z
      words in one block and grbl answers `error:25`. The split keeps both halves
      pointing at the same source row so the highlight still lands right.
      **No sign flip:** the stored number is the machine Z the tip touched at, which
      is exactly what `G43.1` wants. Measured on the board — `G43.1 Z-10` put
      `-10.000` into both `[TLO:]` and `WCO`, and `G49` cleared it.
      Verified end to end: `G43 H3 Z50.` with T03 measured at −20 left the machine
      at Z30.000, which is 50 − 20 exactly.
- [x] **`[TOOL OFFSET MEASURE]`** — stores the machine Z where the tip is now.
      CYCLE START warns when a program asks for a tool nobody measured, rather than
      quietly applying zero — the one number certain to be wrong.
- [x] Data entry into the active (white) pane: type a value, `[WRITE/ENTER]`
      commits. `WRITE/ENTER` is context-sensitive — on a data-entry pane it writes
      the cell, anywhere else it is MDI. A value that is not a number is refused
      rather than silently written as zero.
- [x] Active Codes pane from `$G`, Active Tool (the `T` word out of the same modal
      string — the only place this control can learn it) and Coolant panes.
- [x] `[ZERO RETURN]` group: `ALL` → `$H`, `SINGLE` asks which axis then sends
      `$H<axis>`, `ORIGIN` zeroes the OPERATOR readout. The mode key itself is
      verified — the bar reads `SETUP: ZERO`.
      **The homing keys are NOT in `VERIFIED`** and say so when pressed: this board
      has no limit switches, so `$H` is the one mapping in the project that cannot
      be confirmed.
      **`HOME G28` is verified** — it needs no limit switches, being a move to a
      stored position rather than a homing search, and it was watched taking the
      machine from `X100 Y100` back to zero. It was briefly and wrongly marked
      impossible; see [`history/g28-false-alarm.md`](history/g28-false-alarm.md).
      `ORIENT SPINDLE` is impossible for a real reason: `M19` needs a spindle
      encoder and a grbl machine has none.
- [x] DIST TO GO — computed from the running block, and **null when the block does
      not say**: no axis words, or `G91`, where the target depends on where the move
      began. Dashes rather than a plausible zero.
- [x] OPERATOR readout — `ORIGIN` zeroes it, and it is the sender's own.

## Phase 5 — Edit mode and MDI

The fiddliest behaviour in the project. Budget accordingly.

- [x] **Word-level cursor.** `words()` in `grbl.js`, tested hard, because a
      tokeniser that splits `X-1.5` into three pieces makes INSERT, ALTER and
      DELETE wrong in the same way and the operator finds out by scrapping a part.
      A comment is one word — it is a thing you select and retype, not five.
      **This needed a change underneath it:** `prepare()` now keeps the program *as
      written* — comments, slashes, the O-number line — and everything that has to
      come off before grbl sees a block comes off in `wireProgram()` at CYCLE START.
      The display was showing a stripped program, which is not what a HAAS shows
      and not what a student can edit.
- [x] `[INSERT]` / `[ALTER]` / `[DELETE]` — act on the selected word. DELETE on a
      block's last word removes the block; it refuses to empty the program.
- [x] `[UNDO]` — a 50-deep stack. Every edit goes through one function, so every
      edit is undoable *and* written back to control memory: an editor that can
      change a program but not put it back is a toy.
- [x] Cursor group works everywhere there is something to point at — the EDIT word
      cursor (running on into the next block at the end of one), the offset grid,
      the tool table, control memory, inch/metric.
- [x] **`[MDI/DNC]`** — its own pane with the blocks it has run. An `error:N` is
      pinned to the block that caused it: `M99  error 20: Unsupported or invalid
      g-code`. Verified on the board.
- [x] Alpha and numeric keys type into the active pane — via the input bar, which
      is the entry buffer `WRITE/ENTER` commits into whichever pane is active.
      Offsets, tool lengths, MDI blocks and EDIT words all go in this way.

## Still open

- [x] **The screen is off when the control is off.** Three states, not two, and
      they are genuinely different things:
      *off* — an unlit panel with nothing on it, and every key dead but POWER ON;
      *on, no link* — `LINK DOWN` with every reading blanked, which is the
      staleness watchdog;
      *on and answering* — live.
      Rendered as cold glass with a faint sheen rather than pure black, because a
      black rectangle reads as a broken display instead of a switched-off one.
      There is deliberately no "press POWER ON" prompt: a machine does not have
      one. The panel is dark and one button on it is lit green, which is how anyone
      has ever worked out how to start a machine tool.

- [x] **SEND / RECEIVE / DNC — the machine's own SD card.** grblHAL exposes the
      card on the *grbl stream*, which is worth knowing: `$F` lists, `$F<=` dumps a
      file, `$F=` runs one, `$FD=` deletes. So RECEIVE works over any transport,
      including serial.
      - **RECEIVE** lists the card into the LIST pane, then pulls the highlighted
        file into control memory. Files over 256 KB are refused — browser storage
        is a few megabytes for *everything*, and `github.nc` on this card is 4.19 MB
        on its own — and the refusal points at DNC, which can run it anyway.
      - **SEND** writes the selected program back. The one operation that is *not*
        on the grbl stream: there is no write-file command, only the HTTP endpoint,
        so it needs the network transport and says so on serial or the simulator.
        It strips the O-number line, because the board reads the file with no help
        from this control and answers `O0123` with an error.
      - **CYCLE START on the card page is DNC** — `$F=` hands the whole job to the
        board, which runs it off its own card with no sender in the loop. Nothing
        to drop, nothing to flow-control, and the only way to run a file too big to
        hold in control memory. The mode bar reads `OPERATION: DNC`.
- [ ] **The firmware has its own BLOCK DELETE, SINGLE BLOCK and OPTION STOP.**
      `$B`, `$S` and `$O` toggle them, found in `$HELP Commands`. The three switches
      here are sender-side, on the stated reasoning that "grbl has no optional-stop
      switch" — which is true of grbl and **wrong about grblHAL**. Ours work and are
      verified, but the machine's are more faithful: the parser does the skipping
      instead of this control rewriting the program, and they would apply to a job
      the board runs off its own card, where the sender is not in the loop at all.
      Worth switching to, and worth checking `$S` really means what SINGLE BLOCK
      means before doing it.

- [x] **JOG LOCK** latches a jog key into a continuous move — `$J=` for the axis's
      declared travel (`$130`+, so the move ends where the machine would have
      stopped anyway), cancelled with `0x85` on the next press. Turning the lock
      off mid-move cancels too, or the machine would be running with no key that
      stops it. Watched X run 0 → 33.666 and brake.
- [x] **HANDLE CONTROL FEED / SPINDLE** turn the handle into an override knob, and
      **a click is one percent, not ten** — grbl has `0x93`/`0x94` and
      `0x9C`/`0x9D` for that, measured on the board. The manual is explicit and the
      figure is fixed: *"adjust the feedrate in 1% increments"*. It is **not**
      scaled by the jog-increment keys, which govern axis motion only.
- [x] **The handle scrolls whatever has a cursor.** F2.26: the handle is *"also
      used to scroll through program code or menu items while editing"*. So the
      EDIT block cursor, the offset grid, the tool table, control memory and the
      settings list all take it; a pane with no cursor leaves the handle jogging.
      Routed through `press('up'/'down')` so each pane keeps owning its own cursor.

- [x] **All thirteen display pages are real.** The last three landed together:
      - **CURRENT COMMANDS** breaks the `$G` modal string into named groups with
        what each code means, which is the same information ACTIVE CODES shows
        whole and far more use to a student who cannot yet read a modal string.
        A code the table does not know still gets a row saying so — a page whose
        job is stating what is active must not silently drop one.
      - **PARAMETER / DIAGNOSTIC** lists `$$` as the machine reports it, read-only,
        deliberately uncurated: choosing which ten of ninety settings a student
        "should" see is not a judgement this control should make silently.
        WRITE/ENTER on an empty input bar re-reads them.
      - **HELP** says where the replica stops being a HAAS, which is the thing a
        student moving between the two actually needs. The count of impossible
        keys is read from `UNAVAILABLE` so the page cannot drift from the keypad.
- [x] **The key tint is inverted.** With 103 of 132 live, tinting what works would
      tint nearly the whole panel and say nothing. A working key now looks like a
      key; only the two exceptions are marked — muted for *not yet* (17), faded
      with dimmed legends for *never* (12). Pressing either says which it is, so
      no key on the panel is silent about itself any more.

## Phase 6 — Hardware and install

- [x] WebSocket to the ClearCore (`webui-v3`), verified
- [x] Install to SD `/www`, served from the board, verified
- [ ] **Web Serial against real hardware — DEFERRED, and untested on purpose.**
      No USB board has ever been plugged in. The code path exists and has had one
      bug fixed by inspection, which makes it plausible and unproven, and this
      project's whole ethic is not shipping that state silently — so it is written
      down here rather than quietly assumed to work.
      **It cannot be tested without a person at the bench.** `navigator.serial
      .requestPort()` opens a native port picker that only a human gesture can
      answer; no amount of scripting reaches it.
      **To close it:** plug the ClearCore in over USB (it enumerates as
      `2890:8022`), open `http://localhost:8000`, choose *USB serial* in the dev
      strip and press Connect. Then check the four things the websocket transport
      needed: that `$I` comes back, that the DRO tracks a jog, that a program
      streams without a buffer overrun (watch `Bf:`), and that pulling the cable
      trips the staleness watchdog to `LINK DOWN`.
      **Web Serial needs a secure context**, so this works from `localhost` and
      *not* from the board-served page over plain HTTP.
- [x] Alarms pane: a history, newest first, with the grbl code, the plain-English
      cause **and what clears it** — the half the grbl tables never print. Repeats
      of the same fault fold into one entry, since a machine sitting in Alarm
      re-reports it four times a second.
      **No invented HAAS alarm numbers.** A student at a real HAAS reads `102 SERVO
      OVERLOAD`; this machine has no such code and making one up would teach a
      number that does not exist.
      **It does not clear the alarm for you.** `$X` re-enables motion on a machine
      whose position may be wrong, and a trainer that quietly unlocked would teach
      exactly the wrong reflex. It says what to type.
- [x] **SHIFT reaches the yellow legends**, which is how `$` is typed at all — it
      lives above the 5. Without it there was no way to enter `$X` to clear an
      alarm, or any other `$` command, from the pendant. Built from the key
      definitions so the panel and the keyboard cannot drift apart.

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
- **The SD upload needs two things the API docs do not mention.** The multipart
  file part's filename must be the **full destination path** (`/www/index.html.gz`,
  not `index.html.gz`), and a companion field named `<path>S` must carry the byte
  count. That combination is verified to work; neither was tested in isolation.
  Exact command in README.
- **`Bf:` counts the block under the tool as still queued.** So `acked − queued` is
  the index of the block *being executed*, not of the last one finished. Taking a
  further 1 off — which the running-block highlight did from phase 2 — highlights
  the previous block for an entire program. DIST TO GO is what exposed it: it read
  zero on an axis the machine was visibly moving.
- **`Ov:` and `A:` are missing from most reports, and absence is not a value.**
  grblHAL leaves them out of compact reports and refreshes them every so often;
  measured on the board, flood stayed on through reports carrying no `A:` at all.
  Reading their absence as zero made the coolant lamp and the spindle direction
  flicker off several times a second during a cut, and made the override keys look
  dead for a second or two. Update those fields only when the report carries them
  — an *empty* `A:` is different, that is the machine saying everything is off —
  and send a `?` after an override key so the readout follows within a frame.
- **CYCLE START has three jobs and they must be checked in the right order.**
  Resume a held machine, step in SINGLE BLOCK, or start a program. The hold check
  has to come first: an `M01` hold leaves the streamer *running*, so every other
  check misses it and the key appears dead exactly when the operator needs it.
  Two bugs lived in that ordering — CYCLE START mid-cycle restarted the program
  from the top with the tool in the cut, and after RESET it sent a resume byte to
  a machine with nothing queued instead of starting the job, because the streamer
  still held the old line list. RESET now clears the streamer rather than pausing it.
- **Never conclude "unsupported" from an error message alone.** `G28` was marked
  impossible in this repo on the strength of an `error:20` that reproduced twice
  and then never again; it works fine, and the key now moves the machine. A
  positive result about hardware is proved by watching the machine; a negative one
  cannot be proved by an error at all, because an error has many causes. `$#`
  reporting a `[G28:…]` parameter was evidence against the conclusion and was
  explained away instead of investigated. Full write-up:
  [`history/g28-false-alarm.md`](history/g28-false-alarm.md).
  `M19` really is unsupported — a grbl machine has no spindle encoder, so there is
  nothing for orientation to mean.
- **`$13` and G20/G21 are different questions.** `$13` says what unit `MPos:`
  arrives in; G20/G21 says what the numbers in a *block* mean. Commanding `G20`
  does not change the report — measured on the board. Any inch display therefore
  converts. `$13` can be read back on its own: sending `$13` returns `$13=0`, on
  the real board and in the simulator alike.
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
