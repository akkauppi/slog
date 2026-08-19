# Community project status

Last updated: 2026-08-19, Europe/Helsinki.

This is the rolling handoff for the community-project work. The longer-term
direction remains in [`community-project-plan.md`](community-project-plan.md).

## Repository snapshot

- Repository: `akkauppi/slog`
- Renamed from `akkauppi/saunan` when the SLOG brand became the public identity.
- Default branch: `main`
- Pull requests #1 through #6 are merged.
- Their short-lived feature branches have been removed locally and remotely.
- GitHub Pages uses the repository's `Portal` Actions workflow and publishes
  **[akkauppi.github.io/slog](https://akkauppi.github.io/slog/)**.
- The GitHub About panel identifies the hosted portal and carries focused
  sauna, logger, ESP32-C3, DS18B20, PlatformIO, Web Serial, and offline-first
  discovery topics.

## Delivered foundation

- The firmware records eight ROM-identified probes at fixed 20 cm intervals,
  preserves complete CRC-valid blocks across power loss, and exposes explicit
  interruption and RTC diagnostics.
- Safe rolling retention reserves space for a full 12-hour session and retires
  only eligible completed logical runs, newest segment first, under a persistent
  journal. Active, interrupted, ambiguous, corrupt, and probable-continuation
  runs remain protected.
- Generic probe commissioning stores the ordered probe map in CRC-protected NVS
  slots and verifies the activated generation after restart. Python and browser
  flows support both assembled-probe warming and connect-one-at-a-time setup.
- The offline-first browser portal can install a commit-identified firmware
  package, verify a running logger, commission probes, inspect retention status,
  CRC-check and preserve records, and guard whole-run removal.
- Firmware installation uses the ESP32-C3's automatic USB download mode by
  default, including for factory-new boards. Physical BOOT instructions remain
  hidden unless automatic connection fails.
- Portal analysis validates raw `.slog` structures locally, keeps unknown power
  gaps explicit, supports reversible linked-run/per-segment views, plots all
  eight temperatures plus the selected probe's derivative, and exports CSV or
  Excel workbooks.
- The first de-identified real-world sauna run remains in the repository with
  reproducible analysis notes and output.
- Repository governance now defines contribution and maintainer review rules,
  a code of conduct, private security reporting, issue and pull request
  templates, code ownership, and automated dependency-update metadata.
- Licensing follows the planned material split: Apache-2.0 for software,
  CC BY 4.0 for documentation, CERN-OHL-P-2.0 for hardware designs, and CC0 for
  measurements and catalog metadata. Vendored code retains its upstream terms.

## Verification state

The merged work has automated coverage for firmware host logic, retention,
probe configuration, USB protocols, portal behavior, service-worker assets,
and reproducible firmware packaging. The latest portal validation recorded:

```text
npm test
10 portal suites passed

.venv/bin/python -m unittest discover -s tests -v
69 tests passed

git diff --check
passed
```

The Pages workflow also performs a fresh PlatformIO build, validates release
metadata and the generated partition package, and deploys only the artifact
built from a push to `main`.

## Remaining release work

- Record hardware fault-injection around retention journal, removal, audit, and
  recovery boundaries. Automated fixtures do not emulate all LittleFS, NVS, or
  sudden-power-loss behavior.
- Publish the exact BOM, harness and mechanical guidance, electrical and sauna
  safety boundaries, enclosure guidance, calibration procedure, and a concise
  cross-platform troubleshooting path.
- Exercise install, commissioning, record preservation, and recovery on the
  supported desktop Chrome and Edge platforms with representative hardware.
- Define the versioned submission metadata, privacy review, contribution
  policy, curated intake, static catalog, and durable dataset snapshots.
- Decide whether routine wired OTA is worth adding after the current guarded
  factory/recovery installer has broader field experience.

## Next coherent slices

1. Finish the reproducible hardware and safety guide, including the remaining
   hardware validation evidence.
2. Stabilize the hosted portal as the public setup and offline-analysis entry
   point, fixing only issues found in real supported-browser/device testing.
3. Design the minimum metadata and private review path for contributed runs;
   keep publishing separate from local analysis and require explicit consent.

All later work must preserve ROM-based sensor identity, the fixed eight-probe
geometry, 10-second sampling, power-cut recovery, CRC validation, explicit
unknown power gaps, manual filesystem formatting, disabled Wi-Fi, RTC
diagnostics, and the committed partition layout.
