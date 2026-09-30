# Field readiness and browser release status — 28 September 2026

The commissioned eight-probe logger and companion display are ready for a first
sauna field test without a computer. This acceptance applies to the installed
firmware and the prepared local recovery package. It does not establish that the
hosted browser release contains the same firmware or that browser flashing has
been accepted on the hardware.

## Firmware packages

| Package | Verified version and source | Status |
| --- | --- | --- |
| Installed logger and local portal bundle | `0.4.0-dev`, `dd9da184f236c2173abb4a51373f83fed5251b40` | Current for the accepted field setup; all four image hashes match the manifest and installed build archive. |
| Hosted portal firmware manifest | `0.3.0-dev`, `b0ac9d0e025f51e9cae21b902311b4dd228f11f2` | Older than the field setup; checked on 28 September 2026, Europe/Helsinki. |

The [hosted manifest](https://akkauppi.github.io/slog/generated/firmware/manifest.json)
was checked directly.
No publication or deployment was performed as part of this review. Do not use
the older hosted package to refresh the accepted field logger. The local flasher
uses its manifest-selected, content-addressed images; historical loose binaries
in generated output are not the current installation package.

Documentation-only commits do not change the installed or packaged firmware.
Preserve the verified source identity above; do not relabel existing binaries
with a newer documentation commit. Follow the release-metadata checks for any
future rebuild.

## Hardware acceptance completed

- All eight mapped probes reported valid readings, with the external 32.768 kHz
  RTC selected, sufficient recording reserve and no reported core dump.
- On its intended power bank, the logger entered cold standby after its startup
  live window and delivered two production heartbeats over about 35 minutes.
  Their reported intervals were 900,001 and 899,999 ms, with no logger restart.
- Warming a probe restored ten-second acquisition; recording started after the
  required 30-second hold above 40 °C.
- Following deliberate power removal, session 4 downloaded as a CRC-valid,
  interrupted file with all four initial samples and no parser warnings. The
  three previous recordings remained byte-identical. Both Python and browser
  parsers read the new file successfully.
- Both units subsequently operated on their power banks without a computer.
  Startup, standby, the resting message and KEY navigation through all six
  display views were physically checked.

The logger detects heat, samples and writes local recordings independently of
the receiver. A switched-off or out-of-range display does not prevent recording;
a display started later builds its own chart history from newly received samples.

These checks support the first field outing. Check reception with the actual
sauna door closed and confirm **Recording** after heating. Keep electronics,
connectors and power supplies outside the hot/wet space.

## Field limits and remaining hardware checks

- There is no physical stop/flush control. Removing power during recording can
  lose up to ten minutes of recent readings. Leave the logger powered through
  normal cooling when a completed file is required, and download after the outing.
- This new-firmware hardware test validated the initial durable block and
  interrupted recovery. It did not exercise a later ten-minute block commit or
  the full 30-minute normal-cooling finish; those remain hardware acceptance
  checks despite host-test coverage.
- Actual closed-door radio range, whole-board current and battery runtime remain
  unmeasured. Successful power-bank operation is not a battery-life guarantee or
  proof of CPU light sleep.
- After the USB serial port is closed and the logger enters cold standby,
  reopening the port can time out. For recovery, unplug and reconnect USB only
  when the logger is cold and idle;
  restarting an active logger interrupts recording. The portal still needs a
  clear recovery prompt for this condition.

See [power management](power-management.md) for cold checks, heartbeat timing,
heat detection and the shorter pretrigger window after standby.

## Browser/tool follow-ups before calling the release current

Historical list from 28 September. The October Pages release implements items
1–4, integrates optional radio setup in the main portal, and includes the raw
preheated electric-sauna example. Item 5 remains a physical hardware acceptance
gate; software release checks alone do not satisfy it.

1. Parse and show `recording_ok` and `recording_fault` in Records. The current
   parser ignores both fields, so a mounted filesystem and available reserve can
   appear healthy after a recording failure. Retain raw-file download access.
2. Distinguish an intentionally sleeping radio from a fault. `RADIO RECOVER`
   refusal during standby currently leads to misleading pairing/firmware advice.
   Explain wake-up and add appropriate `POWER STATUS`/wake/profile controls;
   these controls are currently absent from the browser UI.
3. Keep user guidance aligned with cold standby. The README cadence and
   pretrigger descriptions were corrected with this documentation update; browser
   explanations still need to reflect those states.
4. Add the USB reconnection guidance above and verify it with the actual portal.
5. Accept browser-based connection, installation, post-flash identity checks and
   recovery on hardware. Existing field installations used CLI tools; successful
   package validation and host tests do not substitute for this acceptance.
6. Publish a reviewed, tested portal and matching firmware package, then verify
   the hosted manifest and offline-cache behavior. Publication remains separate
   from the accepted computer-free field test and has not been performed here.
