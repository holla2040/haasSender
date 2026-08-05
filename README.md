# haasSender

A g-code sender whose entire operator interface is a replica of a HAAS mill
pendant, so students learning on HAAS machines can practise the real workflow —
modes, display panes, HANDLE JOG, CYCLE START, offsets, on-control editing —
against a grblHAL machine, a USB GRBL board, or nothing at all.

![haasSender running a program on the built-in simulator](images/screenshot.jpg)

*Mid-cut in `OPERATION: MEM` — spindle at 2400 FWD, coolant on, and the block
under the tool highlighted in both the program pane and the main display. No
hardware attached; that is the built-in simulator.*

Target hardware is the companion [grblhal-clearcore](../grblhal-clearcore) project
(Teknic ClearCore, 4-axis XYZA). Reference for the control's layout is the 2014
Mill Operator's Manual in `reference/`; the pendant photos are in `images/`.

Status: **phase 2 of 6** — transport, protocol and job streaming are verified
against real hardware, and the pendant shell is built: all eight key groups, the
thirteen display panes, the three-mode bar, jog, overrides and running a program.
Offsets, current commands, alarms and on-control editing are phases 4-5.

## Run it

```
npm install
npm test          # 21 tests, no hardware needed
npm run dev       # http://localhost:8000
npm run build     # dist/index.html.gz for the board's SD card
```

`npm run dev` serves on localhost, which is a secure context — so Web Serial works
in development without HTTPS.

## Transports

| | Notes |
|---|---|
| **Simulator** | A virtual grblHAL in the tab. No hardware. This is the classroom mode. |
| **WebSocket** | `ws://<board>:81/`, **subprotocol `webui-v3`** |
| **Web Serial** | 115200 8N1. Chrome/Edge, secure context only. ClearCore is `2890:8022`. |

**The `webui-v3` subprotocol is not optional.** Verified against the board: a
socket opened with no subprotocol, or with `arduino`, completes the handshake and
then passes nothing in either direction, with no diagnostic. With `webui-v3` it is
fully bidirectional. This is worth knowing if you point ioSender or gSender at a
grblHAL websocket and it appears to connect but sits mute.

## Protocol facts measured on the board

Not assumed — read off a live ClearCore running grblHAL 1.1f:

```
[OPT:VNML,100,1024,4,0]   planner 100 blocks, RX buffer 1024 bytes (not the classic 128)
[AXS:4:XYZA]              four axes
<Idle|MPos:…|Bf:100,1023|Ln:187756|FS:0,0|Ov:100,100,100>
$#  → nine coordinate systems, G54…G59.3, plus a per-axis TLO
$13 → 0                   millimetres
```

Consequences the code depends on: the streamer sizes its RX buffer from `[OPT:]`
rather than trusting a constant; `Ln:` is present so the running block comes free;
`G59.1`–`G59.3` can back HAAS `G154 P1`–`P3`; and every HTTP response carries
`Access-Control-Allow-Origin: *`, so a dev server can talk to the board directly.

## Layout

| Path | What |
|---|---|
| `src/grbl.js` | Status/feedback parsing, error and alarm tables, the job streamer |
| `src/transport.js` | WebSocket / Web Serial / simulator behind one interface |
| `src/sim.js` | Virtual grblHAL — no hardware needed |
| `src/keys.js` | The eight key groups, transcribed from figure F2.26 |
| `src/ui/pendant.js` | Panel, left-hand controls and keyboard |
| `src/ui/screen.js` | The thirteen display panes from figure F2.27 |
| `src/haas.css` | Palette sampled from the manual artwork |
| `src/main.js` | State, key dispatch and the render loop |
| `build.js` | esbuild → inline → gzip, with a size budget check |
| `reference/` | Where the HAAS manual goes — see [reference/README.md](reference/README.md) |
| `history/` | Session transcript and design plan |

Full design, the HAAS→grblHAL mapping table and the phase plan are in
[`history/plan.md`](history/plan.md), alongside the full transcript of the session
that produced this project.

## Installing on the board

The board serves `/www/index.html.gz` from its SD card — the slot ESP3D-WebUI
currently occupies. **Back that file up first**; it is the fallback if haasSender
misbehaves on the bench.

```
GET  /sdfiles?action=createdir&filename=www&path=/
POST /sdfiles           multipart, filename /www/index.html.gz
```

## Licence

MIT. haasSender links no grblHAL code — it only speaks the wire protocol.

## On the look

The pendant is meant to match the machine, not merely evoke it. The key layout,
legends and grouping come from figure F2.26 of the manual; the pane geometry from
figure F2.27; and the palette is *sampled* from that artwork rather than guessed —
`#cccbcb` bezel, `#231f20` sub-panels, `#0090c2` cyan, the RESET orange ramp and
the `#ffd200` accent. Re-render the source art at any size with:

```
pdftoppm -f 55 -l 55 -r 600 -png reference/english---mill-*.pdf keypad
```

Two deliberate departures. The roundel badge is **not** the HAAS mark — a lookalike
trainer that carries a real manufacturer's logo raises a trademark question that is
the project owner's to answer, so the placeholder stays until someone decides. And
the EMERGENCY STOP button sends a soft reset (`0x18`) and stops the stream; it is
not a hardware E-stop and the control says so when pressed.
