# Remaining Haas trainer qualification work

This is the canonical cross-project task list for:

- `/home/holla/haasSender` (`main`)
- `/home/holla/grblhal-clearcore` (`haasSender` branch)

Keep the coupled sender/firmware work here rather than maintaining a second,
potentially divergent TODO in the firmware repository.

## Current baseline

- [x] Implement Haas G28 machine-zero and named-axis behavior, including G49.
- [x] Implement Haas `G10 L10 Pn Rvalue` tool-length behavior in active units.
- [x] Reject the identified Haas/grblHAL M-code collisions before side effects.
- [x] Distinguish M00 hold behavior from M30 cleanup and completion behavior.
- [x] Make Haas-specific operations fail closed without `HAAS parity v0.2`.
- [x] Cover the sender and simulator behavior with the current 101-test suite.
- [x] Build and bench-test the paired firmware on the bare ClearCore.

## Hardware qualification

These require a mechanically complete stage. Do not enable homing or limits on
the current bare-controller setup merely to complete this list.

- [ ] Install and verify home/limit switches, axis directions, travel limits,
  machine-zero convention, and a physical E-stop.
- [ ] Configure homing, hard limits, and soft limits for the completed stage.
- [ ] Exercise bare G28 from safe, nonzero positions and verify every configured
  axis reaches the intended machine zero.
- [ ] Exercise `G91 G28 Z0` and named-axis HOME G28; verify unselected axes do not
  move and tool-length compensation is cancelled.
- [ ] Set the native grblHAL G28 stored-position record deliberately nonzero and
  prove it cannot affect Haas G28 behavior, then restore the record.
- [ ] Starting with real spindle and coolant outputs active, verify M00 turns all
  of them off before Hold and CYCLE START resumes at the following block without
  silently restarting them.
- [ ] Starting with G43/H, spindle, flood, mist, and TSC active, verify M30 ends
  in G49/TLO zero, M5, and all coolant outputs off.

## End-to-end sender checks

- [ ] Add or perform a browser-level test of typed X, Y, Z, and A followed by
  HOME G28, including invalid and multiple-axis input.
- [ ] Verify the M30 counter increments exactly once for streamed M30 and SD/DNC
  M30 programs.
- [ ] Verify M2, normal fall-through, M00, RESET, alarms, reconnects, and repeated
  status frames do not increment the M30 counter.
- [ ] Verify a sender connected to firmware without `HAAS parity v0.2` visibly
  refuses G28, G10 L10, M00, and M30.

## Direct serial and SD/DNC regression

- [ ] Run an SD/DNC fixture covering G28, G10 L10, M00, M30, and every entry in
  `HAAS_COLLISIONS`; compare its observable results with sender streaming and the
  simulator.
- [ ] Confirm each conflicting M-code returns unsupported-command status in check
  mode, raw serial, and SD/DNC without changing overrides, tool state, outputs,
  modal state, or position.
- [ ] Test leading-zero G10 forms, missing P/R, out-of-range tools, extra axis
  words, metric/inch conversion, and preservation of the tool-radius field.
- [ ] Save and restore any tool-table row or coordinate record used by a hardware
  test, even when a test fails partway through.

## Release checklist

- [ ] Review and commit the `src/grbl/gcode.c` change in its nested repository,
  then intentionally update the outer `grblhal-clearcore` submodule pointer.
- [ ] Keep the pre-existing dirty `grblhal-clearcore/src/networking` work separate
  unless its owner explicitly includes it in this release.
- [ ] Run `npm test` and `npm run build` in `haasSender`.
- [ ] Run `pio run` in `grblhal-clearcore` and flash/verify the intended binary.
- [ ] Deploy `dist/index.html.gz` and verify the served file's SHA-256 matches the
  local artifact.
- [ ] Record the firmware commit, sender commit, hardware configuration, test
  results, and any remaining bare-controller limitations in the release notes.
