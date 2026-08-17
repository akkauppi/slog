# Community project plan

Status: agreed direction; implementation is planned in incremental slices.

Current handoff: [`community-project-status.md`](community-project-status.md).

This document describes how the current single-installation sauna logger can
become an approachable reference build and an open community dataset. It is a
roadmap rather than a description of features that already exist. The current
firmware and command-line workflow remain documented in the root `README.md`.

## Outcome

The community project will have two connected parts:

1. A reproducible reference logger built from a Seeed Studio XIAO ESP32-C3 and
   eight powered DS18B20 probes at fixed 20 cm (7.9 in) intervals.
2. A local-first website that can flash and commission the logger, retrieve and
   analyze logs, collect contextual metadata, and prepare a reviewed public
   contribution.

The main path is intended for a basic maker. Soldering and physical assembly
are acceptable requirements; editing C++, installing PlatformIO, or using a
Python command line are not. The source build and Python tools will remain as
advanced and fallback paths.

A successful first release lets a new builder go from parts to a validated
report without editing source code. It also lets them publish a privacy-reviewed
run that another person can reproduce from the original `.slog` data and its
versioned metadata.

## Invariants

The redesign must preserve the logger's existing safety and data-integrity
properties:

- Probe 1 is top/farthest and probes descend toward the ESP at 20 cm intervals.
  A probe is identified by its DS18B20 ROM address, never discovery order.
- The powered three-wire 1-Wire bus remains on XIAO D2 / ESP32-C3 GPIO4.
- Sampling remains every 10 seconds. The automatic trigger remains 30 seconds
  above 40 C (104 F) at any valid probe.
- Automatic cooling completion still requires probe 1 and at least six valid
  probes. The 12-hour cap and power removal remain valid endings.
- Valid CRC-protected blocks survive incomplete writes. Interruption and
  unknown-duration power gaps remain explicit, and analysis never invents the
  missing time.
- LittleFS is never formatted automatically. Raw device logs are never deleted
  until a transfer CRC has validated and a local raw copy has been preserved.
- Wi-Fi stays disabled. Browser management and publishing happen over USB and
  on the user's computer.
- RTC selection remains an ESP-IDF configuration concern. The external
  32.768 kHz source and runtime fallback diagnostics remain intact.
- `board_build.partitions = partitions.csv` remains mandatory, and generated
  partition binaries are decoded and checked whenever build settings change.

## Current foundation and blockers

The repository already has a strong binary log format, power-loss recovery,
USB retrieval, a tested Python parser, interactive offline reports, and an
example real-world dataset. These should be evolved rather than replaced.

Before inviting community builders, the following blockers need correction:

- The eight owner-specific ROM addresses are hard-coded separately in sample
  acquisition and log descriptors. `sensor-map.json` is not consumed by the
  build, so a cloned firmware image cannot work with another builder's probes.
- The documented mapping utility expects ROM-address temperature telemetry that
  the current firmware does not emit. There is no separate discovery firmware
  environment, so the documented commissioning path is not currently usable.
- Firmware automatically deletes the oldest session to reclaim its reserve,
  without knowing whether that session was downloaded. This conflicts with the
  raw-data preservation rule.
- Setup assumes a pre-existing repository virtual environment and omits a full
  BOM, mechanical design, tested harness, cross-platform installation path,
  safety guide, troubleshooting flow, and calibration procedure.
- There is no public metadata schema, global run identity, browser utility,
  catalog, contribution policy, CI release pipeline, or explicit license.

## Development workflow

Keep `main` buildable and use one short-lived branch and pull request for each
coherent delivery slice. Do not accumulate the redesign on a long-lived
`community-redesign` branch.

- Start every slice from the latest `origin/main`. Use descriptive branch
  prefixes such as `docs/`, `firmware/`, `web/`, and `data/`; automation-created
  branches may use `agent/`.
- Open a draft pull request while a slice is under active development so its
  scope, tradeoffs, and checks are visible. Mark it ready only when its relevant
  automated checks pass and any required hardware verification is recorded.
- Keep commits intentional and PRs small enough to review and revert as one
  behavior change. Avoid mixing unrelated cleanup into a slice.
- Merge a completed slice before starting its dependent successor, then branch
  again from the updated `main`. Use an issue or milestone—not a shared feature
  branch—to track the overall community-project roadmap.
- Require the Python tests and PlatformIO build for firmware changes. Add web,
  schema, and generated-partition checks as those subsystems are introduced.
  Hardware upload and serial validation remain explicit, separately recorded
  release checks.

## Delivery slices

### Slice 0: document the direction

- Keep this roadmap current as decisions change.
- Link it from the main README.
- Treat later slices as planned behavior, not existing capability.

### Slice 1: preservation and generic commissioning

- Remove automatic retention deletion. Keep a reserve large enough for the
  maximum 12-hour session and refuse to start a new run when that reserve is
  unavailable. Manual deletion remains an explicit post-download operation.
- Replace compile-time probe arrays with one runtime configuration used by both
  acquisition and log descriptors.
- Store configuration in two versioned NVS slots. Each record contains a
  generation, the eight ordered ROM addresses, the reference-geometry ID, and
  a CRC. Stage and validate a complete record before activating it so power
  removal cannot destroy the last valid mapping.
- Do not start logging with a missing, duplicate, invalid, or ambiguous mapping.
  Unconfigured firmware only exposes discovery and setup functions.
- Add a versioned line-oriented USB protocol for device information, discovery,
  staged mapping, and configuration backup/restore. Keep the existing `LOG`
  commands backward compatible.
- Extend status with protocol version, firmware version and source commit,
  partition-layout ID, running OTA slot, configuration state, discovered probe
  count, and mapped-valid count.
- Update the Python mapper to use the same protocol as the browser. The primary
  assembly path identifies each newly connected probe; a warm-one-probe path
  remains available for an already assembled harness.

Planned configuration commands are `CFG SCAN`, `CFG BEGIN`, `CFG SET`,
`CFG COMMIT`, `CFG ABORT`, and `CFG GET`. A separate `SYS INFO` response will
advertise protocol and release compatibility.

### Slice 2: reproducible hardware and releases

- Publish an exact bill of materials with tested substitutes, cost and time
  estimates, a wiring diagram, harness topology, probe labels, strain relief,
  enclosure guidance, and a printable 20 cm (7.9 in) placement template.
- Document a low-voltage-only safety boundary. There will be no mains or heater
  integration. The controller and power source stay outside the hot/steam zone;
  the guide will cover component temperature ratings, condensation, cable and
  probe quality, and water ingress.
- Add a calibration/bath-check procedure. Original readings remain untouched;
  any calibration offsets are metadata and derived analysis is clearly labeled.
- Pin the PlatformIO platform and all dependencies to verified versions.
- Build immutable release artifacts in CI: application, bootloader, partition
  table, initial OTA data, ELF, map, sdkconfig, source commit, checksums,
  dependency/SBOM information, and build provenance.
- Decode every generated `partitions.bin` in CI and assert that NVS, both OTA
  slots, LittleFS, and the core-dump partition match `partitions.csv`.

The canonical technical documentation will be English, with a Finnish
quickstart and a documented translation workflow. Forms and human-facing pages
will accept and display metric and imperial units. Machine-readable schemas
store only canonical SI values to prevent divergent copies: meters, cubic
meters, kilograms, kilowatts, liters, and degrees Celsius. The selected display
system is primary and the alternative is shown in parentheses.

### Slice 3: browser device console

Build one static HTTPS application in this repository. The proposed stack is
Astro and TypeScript for the site, with Preact for the interactive console.
Dependencies and plotting assets are pinned and self-hosted. There is no
analytics or automatic upload.

The console will provide:

- A factory/recovery installer using Espressif's `esptool-js`. It writes the
  four images and offsets generated by `flasher_args.json`, with whole-flash
  erase disabled. It never uses a padded merged image that could overwrite NVS
  or data partitions.
- Power-loss-safe routine updates over the running firmware's USB serial link.
  The device writes only `firmware.bin` to the inactive OTA slot, validates the
  image and SHA-256, selects it only after a complete transfer, and uses ESP-IDF
  rollback for a failed new application. Updates are rejected during an active
  session and never enable Wi-Fi.
- A guided probe-discovery and mapping wizard, configuration backup, explicit
  first-use filesystem initialization, and a preflight health check.
- Session listing and retrieval. A file is offered for saving only after the
  declared byte count and transfer CRC agree. The UI never overwrites an
  existing local file and has no session-delete or core-dump-erase controls in
  its first release.
- Local `.slog` import, charts, thermal map, comparison, CSV and report export,
  metadata entry, and creation of a submission bundle.

The planned wired update starts with
`FW BEGIN size=<bytes> sha256=<hex>`, followed by sequence-numbered 1 KiB binary
frames with CRC32 and acknowledgement/retry, then `FW COMMIT`. Telemetry is
suspended during transfer. A partial image is never selected for boot.

Hardware access will officially support current desktop Chrome or Edge on
Windows, macOS, and Linux. Web Serial requires HTTPS and is not available in
every browser. File-only analysis will therefore work independently in other
modern browsers, including mobile browsers, and the Python tools remain the
fallback. Useful implementation references are:

- [Espressif esptool-js](https://github.com/espressif/esptool-js)
- [Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API)
- [ESP-IDF OTA documentation](https://docs.espressif.com/projects/esp-idf/en/stable/esp32c3/api-reference/system/ota.html)
- [Seeed XIAO ESP32-C3 recovery procedure](https://wiki.seeedstudio.com/XIAO_ESP32C3_Getting_Started/)

### Slice 4: browser analysis and metadata

- Port binary parsing and pure analysis math to a TypeScript core running in a
  Web Worker. Differential fixtures must produce the same results as the Python
  implementation.
- Preserve parser recovery semantics: reject an invalid header, stop at the
  first torn or CRC-invalid trailing block, retain all earlier valid blocks,
  accept a missing footer as interrupted, and keep power gaps unknown.
- Add a strict ingest wrapper around the recovery parser for size limits,
  unsupported formats, duplicate hashes, malformed chains, bytes after a valid
  footer, and unsafe presentation content. A missing footer or torn/CRC-invalid
  final block remains an accepted power-loss case with explicit recovery flags.
  The curator and CI always re-parse raw data and never trust a
  browser-generated summary.
- Keep `.slog` v1 and v2 unchanged for the first community release. Community
  context lives in a versioned `submission.json` sidecar rather than risking
  the existing raw format.

Each submission has a global UUID, a pseudonymous installation UUID, the CC0
license declaration, public-raw consent, and an explicit ordered list of raw
segments. Each segment records its filename, SHA-256, device-local session ID,
and continuation relationship. Local session numbers are never treated as
globally unique and chains are never inferred by placing files from different
devices in one directory.

Required metadata permits `unknown` where a public-sauna visitor cannot obtain
the information:

- country and optional broad region, never an exact address or coordinate;
- sauna archetype, indoor/outdoor context, internal dimensions or volume, and
  ceiling height;
- heater energy and design, rated output when known, stone mass, and optional
  make/model;
- absolute probe-column height or ceiling offset and its horizontal relationship
  to the heater and benches;
- ventilation category;
- observation start/end conditions, approximate run date, attribution choice,
  and explicit CC0/public-raw consent.

Optional context includes construction and insulation, glass area, bench
heights, inlet/outlet locations, controller setting, outdoor temperature, wood
loads, occupancy bands, door openings, löyly events, and calibration results.
Events refer to a particular segment and relative second. No event can bridge
an unknown power gap.

### Hot-start and observation-window runs

Hot starts are first-class measurements. A logger powered on in an already-hot
public sauna continues to use the normal automatic 40 C (104 F), 30-second
trigger. No special firmware start mode is required.

Metadata records `start_condition` as `cold`, `warm`, `already_hot`, or
`unknown`. The browser may suggest a value from retained pre-trigger coverage
and initial temperatures, but the contributor confirms it. End context records
whether cooling was observed, the logger was intentionally removed while hot,
power was lost unexpectedly, or the condition is unknown. These annotations do
not rewrite the device's footer or interruption status.

Cold probes carried into a hot room have their own settling transient. Analysis
will estimate a stabilization point from smoothed per-probe slopes and common
warming behavior. The estimate is versioned, includes a confidence level, and
can be corrected by the contributor. If no defensible point is found, it stays
unknown. Every raw sample remains visible; only clearly labeled steady-state
metrics may use the post-stabilization window.

Hot-start analysis uses left-censored semantics:

- A threshold already exceeded at the first observation is reported as
  `before_observation`, not as a crossing at the first sample.
- Observed time above that threshold is a lower bound.
- Heating time is unavailable unless the heating phase was actually captured.
- Peaks are labeled as observed maxima rather than assumed whole-cycle maxima.
- Steady-state, stratification, and vertical-profile comparisons remain valid
  when their required observation window and geometry are present.

Coverage is reported on separate axes: heating observed, steady state observed,
and cooling observed. A hot-start run is not downgraded merely because it was
not intended to capture heating or cooling.

### Slice 5: curated public catalog

The initial catalog is generated as a static site rather than backed by a
custom database:

1. The browser validates locally and shows exactly what will be public,
   including the stable probe identifiers contained in the raw download.
2. It produces a ZIP with untouched `.slog` files, `submission.json`, hashes,
   and reproducible derived CSV, preview, and `summary.json` artifacts.
3. It opens a prefilled GitHub submission issue; the contributor attaches the
   ZIP.
4. CI and a curator revalidate integrity, schema, privacy, and comparability.
5. Accepted bundles are preserved through a moderated Zenodo Community. The
   catalog stores lightweight summaries and stable archive/DOI links.

Catalog pages will filter and compare by sauna and heater type, volume, power
density, construction, ventilation, broad region, observation coverage, and
quality metadata. Comparisons expose probe geometry and never silently treat
different absolute placements as equivalent. Ordinary pages and APIs omit
probe ROMs even though the consented original raw download remains public.

Quality and usefulness are represented by independent badges rather than one
ranking:

- integrity validated;
- reference hardware and protocol;
- geometry documented;
- heating, steady-state, and cooling coverage;
- context complete;
- calibration documented.

The existing example run will seed the catalog. Community incentives should
include an immediate useful personal report, optional contributor credit,
stable dataset citations, build replications, documentation and translation
credit, and themed comparisons such as wood versus electric heaters or
ventilation arrangements. The project will not reward hottest-sauna or
fastest-heating leaderboards.

## Governance and licensing

Before accepting outside contributions, add:

- Apache-2.0 for firmware, web, and analysis software;
- CERN-OHL-P-2.0 for hardware design files;
- CC BY 4.0 for project documentation;
- CC0 for contributed measurements and catalog metadata;
- contribution and code-of-conduct documents, security guidance, issue and pull
  request templates, and maintainer review rules.

Public submissions use a pseudonymous installation identity, country or broad
region, and a month-level date by default. Exact location, exact wall-clock
time, occupant identity, and health information are outside the normal schema.
Raw `.slog` publication requires a specific warning and affirmative consent
because it contains stable probe ROM addresses.

## Verification and release gates

Every implementation slice keeps the existing required checks:

```sh
.venv/bin/python -m unittest discover -s tests -v
.venv/bin/pio run
```

Additional automated coverage will include:

- NVS configuration validation, duplicate/invalid ROMs, and power cuts at every
  staging and activation point;
- proof that low storage never automatically deletes a session;
- Python/TypeScript golden parity for v1/v2 files, the real example log, every
  truncation offset, bad CRCs, missing probes, and continuation chains;
- mocked Web Serial with arbitrary chunks, interleaved telemetry, permission
  denial, disconnects, retries, and transfer CRC/size failures;
- OTA interruption before and after every frame and commit boundary, including
  rollback of a new application that fails its startup self-test;
- metadata schema, SI/imperial conversions, privacy redaction, HTML escaping,
  duplicate files, global/local ID collisions, and deterministic catalog
  generation;
- hot-start classification suggestions, left-censored thresholds, settling
  estimates and overrides, and coverage-specific comparison behavior;
- partition-binary decoding and equality with the committed partition table.

Hardware release checks cover factory flash, commissioning, healthy status,
download, analysis, and a routine update on the XIAO ESP32-C3 across the
supported desktop platforms. Uploading firmware or opening a hardware serial
port still requires explicit user intent.

## Out of scope for the first community release

- Wi-Fi, cloud-connected logging, or automatic device upload.
- A custom account system, upload backend, or operational database.
- Alternative probe counts, spacings, boards, or third-party CSV formats in the
  comparable reference dataset. Such experiments may be preserved separately.
- Humidity or other new sensing hardware.
- Exact-location maps, occupant tracking, or health claims.
- Automatic deletion, automatic filesystem formatting, or unattended
  destructive recovery operations.
