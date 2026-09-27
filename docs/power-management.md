# Cold standby and connection tests

The logger starts with five minutes of ten-second sampling and live ESP-NOW
updates. After five continuous minutes with all eight readings below 35 °C,
valid probe configuration, usable storage and no recording/commissioning, it
enters cold standby. Any probe at or above 35 °C, any missing probe, or an active
recording keeps/restores ten-second sampling. The existing >40 °C for 30-second
recording trigger is unchanged. Cold polling can delay initial heat detection
by up to 150 seconds; a 35 °C wake threshold often restores full sampling sooner.

In cold standby all eight temperatures are checked every 150 seconds. These
checks do not enter the ten-second pre-trigger ring or raw log. The idle ring
is cleared, then refills when fast acquisition resumes. A start shortly after
leaving standby therefore has a shorter pre-trigger history; no samples are
invented. SLOG V3 and its nominal ten-second recording cadence remain unchanged.

The transition into standby immediately sends a sample announcing standby.
Normal heartbeats follow every 900 seconds; test-profile heartbeats every 300
seconds. Each heartbeat carries fresh temperatures. Deliberately unsent cold
checks still advance acquisition identity, but do not increment missed-schedule
counters. The receiver treats these sequence gaps as sparse delivery, draws
history breaks and labels the last reading's age. Standby expires after the
advertised interval plus 25 seconds; after two intervals plus 60 seconds it is
lost. Duplicates do not renew this deadline.

The ESP-NOW driver stops between cold heartbeats. Driver changes run on the
existing radio worker; an in-flight send and its timeout handling finish before
suspension. Pairing stays in NVS. Restart failures use bounded recovery rather
than silently stopping acquisition. With no connected USB serial host, the CPU
uses timer-triggered light sleep in at most one-second slices between cold
checks. RAM and boot identity are retained and the watchdog remains enabled.
USB serial activity keeps CPU sleep off for diagnostics; radio duty cycling and
sparse checks still operate. No deep sleep or probe power switching is used.

USB commands:

- `POWER STATUS`: profile, state, intervals, USB sleep inhibition and measured
  accumulated CPU sleep time/error count.
- `POWER TEST`: persist five-minute heartbeats and open a five-minute live window.
- `POWER NORMAL`: persist fifteen-minute heartbeats and open a live window.
- `POWER WAKE`: open a live window without changing the saved profile.

Profile changes are rejected while recording or commissioning. Power-up always
opens a live window, so power-cycling an idle logger remains the physical
connection-test action. A display turned on later may wait up to fifteen minutes
for a heartbeat; switch the idle logger off/on for an immediate test. There is
no remote wake command in this release: a powered-down radio cannot hear one.

The defaults select NORMAL. The separate `sauna_power` NVS namespace does not
alter probe or radio configuration. New SAUW status bits 9 (cold standby) and
10 (test heartbeat profile, valid only with bit 9) announce the fixed schedule.
`nominalPeriodMs` remains the active ten-second acquisition period; the standby
bits override cold polling/transmission intervals. Never combine standby with
session-active or synthetic flags. Update both ends together: older displays
ignore unknown status bits and will label long idle intervals as lost.

Measure complete-board current on the intended supply before claiming a battery
life improvement. Check that a power bank stays on during standby. Host tests
cover policy, wire validation and receiver deadlines; actual radio stop/start,
light sleep, USB reconnection and long heartbeat timing require hardware checks.

Implementation uses the installed ESP-IDF 4.4.7 light-sleep API:
https://docs.espressif.com/projects/esp-idf/en/v4.4.7/esp32c3/api-reference/system/sleep_modes.html
