# G28 on the ClearCore — a false alarm, and how it got into the repo

**Date:** 2026-08-05
**Conclusion up front:** `G28` works correctly on this board. An earlier claim in
this repository that it was unsupported was **wrong**, was committed, and was
pushed. This is the record of how that happened, because the mistake is more
instructive than the fact.

---

## What was claimed

Commit `75525ce` marked `HOME G28` as a key that *can never work*, with the
reason:

> G28 is not supported by this board — it answers error:20

It also added a "hard-won fact" to `PLAN.md` generalising the point: that `$#`
reports a `[G28:…]` parameter while the command to use it does not exist, so the
presence of a parameter is not evidence the command works.

Both statements were false. The generalisation was worse than the specific
error, because it was stated as a rule.

## What is actually true

`G28` is accepted and it moves the machine. Measured over telnet:

```
> G90 G0 X15 Y8 Z12
ok
> ?
<Idle|MPos:15.000,8.000,12.000,0.000|Bf:100,1023|FS:0,0|Ov:100,100,100>
> G28
ok
> ?
<Idle|MPos:0.000,0.000,0.000,0.000|Bf:100,1023|FS:0,0|WCO:0.000,0.000,0.000,0.000>
```

And through the control's own `HOME G28` key, from the pendant: the machine went
from `X100.000 Y100.000` to `0.000 0.000 0.000 0.000`.

`G28.1`, `G30` and `G30.1` are all accepted too.

**`M19` is genuinely unsupported** — it answers `error:20` every time, without
exception. That is not a firmware gap. A grbl machine has no spindle encoder and
no closed loop to hold an angle, so there is nothing for spindle orientation to
mean. `M19` belongs in `UNAVAILABLE` for the same reason the chip-conveyor keys
do: the class of machine does not have the capability.

## What the failing measurement looked like

Twice, in consecutive shell invocations, `G28` came back `error:20`:

```
=== replay of the earlier sequence ===
G91 G0 A5   -> ok
G90         -> ok
M19         -> error:20
G28         -> error:20

=== G28 alone, twice ===
G28         -> error:20
G28         -> error:20
```

It looked textbook: reproducible on demand, consistent across two different
framings, and with a plausible story attached — `M19` erroring the same way in
the same breath made "this build lacks the parking commands" feel obvious.

It has not reproduced since, across at least six further attempts in different
orders, from a cold connection, after a soft reset, from zero and from a position
requiring real motion.

## What caused it

**Unknown.** That is the honest answer and it is worth stating plainly rather
than papering over with a guess.

Hypotheses tested and rejected:

| Hypothesis | Test | Result |
|---|---|---|
| A stale telnet session poisons the next one | killed `nc` mid-connection, reconnected, sent `G28` | rejected — `ok` |
| Needs a soft reset first | `0x18`, then `$G`, then `G28` | rejected — `ok` either way |
| Depends on machine position | `G28` from zero and from `A5` | rejected — `ok` both |
| Depends on being the first line after connect | `G28` as first line | rejected — `ok` |
| A second concurrent client confuses the stream | no app was connected during the failures | not applicable |

The one circumstance common to both failing runs is that the immediately
preceding `nc` had been killed by `timeout` while still connected — but that is
exactly what the first hypothesis tested, and it did not reproduce.

So: an unexplained, so-far-unrepeatable `error:20`. Recorded here in case it
returns, with enough detail to recognise it.

## Why it got committed

The measurement was reproducible *twice in a row*, which felt like enough. It
was not, and the reason it was not is specific:

**A negative result about hardware needs a different standard of proof than a
positive one.** "This command works" is proved by watching the machine move —
the evidence is unambiguous and self-checking. "This command does not exist"
cannot be proved by an error message at all; it can only be *suggested* by one,
because an error has many possible causes and only one of them is the
interesting one. The two are not symmetric, and they were treated as if they
were.

The tell was there and was ignored. `$#` reported a `[G28:…]` parameter on a
board supposedly compiled without `G28`. That was evidence *against* the
conclusion, and instead of being investigated it was written up as a general
rule — "the presence of a parameter is not evidence the command works" — which
dressed the contradiction up as a lesson. Inventing a principle to explain away
inconvenient evidence is a much worse failure than the original bad reading.

## The rules this leaves behind

1. **Never conclude "unsupported" from an error alone.** Cross-check: does the
   firmware advertise it, does the source have it, does the parameter exist, does
   a different framing of the command behave differently?
2. **Evidence that contradicts a conclusion is a reason to stop**, not a fact to
   be generalised. `[G28:…]` existing should have halted the write-up.
3. **`UNAVAILABLE` in `keys.js` is for properties of the class of machine** — no
   such hardware, or no such command in grbl — not for whatever is failing on the
   bench today. `M19` qualifies. `G28` never did.
4. **A key wired to a command is easy to test end to end.** Press it and watch the
   DRO. That takes seconds and would have caught this before the commit, and it
   is what the project's own instructions say to do.

## Fixed in

`HOME G28` is wired to `G28` again and is in `VERIFIED`, on the evidence of
watching it move the machine. `ORIENT SPINDLE` stays in `UNAVAILABLE` with the
correct reason. The false hard-won fact is removed from `PLAN.md`.
