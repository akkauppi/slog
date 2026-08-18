# Community project plan

Status: agreed direction; the logger, commissioning, retention, and local portal
foundation is implemented, while hardware publication and community data work
remain planned in incremental slices.

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

The project will do one thing well before adding extensions: capture, preserve,
analyze, and compare trustworthy temperature measurements. Each delivery slice
and pull request has one primary outcome. Supporting work belongs in that slice
only when it is necessary to deliver or verify that outcome; useful ideas that
do not meet that test are deferred.

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
- LittleFS is never formatted automatically. Raw `.slog` files remain the
  source of truth, while device flash is explicitly a bounded rolling store and
  not the permanent archive.
- Immediately before starting a new session, the logger requires a 128 KiB
  full-session reserve. It may make that reserve only by retiring the oldest
  logical run whose linked segments all have fully CRC-valid contents and valid
  finalized footers. An interrupted run and any run selected as a probable
  continuation are protected.
- Linked segments are retired newest first under a persistent run-level journal
  so a power cut leaves a valid prefix and retirement can resume immediately
  before a later start attempt. Retention never deletes on mount, during an
  active session, or when a session finishes. Persistent status and audit fields
  expose every retirement, pending work, and refusal. If no eligible run can
  make the reserve, logging is refused without deleting another file.
- Wi-Fi stays disabled. Browser management and publishing happen over USB and
  on the user's computer.
- RTC selection remains an ESP-IDF configuration concern. The external
  32.768 kHz source and runtime fallback diagnostics remain intact.
- `board_build.partitions = partitions.csv` remains mandatory, and generated
  partition binaries are decoded and checked whenever build settings change.

## Current foundation and blockers

The repository has a strong binary log format, power-loss recovery, safe rolling
retention, generic probe commissioning, USB retrieval, tested Python and browser
parsers, interactive offline reports, a GitHub Pages portal, and an example
real-world dataset. These should be evolved rather than replaced.

Before inviting community builders, the following blockers need correction:

- Setup assumes a pre-existing repository virtual environment and omits a full
  BOM, mechanical design, tested harness, cross-platform installation path,
  safety guide, troubleshooting flow, and calibration procedure.
- Retention and commissioning have automated coverage, but the repository still
  needs recorded hardware fault-injection and broader cross-platform portal
  verification before a public hardware release.
- There is no public metadata schema, global run identity, catalog,
  contribution policy, curated intake, or explicit project license.

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
- State the single primary outcome in each PR description. If an extension can
  be reviewed, tested, and shipped independently, move it to a later slice even
  when it appears closely related.
- Merge a completed slice before starting its dependent successor, then branch
  again from the updated `main`. Use an issue or milestone—not a shared feature
  branch—to track the overall community-project roadmap.
- Require the Python tests and PlatformIO build for firmware changes. Add web,
  schema, and generated-partition checks as those subsystems are introduced.
  Hardware upload and serial validation remain explicit, separately recorded
  release checks.

## Delivery slices

### Slice 0: document the direction

Status: delivered and maintained by this plan and the rolling status document.

- Keep this roadmap current as decisions change.
- Link it from the main README.
- Treat later slices as planned behavior, not existing capability.

### Slice 1: safe rolling retention

Status: implemented on `main`; recorded hardware fault-injection remains a
release-validation task.

- Require 128 KiB free immediately before opening a session, enough for a full
  12-hour recording plus filesystem margin. Retire runs only at this pre-start
  boundary; never delete on mount, during an active session, or at session
  finish.
- Select only the oldest eligible logical run. Every linked segment must have
  fully CRC-valid blocks and a valid finalized footer. Treat continuation-linked
  segments as one unit, and protect interrupted sessions and probable
  continuations.
- Retire linked segments newest first. Persist a pending run and segment before
  each removal, reconcile the audit after a power cut, and resume that same run
  only at the next pre-start reserve check.
- Persist and report deleted run/segment counts, last deleted identifiers, a
  pending retirement, the session-ID high-water mark, catalog validity, audit
  health, reserve readiness, and the last refusal reason.
- Refuse the new session and preserve everything present when the catalog or
  audit is unsafe, no eligible run exists, or the reserve still cannot be made.
  Manual deletion remains an explicit operation after local preservation.

The primary outcome of this slice is predictable bounded retention without
ever sacrificing an active, interrupted, ambiguous, or probable-continuation
run. It does not change probe commissioning, the log format, or the browser
workflow. Because the device cannot know whether a completed run was archived,
the operating guidance still calls for CRC-validated downloads after every
measurement.

### Slice 2: generic probe commissioning

Status: implemented on `main` for both the Python tools and browser portal.

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

### Slice 3: reproducible hardware and releases

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

### Slice 4: offline-first browser device console

Status: the first portal is implemented as dependency-free static HTML, CSS,
and JavaScript rather than the originally proposed Astro/Preact stack. It
includes guarded factory/recovery flashing, commissioning, records, local
analysis, exports, and guarded whole-run deletion. Routine wired OTA remains
deferred.

Maintain one installable, offline-first static HTTPS application in this
repository. Its dependency-free HTML, CSS, and JavaScript assets are pinned and
self-hosted. After an initial load or installation, the bundled firmware,
commissioning, log retrieval, and local analysis should remain usable without a
network connection once their required assets are cached. Fetching updates, a
future catalog, and future record submission require a connection. There is no
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
  declared byte count and transfer CRC agree. Whole-run removal remains guarded
  by verified preservation or an explicit unverified-copy override, exact-byte
  revalidation, continuation protection, and newest-first ordering. The portal
  has no format or core-dump-erase control.

The primary outcome of this slice is a safe browser path from released firmware
to preserved and locally analyzed `.slog` files. Publishing remains a separate
slice even though it will share the same portal shell.

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

### Slice 5: browser analysis and minimum metadata

Status: local parsing, charts, run/per-segment views, derivatives, and CSV/XLSX
exports are implemented. Submission metadata and publishing are not.

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

The browser provides local `.slog` import, charts, a thermal map, comparison,
CSV and report export. It can prepare the minimum metadata needed to submit a
measurement, but all analysis remains useful without publishing anything.

Each submission has a global UUID, a pseudonymous installation UUID, the CC0
license declaration, public-raw consent, and an explicit ordered list of raw
segments. Each segment records its filename, SHA-256, device-local session ID,
and continuation relationship. Local session numbers are never treated as
globally unique and chains are never inferred by placing files from different
devices in one directory.

Initial metadata is limited to what is needed to interpret or compare the
temperature record. It permits `unknown` where a public-sauna visitor cannot
obtain the information:

- country and optional broad region, never an exact address or coordinate;
- sauna archetype, indoor/outdoor context, internal dimensions or volume, and
  ceiling height;
- heater energy and design, rated output when known, stone mass, and optional
  make/model;
- absolute probe-column height or ceiling offset and its horizontal relationship
  to the heater and benches;
- observation start/end conditions, approximate run date, attribution choice,
  and explicit CC0/public-raw consent.

The first release provides one optional free-text observation note. A
contributor may use it to mention context such as door openings, löyly, or
whether people were present, but none of this is required or converted into a
structured experience score. Calibration results can remain separately labeled
technical metadata because they affect interpretation of the temperatures.

### Temperature data before experience data

The reference logger will not add an occupancy switch for the first community
release, and the submission flow will not quiz contributors about comfort,
health effects, or subjective sauna quality. These would add hardware,
instructions, privacy questions, and ambiguous data before their analytical
value is established. The optional observation note is enough to preserve
useful context while the project learns from actual temperature records.

The metadata format remains versioned so structured events or an optional
experience study can be discussed later. Such an extension should have its own
clear question, consent model, and delivery slice rather than growing out of
the initial temperature workflow implicitly.

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

### Slice 6: private intake and curated public catalog

The public experience is part of the same portal, but the first release does
not need a conventional contributor-account or CRUD application. The catalog
is generated from reviewed records as static pages and data:

1. The browser validates locally and shows exactly what will be public,
   including the stable probe identifiers contained in the raw download.
2. When the contributor explicitly chooses to publish, the portal sends the
   raw `.slog` file or files and a short metadata form to a small private
   submission inbox. No GitHub or Zenodo account is required.
3. The service assigns a receipt ID, checks upload bounds and hashes, and keeps
   the pending submission private. Server-side tooling independently parses
   the raw data and never trusts browser-derived summaries.
4. A curator manually reviews integrity, privacy, consent, metadata, and
   comparability. Accepted records become version-controlled catalog data;
   corrections and withdrawals are curator-assisted initially.
5. The site generator publishes privacy-reviewed summaries, comparisons, and
   consented raw downloads. The original upload remains immutable, while
   metadata corrections retain revision history.
6. Periodically, maintainers publish a curated snapshot of accepted records as
   one versioned Zenodo dataset release. Zenodo provides durable files and a DOI
   for the corpus; it is an archive downstream of intake, not a task imposed on
   each contributor or a separate record for every sauna run.

The inbox is deliberately narrow: authenticated curator access, bounded private
object storage, validation, and status/receipt handling. It is not a general
database editor. The last cached catalog may remain browsable offline, while
new submissions and the latest community data naturally require a connection.

Catalog pages will initially filter and compare by sauna and heater type,
volume, power density, broad region, observation coverage, and quality
metadata. Comparisons expose probe geometry and never silently treat different
absolute placements as equivalent. Ordinary pages and APIs omit probe ROMs
even though the consented original raw download remains public.

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
- exact 128 KiB reserve boundaries, oldest-complete-run selection, linked-run
  retirement, and conservative refusal for invalid, oversized, interrupted, or
  otherwise ineligible catalogs;
- newest-first deletion and persistent journal/audit recovery at every
  power-cut boundary, plus proof that retention never removes files on mount,
  during an active run, or at session finish;
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
- A contributor account system, general CRUD portal, or full operational
  database. Only the small private submission inbox and manual curation needed
  for reviewed publication are planned.
- Alternative probe counts, spacings, boards, or third-party CSV formats in the
  comparable reference dataset. Such experiments may be preserved separately.
- Humidity or other new sensing hardware.
- An occupancy switch, structured occupancy tracking, or a structured
  experience survey. Exact-location maps and health claims are also excluded.
- Retention anywhere except the bounded pre-start policy: no deletion of an
  active, interrupted, ambiguous, or probable-continuation run, and no deletion
  when its catalog or persistent audit cannot be trusted. Automatic filesystem
  formatting and other unattended destructive recovery remain excluded.
