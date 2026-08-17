# Sauna temperature measurement

Power-loss-resilient session logger for a Seeed Studio XIAO ESP32-C3 and eight
powered DS18B20 temperature sensors. Wi-Fi is disabled. Measurements are
available over USB, while detected sauna sessions are stored in internal flash.

The repository contains the embedded logger, USB extraction tools, CRC-safe log
parser, and self-contained interactive analysis reports. Development invariants
and verification commands for coding agents are summarized in `AGENTS.md`.

The agreed roadmap for turning this into a reproducible DIY build, browser
utility, and curated community dataset is documented in
[`docs/community-project-plan.md`](docs/community-project-plan.md).

The first full sauna run is retained as a de-identified reproducible example.
Like every raw `.slog`, it still contains stable probe ROM identifiers. See
[`docs/runs/2026-08-16-session-1.md`](docs/runs/2026-08-16-session-1.md) for the
observations and commands used to regenerate its CSV and interactive report.

[![Eight probe temperatures from the first full sauna run](data/2026-08-16-sauna/session-1-main-chart.png)](docs/runs/2026-08-16-session-1.md)

## Wiring

The firmware uses XIAO pin `D2` for the 1-Wire data line. Connect every sensor
in powered (three-wire) mode:

- sensor GND to XIAO GND
- sensor VDD to XIAO 3V3
- sensor DATA to XIAO D2
- 4.7 kOhm pull-up from DATA to 3V3 as an initial value

Prefer a linear trunk with short sensor branches. Do not use parasite power.
The final pull-up value may need adjustment for the installed cable length and
topology.

## Commands

PlatformIO is installed in the repository-local Python virtual environment.

```sh
.venv/bin/pio run
.venv/bin/pio run --target upload
.venv/bin/pio device monitor
```

Exit the serial monitor with `Ctrl-C`.

Install the optional offline-analysis dependency once:

```sh
.venv/bin/pip install -r requirements-analysis.txt
```

## Session logging

- Samples are taken every 10 seconds.
- The latest 10 minutes are retained in RAM while idle.
- A session starts after any valid probe remains above 40 C for 30 seconds.
- The pre-trigger readings are committed immediately; later blocks are flushed
  every 10 minutes, limiting sudden-power-loss exposure to the current block.
- A normal session ends after the hottest probe remains below 45 C and at least
  15 C below the session peak for 30 minutes. Probe 1 and at least six probes
  must be healthy for automatic ending.
- Logs use CRC-protected binary blocks. An absent footer marks a power-cut
  session; valid committed blocks remain downloadable.
- Every 10-minute block is opened, appended, flushed, and closed independently.
  An unexpected power cut can therefore lose or corrupt only the block being
  assembled or written; the offline parser stops at the first incomplete or
  invalid block and preserves all earlier blocks.
- If power returns while the sauna is still hot, the new session records the
  interrupted session ID as a probable continuation. A cold reading from at
  least six probes cancels that link.
- The firmware records boot/reset metadata, RTC source and fallback state,
  sensor-health flags, and the ESP32-C3's internal temperature alongside probe
  readings. Wi-Fi remains disabled.

The flash filesystem is never formatted automatically. After installing the
logging firmware for the first time, initialize it explicitly:

```sh
.venv/bin/python tools/logs.py format --yes
```

Inspect and retrieve sessions over USB:

```sh
.venv/bin/python tools/logs.py status
.venv/bin/python tools/logs.py list
.venv/bin/python tools/logs.py download 1 session-1.slog
.venv/bin/python tools/logs.py export session-1.slog session-1.csv
.venv/bin/python tools/logs.py plot session-1.slog session-1.html
.venv/bin/python tools/logs.py report session-1.slog
```

The `plot` result is a self-contained interactive HTML report: it includes raw
and optional 50-second-median traces, a time/height thermal map, hover-linked
vertical profiles, stratification analysis, threshold timing, rapid-warming
candidates, and logger-health information. It works without a network or local
server. When related `.slog` files are in the same directory, continuation
links are followed automatically and unknown power-off intervals are shown as
explicit breaks. Use `--no-chain` to inspect one physical file alone.

Compare complete runs, aligned at their 40 C triggers, with:

```sh
.venv/bin/python tools/logs.py compare session-1.slog session-8.slog \
  --output comparison.html
```

Comparison reports provide a selector for all eight probe heights, shared-scale
thermal maps, and a compact outcome table. Every report embeds its plotting
code and can be archived alongside the original logs.

`status` reports filesystem health, the latest sensor and internal-chip
temperature, RTC source, reset cause, interrupted-session state, and whether a
crash dump is present. If a watchdog crash occurred, preserve the raw dump
before erasing it:

```sh
.venv/bin/python tools/logs.py crash-download crash.bin
.venv/bin/python tools/logs.py crash-erase
```

The raw crash dump can later be decoded with the matching ESP-IDF tools and
firmware ELF. The task watchdog, brownout detector, and flash core dumps are
enabled in the build. ESP-IDF falls back if XTAL32K cannot start; ESP32-C3 does
not provide ESP-IDF's separate crystal-failure watchdog, so the logger samples
the active RTC source continuously and records any fallback for later review.

Downloading never removes the device copy. Delete a session only after its raw
file has been validated and preserved:

```sh
.venv/bin/python tools/logs.py delete 1
```

## Bring-up procedure

1. Connect one sensor and confirm that exactly one ROM address is reported.
2. Label the sensor with that ROM address and its intended height.
3. Add sensors individually, checking the count after each addition.
4. Record the final ROM-address-to-height mapping before installing the probe
   assembly.

ROM addresses, rather than discovery indexes, will be used for the permanent
height mapping because discovery order is not a physical identity guarantee.

## Installation geometry

Probe 1, at the end opposite the ESP32, is the highest probe near the ceiling.
Probes increase in number downward toward the ESP32 at 20 cm intervals. Probe 8
is therefore 140 cm below probe 1. These are relative heights; an absolute
ceiling or floor height can be added later without changing sensor identity.

## Identify probe heights

With the discovery firmware running, start the interactive mapper:

```sh
.venv/bin/python tools/identify_sensors.py
```

The tool learns five ambient samples. Start at the end opposite the ESP32, then
put the probes in hot water one at a time while moving toward the ESP32. The
mapping records position 1 as the farthest probe and position 8 as the probe
nearest the ESP32; installation heights and orientation can be assigned later.
A probe is accepted after it rises at least 3 C and leads every other unmapped
probe by at least 1 C. Partial progress is saved after every identification in
`sensor-map.json`.

## Unattended sauna test checklist

1. Build and upload the firmware, then run `status` and confirm all eight probes,
   `RTC source: external crystal`, and adequate filesystem free space.
2. Download any sessions not already backed up. Keep the XIAO and wiring in the
   coolest practical location; keep the USB power bank outside the sauna.
3. Disconnect serial, power from the power bank, and let the firmware start the
   session automatically after a probe stays above 40 C for 30 seconds.
4. Unannounced power removal is supported. On the next USB connection, run
   `status`, `list`, download every relevant `.slog`, and also download a crash
   dump if one is reported.
5. Run `report`, export CSV, and generate the HTML plot before deleting anything
   from the device. Retain the original `.slog` files for later analysis.
