# Coding-agent handoff

This repository is the working firmware and offline-analysis project for an
eight-height sauna temperature logger. The target is a Seeed Studio XIAO
ESP32-C3 using PlatformIO with Arduino built as an ESP-IDF component.

## Non-negotiable behavior

- Probe 1 is the top/farthest probe; probes descend toward the ESP at 20 cm
  intervals. Identity is by DS18B20 ROM address, never discovery order.
- The 1-Wire bus is XIAO D2 / ESP32-C3 GPIO4 and uses powered three-wire probes.
- Sample every 10 seconds. Start after any valid probe stays above 40 C for 30
  seconds. Automatic cooling completion requires probe 1 and at least six valid
  probes; otherwise the 12-hour cap or power loss ends the run.
- Treat power removal at any instruction as normal. Never weaken CRC block
  validation, completed-block preservation, explicit interruption metadata, or
  the rule that the filesystem is not formatted automatically.
- Wi-Fi stays disabled for the sauna logger until explicitly requested.
- RTC slow-clock selection must come from ESP-IDF configuration, not an
  application compiler define. Keep the external 32.768 kHz crystal selected
  and preserve runtime source/fallback diagnostics.
- `board_build.partitions = partitions.csv` is required. The table must retain
  the LittleFS and core-dump partitions; decode the generated `partitions.bin`
  when changing any build or partition setting.

## Verification

Run before handing off firmware changes:

```sh
.venv/bin/python -m unittest discover -s tests -v
.venv/bin/pio run
```

Install offline-report support with:

```sh
.venv/bin/pip install -r requirements-analysis.txt
```

Hardware upload and serial commands require explicit user intent and access to
`/dev/ttyACM0`. A healthy pre-test `status` has `fs=1`, eight sensors,
`rtc_source=1`, `rtc_hz=32768`, and nonzero free bytes.

Raw `.slog` files are the source of truth, but the device is a bounded rolling
store rather than the permanent archive. When space is needed for a new run,
firmware may retire the oldest eligible logical run before that new run starts.
It must reserve enough space for the full 12-hour session, delete linked
segments as one run, protect any interrupted session selected as a probable
continuation, never reclaim space during an active session, and expose
retention activity in status output. Download and CRC-validate raw logs
regularly. Power-linked segments have an unknown-duration gap; analysis must
never invent that time.
