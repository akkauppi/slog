# Community project status

Last updated: 2026-08-18, Europe/Helsinki.

This is the rolling handoff for the community-project work. The longer-term
design remains in [`community-project-plan.md`](community-project-plan.md).

## Repository snapshot

- Repository: `akkauppi/saunan`
- Remote base: `origin/main` at `3a43bb8`
- Documentation branch: `agent/community-roadmap`
  - published on `origin/agent/community-roadmap`
  - local focused-roadmap commit: `976afad`
  - the safe-retention alignment and this publication handoff follow it
  - draft PR: [#2, Define a focused roadmap for the community sauna
    logger](https://github.com/akkauppi/saunan/pull/2)
- Firmware branch: `agent/safe-rolling-retention`
  - local commit: `e4039b8` (`Implement safe rolling retention`)
  - published on `origin/agent/safe-rolling-retention`
  - draft PR: [#3, Implement power-safe rolling retention for sauna
    logs](https://github.com/akkauppi/saunan/pull/3)

The earlier `agent/document-example-sauna-run` branch belongs to merged PR #1
and must not be reused.

## Chosen direction

- Work in small, short-lived branches with one primary outcome per pull
  request. Finish and merge the retention slice before starting generic probe
  commissioning.
- Do one thing well first: trustworthy eight-height temperature capture and
  comparison. An occupancy switch and structured experience questions remain
  deferred; a later submission may have one optional observation note.
- Treat hot starts as first-class measurements. Heating time is unknown when it
  was not observed; analysis uses left-censored thresholds and separate
  heating, steady-state, and cooling coverage.
- Build one installable offline-first portal for instructions, released
  firmware, commissioning, retrieval, and local analysis. Publishing is an
  explicit online action.
- Start publication with a narrow private inbox, manual review, and a generated
  static catalog rather than contributor accounts or a general CRUD portal.
  Publish periodic curated dataset snapshots to Zenodo for durable DOI-backed
  archiving; do not make each contributor create a Zenodo record.

## Slice 1 implementation status

Safe rolling retention is implemented and committed locally on
`agent/safe-rolling-retention`:

- The device is a bounded rolling store. It reserves 128 KiB immediately before
  a new session, enough for the maximum encoded 12-hour run plus filesystem
  margin.
- Retention happens only at that pre-start boundary. There is no automatic
  deletion at mount, during an active session, or after session completion.
- Only the oldest fully validated finalized logical run is eligible. Firmware
  validates the header, ordered blocks, block CRCs, record count, footer, and
  continuation catalog. Interrupted, corrupt, orphaned, branched, and probable
  continuation data is not retired.
- Linked segments are removed newest first under a CRC-protected NVS run
  journal. A power cut leaves a valid prefix; the same run is resumed before a
  later start even when enough space was already freed.
- Persistent status reports reserve state, deleted run/segment counts, last
  deletion, pending run/segment, session-ID high-water mark, catalog state,
  audit health, and refusal reason. Session IDs are not consumed repeatedly
  while a hot logger remains blocked.
- Manual deletion refuses to orphan a continuation or operate while an
  automatic retirement is pending. Explicit formatting resets continuation and
  retention state; LittleFS is still never formatted automatically.
- There is no standalone field-visible LED signal. A final refusal is visible
  through the USB event/status interface, so important unattended measurements
  still require a preflight status check.

Verification completed:

```text
.venv/bin/python -m unittest discover -s tests -v
11 tests passed

.venv/bin/pio run
SUCCESS
RAM 14,568 / 327,680 bytes (4.4%)
Flash 320,084 / 1,310,720 bytes (24.4%)

git diff --check
passed
```

The host fixtures cover selection of the oldest complete run, whole-chain
newest-first ordering, protected/incomplete runs, a finalized power-cut prefix,
and invalid duplicate/orphan/branched catalogs. They do not emulate LittleFS or
NVS failures. No firmware was uploaded and no serial or hardware test was run.
Hardware fault-injection around each journal boundary remains a release gate.

## Publication status

GitHub CLI authentication is restored for `akkauppi` using SSH. Both branches
are pushed and the two draft pull requests above are open against `main`.
`main` itself was not changed directly. PR #2 is documentation-only; PR #3
keeps hardware verification explicitly pending and must remain a draft until
that work is recorded.

## Start here next session

1. Review the two draft pull requests and their checks:

   ```sh
   gh pr view 2
   gh pr checks 2
   gh pr view 3
   gh pr checks 3
   ```

2. Merge the documentation PR after its rendered Markdown and roadmap scope are
   accepted. Then update the firmware branch from the resulting `main` if
   GitHub reports it behind or conflicted.
3. Before marking the firmware PR ready, test on a XIAO ESP32-C3 with seeded
   complete, linked, interrupted, and corrupt logs. Cut power before/after each
   pending-journal, file-removal, audit-write, and journal-clear boundary;
   confirm no active/interrupted/corrupt run is removed and the intended run
   resumes only at the next start attempt.
4. Record the hardware results in PR #3, rerun its automated checks, and mark it
   ready only when the retention behavior is verified.
5. After Slice 1 is reviewed and merged, branch from updated `main` for Slice 2
   generic probe commissioning. Do not mix commissioning, web flashing,
   analysis, or publication work into the retention PR.

All later work must preserve ROM-based sensor identity, the fixed eight-probe
geometry, 10-second sampling, power-cut recovery, CRC validation, explicit
unknown power gaps, manual filesystem formatting, disabled Wi-Fi, RTC
diagnostics, and the committed partition layout.
