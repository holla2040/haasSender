# aaSender — a HAAS-lookalike g-code sender for grblHAL / ClearCore

## Context

`/home/holla/aaSender` holds two photos of a HAAS mill pendant (`images/haas1.jpg`,
`images/haas2.jpg`) and the 2014 Mill Operator's Manual (96-8200, 404 pp) in
`reference/`. The goal is a browser-based g-code sender whose entire operator
interface replicates that pendant, so students learning on HAAS machines can
practice the real workflow — modes, display panes, HANDLE JOG, CYCLE START,
offsets, on-control editing — against a hobby-class grblHAL machine or nothing at all.

The target hardware is the companion project **`/home/holla/grblhal-clearcore`**
(Teknic ClearCore, SAME53, bare-metal grblHAL, 4-axis XYZA), already bench-verified
with Ethernet, telnet, WebSocket, HTTP, the WebUI plugin, SD job streaming and USB
CDC. It currently serves ESP3D-WebUI v3 from SD `/www`. aaSender is the
HAAS-skinned replacement for that UI.

**Decisions made with the user:**
- Three transports: network WebSocket, Web Serial over USB, and a built-in
  simulator so a classroom seat needs no hardware.
- Full pendant replica — clickable keypad and screen, operated like a real HAAS.
- Scope: operator essentials **plus** programming — EDIT mode, MDI, offset entry.
- Rendering with **Lit** (see the reasoning section).

---

## Verified against the live board

The ClearCore was powered up at `192.168.0.113` during planning, so the transport
design is **measured, not assumed**. Open ports: 23 (telnet), 80 (HTTP), 81 (WebSocket).

```
$I  → [VER:1.1f.20260726:] [OPT:VNML,100,1024,4,0] [AXS:4:XYZA]
      [NEWOPT:ENUMS,RT+,TC,SED,ETH,FS,SD] [FIRMWARE:grblHAL]
?   → <Idle|MPos:111.470,-192.628,5.000,0.000|Bf:100,1023|Ln:187756|FS:0,0|Ov:100,100,100>
$#  → [G54:…] … [G59.3:…] [G28:…] [G30:…] [G92:…]
      [TLO:0.000,0.000,0.000,0.000]  [PRB:0.000,0.000,0.000,0.000:0]
$G  → [GC:G1 G54 G17 G21 G90 G94 G49 G98 G50 M5 M9 T0 F2540 S0.]
$13 → 0   (millimetres)
```

**The load-bearing finding:** the WebSocket carries the grbl stream **only when the
client negotiates the `webui-v3` subprotocol.** With no subprotocol, or with
`arduino`, the handshake completes and then nothing passes in either direction —
verified with both text and binary frames. With `webui-v3` the socket is fully
bidirectional: `$I` sent over it returned its reply over it.

| Measured | Consequence |
|---|---|
| `webui-v3` required for any data flow | The network transport must request that subprotocol. Not optional. |
| Two text frames on connect: `currentID:<n>`, `activeID:<n>` | ESP3D session handshake — filter before the grbl parser. |
| Reports auto-push every 250 ms (`$397=250` already set) | Don't blindly poll `?`. Poll only after ~500 ms of silence; self-tunes across all transports. |
| `Ln:187756` present | Running line number comes free — no sender-side tracking needed. |
| `[OPT:…,100,1024,…]`, `Bf:100,1023` | Planner 100 blocks, RX buffer **1024**, not the classic 128. |
| `[AXS:4:XYZA]` | Position and offset panes are 4-axis. |
| Nine coordinate systems reported (through `G59.3`) | `G59.1`–`G59.3` can back HAAS `G154 P1`–`P3`. |
| `[TLO:0,0,0,0]` | TLO is per-axis, not a scalar. |
| `Access-Control-Allow-Origin: *` on all HTTP responses | No CORS problem even from a laptop dev server. |
| `GET /command?cmd=…` returns only `ok`; output goes to the socket | HTTP is a command sink. Since the socket also accepts writes, **ignore HTTP for commands entirely.** |
| `GET /` serves 93,373 bytes gzipped from SD `/www` | aaSender installs the same way and should fit a comparable budget. |
| `N_TOOLS 0` in `src/grbl/config.h` | Board has **no tool table** — the sender must own it. |
| Repo MIT; grblHAL core GPLv3 | aaSender links no grblHAL code, so MIT is fine. |

Worth reporting to the companion project: a conventional sender (ioSender, gSender)
connecting over WebSocket without `webui-v3` sees a dead socket with no diagnostic.
Out of scope here — aaSender simply negotiates `webui-v3`.

---

## What the control actually looks like

From the 2014 manual (PDF page = printed page + 20). Key pages: **PDF 55** — figure
F2.26, the full keyboard with all eight groups labelled; **PDF 65** — figure F2.27,
the display layout with thirteen numbered callouts; **PDF 66** — the mode bar and
mode table. This is the *late-classic* control, which is what `images/haas1.jpg`
shows — not the older full-screen green display.

**The display is one fixed layout of 13 panes**, not a set of full-screen pages:

```
 1 Mode and Active Display Bar      8 Alarm Status
 2 Program Display                  9 System Status Bar
 3 Main Display                    10 Position Display / Axis Load Meters
 4 Active Codes                    11 Input Bar
 5 Active Tool                     12 Icon Bar
 6 Coolant                         13 Spindle Status / Editor Help
 7 Timers, Counters / Tool Management
```

Two rules drive the whole interaction model, and they are the thing to get right:

- **The active pane has a white background, and it is the only pane you can enter
  data into.** Display keys move that highlight. Everything else is read-only.
- **There are three modes, not a long list.** Setup (`[ZERO RETURN]`,
  `[HANDLE JOG]`), Edit (`[EDIT]`, `[MDI/DNC]`, `[LIST PROGRAM]`), Operation
  (`[MEMORY]`). The bar shows `SETUP: JOG`, `EDIT: MDI`, `OPERATION: MEM` on the
  left and the current display function on the right.

**The keyboard has eight groups** (F2.26): Function, Cursor, Display, Mode, Numeric,
Alpha, Jog, Overrides. The manual's artwork is vector, so
`pdftoppm -f 55 -l 55 -r 600 -png` gives clean reference art at any size.

---

## Rendering: Lit

Not an obvious call, and the reasoning is worth recording because it reversed twice.

The display is a fixed 13-pane layout where roughly 25 scalar fields update at 4 Hz
and one list carries a moving highlight. **Performance does not distinguish any
candidate at this scale** — Lit, Preact, Vue, Svelte, Solid and hand-written DOM are
all far more than fast enough. So the decision rests on build machinery, bundle
size, and fit.

What rules out the naive approach is the active-pane model: data entry happens
*inside* a display that refreshes four times a second. Replacing a pane's contents
with `innerHTML` on each status report destroys the focused input, the caret, and
any text selection — exactly while a student is typing a work offset. Preserving
node identity across updates is therefore a correctness requirement, not an
optimisation. Lit does that as its whole job, and escapes interpolated values by
construction, which also stops a legal g-code comment like `(SETUP: X<0 SIDE)` from
corrupting a pane.

Lit specifically, over the alternatives: it needs **no compile transform** (tagged
templates are ordinary JavaScript), so the build collapses to bundle-and-minify; it
is small, well-maintained, and standards-adjacent, so panes can be real custom
elements. Svelte is the strongest purely technical fit but adds a compiler; Preact,
Vue and Solid are all defensible and would come down to familiarity; canvas would
cost accessibility and text selection to buy a look CSS can give with `text-shadow`
and an overlay. Hand-written surgical DOM updates are genuinely viable too — the
reason to prefer Lit is that the manual state-to-node mapping drifts as the app
grows across six phases, not that it would be slow or incorrect.

**Build:** `esbuild --bundle --minify`, then a short script to inline the result into
`index.html` and gzip it. No JSX means no Vite; add Vite later only if a dev server
with hot reload earns its keep. `python3 -m http.server` on localhost is a secure
context, so Web Serial works in development without HTTPS.

**Size budget:** ESP3D-WebUI is 91 KB gzipped, so **≤150 KB gzipped**, enforced by a
build-script check that fails loudly when exceeded.

---

## Layout

```
index.html
build.js           esbuild + inline + gzip, with the size check
src/
  main.js
  grbl.js          status/ok/error/alarm parsing, error+alarm tables,
                   character-counting job streamer
  transport.js     one interface, three impls: WebSocket | Web Serial | Simulator
  sim.js           virtual grblHAL machine
  haas.js          machine model: modes, work/tool offsets, timers,
                   grbl -> HAAS alarm mapping
  keys.js          the eight key groups from F2.26, key -> action dispatch
  ui/pendant.js    bezel, logo, E-stop, handle-jog dial, keypad
  ui/screen.js     the 13-pane shell, mode bar, active-pane routing
  ui/panes/*.js    one file per numbered pane in F2.27
  haas.css         palette and pendant chrome
test/grbl.test.js  node --test: streamer flow control + status parsing
reference/         2014 Mill Operator's Manual (96-8200)
```

One file per numbered pane, because the manual numbers them and a student will look
them up that way. Everything else stays collapsed until it earns a split.

### Transport interface

```js
{ connect(), send(str), sendRealtime(byte), onLine(cb), disconnect() }
```

- **WebSocket** — `new WebSocket("ws://<ip>:81/", ["webui-v3"])`, `binaryType =
  "arraybuffer"`, decode with `TextDecoder`, drop the `currentID:` / `activeID:`
  handshake lines, split the rest on `\n`. Writes go over the same socket.
- **Web Serial** — `navigator.serial.requestPort()`, 115200 8N1,
  `TextDecoderStream` split on `\n`. Needs a secure context (localhost or HTTPS);
  Chrome/Edge only. The board enumerates as `2890:8022`.
- **Simulator** — same interface, no I/O.

Status acquisition is uniform: if no `<…>` report has arrived for 500 ms, send `?`.
On the ClearCore's auto-push that timer never fires; on serial it becomes a 5 Hz
poll. One rule, three transports.

### Job streaming

The one piece of genuinely non-trivial logic. Character-counting flow control: keep
a queue of the byte lengths of lines sent but not acknowledged; send the next line
only while `sum(pending) + len(next) < rxBuffer`; pop the oldest length on each `ok`
or `error:N`; halt the stream and raise an alarm on `error:N`.

`rxBuffer` is a **calibration knob seeded from the board** — default 128, raised to
the value parsed from `[OPT:…]` / `Bf:` at connect (1024 here). Never a hardcoded
constant.

This gets the project's one required test (`test/grbl.test.js`, `node --test`): feed
a scripted line list plus acks, assert in-flight bytes never exceed the buffer and
every line is sent exactly once.

### Simulator

A JS virtual grblHAL speaking the same wire protocol: `ok` per accepted line,
`<Idle|MPos:…|Bf:…|Ln:…|FS:…>` on `?` and on a 250 ms auto-push, honouring `!` / `~`
/ `0x18` and the override bytes, walking position along each move at the programmed
feedrate, with a way to force a limit alarm so students see the alarm pane work.

No acceleration planner and no lookahead — position is linearly interpolated per
move. Marked with a `ponytail:` comment naming that ceiling.

**Deliberate upgrade path:** compiling grblHAL itself to WebAssembly with a stub HAL
would give students the real parser, real error and alarm codes, and real modal
handling, so a classroom seat behaves identically to the bench machine. That is
strictly better but costs an emscripten toolchain and blows the single-file size
budget, so it loads separately if pursued. The transport interface makes it a
drop-in replacement later — which is much of why that interface exists.

---

## HAAS → grblHAL mapping

Belongs in the repo README too. Real-time byte values from the Grbl v1.1 interface docs.

| HAAS pendant control | grbl / grblHAL |
|---|---|
| CYCLE START | `~` (0x7E), or start the streamer |
| FEED HOLD | `!` (0x21) |
| RESET | soft reset 0x18 |
| EMERGENCY STOP | 0x18 + stop streaming (real E-stop is hardware — say so in HELP) |
| FEEDRATE 100% / +10% / −10% | 0x90 / 0x91 / 0x92 |
| SPINDLE 100% / +10% / −10% | 0x99 / 0x9A / 0x9B |
| RAPID 100% / 50% / 25% | 0x95 / 0x96 / 0x97 |
| RAPID 5% | **no grbl equivalent** — see gaps |
| COOLANT | flood toggle 0xA0 |
| SPINDLE CW / CCW / STOP | `M3` / `M4` / `M5` (0x9E only acts in HOLD) |
| HANDLE JOG + increment | `$J=G91 F<rate> X<inc>`; jog cancel 0x85 |
| ZERO RETURN → ALL | `$H` |
| ZERO RETURN → HOME G28 | `G28` |
| Position: MACHINE | `MPos:` |
| Position: WORK G54 | `MPos − WCO` |
| Position: DIST TO GO | computed from the running block's target |
| Position: OPERATOR | sender-side zeroable display |
| Program display highlight | `Ln:` — confirmed present |
| OFFSET → WORK G54–G59 | `G10 L2 P1..6`, read back with `$#` |
| OFFSET → WORK G154 P1–P3 | `G59.1` / `G59.2` / `G59.3` |
| OFFSET → TOOL length | sender-owned tool table, emitted as `G43.1 Z−<offset>` |
| Alarm status pane | `ALARM:N` / `error:N`, shown with grbl code *and* HAAS-style text |
| Active Codes pane | `$G` modal string |
| MDI | typed block sent directly |
| LIST PROGRAM | programs stored by O-number in browser storage |
| TOOL OFFSET MEASURE / PART ZERO SET | write into the sender's tables, then `G10 L2` |

### Gaps to design around, not paper over

- **RAPID 5%** does not exist in grbl (only 100/50/25). Render the key and have it
  post "not supported on this control" rather than silently lying.
- **Tool table**: `N_TOOLS 0`, and base GRBL has only dynamic TLO. aaSender owns the
  table and emits `G43.1 Z−<offset>` for `G43 H<n>`.
- **G154 P4 and above** have no equivalent. Show the three that exist rather than
  pretending to ninety-nine.
- **Units**: the board reports `$13=0`, millimetres, while HAAS shops usually run
  inch. Offer G20/G21 and display the active unit — the one place a faithful replica
  would mislead a student about the machine underneath it.
- **Tool changer keys** (`[NEXT TOOL]`, `[ATC FWD/REV]`, `[RECOVER]`): the firmware
  advertises `TC`, but behaviour depends on the machine. Render them, wire nothing
  until the hardware story is known.

---

## Build phases

Restructured around the manual's own three modes rather than page-by-page, because
the display is one layout whose panes change with mode.

1. **Pipeline.** `transport.js`, `sim.js`, `grbl.js`, the streamer test, throwaway
   debug output. Ends with: a g-code file streams to the simulator, position advances.
2. **Pendant shell.** `pendant.js`, `keys.js`, `haas.css`, the 13-pane shell, the
   mode bar, and the active-pane-is-white mechanic. Keypad transcribed from F2.26
   and cross-checked against `images/haas2.jpg`. Position pane live; jog works.
3. **Operation mode.** `[MEMORY]`, `[LIST PROGRAM]`, CYCLE START / FEED HOLD /
   RESET, program display with the running block highlighted from `Ln:`, the
   Overrides group, timers pane. Ends with: a student loads a program and runs it.
4. **Setup mode.** `[ZERO RETURN]`, `[HANDLE JOG]`, work and tool offset panes,
   `[PART ZERO SET]` and `[TOOL OFFSET MEASURE]`, Active Codes / Active Tool /
   Coolant panes.
5. **Edit mode.** `[EDIT]` with HAAS word-level INSERT / ALTER / DELETE / UNDO —
   the cursor selects a *word* (address + value), not a character — plus `[MDI/DNC]`
   and the Input Bar.
6. **Hardware and install.** WebSocket to the ClearCore, Web Serial over USB CDC,
   then install to SD `/www` and run from the board.

---

## Verification

- **Streamer logic**: `node --test test/grbl.test.js` — flow control and status parsing.
- **Whole app, no hardware**: serve locally, drive the simulator in Chrome. Every
  pane, mode and key is exercisable this way; this is also the classroom mode, so it
  has to work.
- **Against the real board** (live at `192.168.0.113` during planning): connect by
  WebSocket with `webui-v3`, and by Web Serial to `2890:8022`. Confirm the position
  pane tracks, `$#` populates the offset panes, a jog produces motion, and a job
  streams without a buffer overrun (watch `Bf:`).
- **Installed on the board**: build, gzip,
  `GET /sdfiles?action=createdir&filename=www&path=/`, multipart-POST to `/sdfiles`,
  load `http://<board-ip>/`.
  **Back up the existing `/www/index.html.gz` first** — installing aaSender replaces
  the working ESP3D-WebUI, which is the fallback if aaSender misbehaves on the bench.

### Safety note for bench testing

The board reports `MPos:111.470,-192.628,5.000,0.000`, so it is a real configured
machine, not a bare desk board. Every hardware phase should start with the machine
clear of stock and the spindle off; jog and homing tests come before any job
streaming test.
