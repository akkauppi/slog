# Web records and analysis workspace

The static portal has three local, reload-free sections: **Prepare** installs
and commissions a logger, **Records** preserves and manages its bounded device
store over USB, and **Analyze** reads raw `.slog` files without a server or
upload. All runtime code and plotting are included in the offline application
shell; there are no charting or storage service dependencies.

## Analyze raw files

Choose one or more `.slog` files in **Analyze**. The browser validates the
header CRC and exposes samples only from complete CRC-valid blocks. Torn or
invalid trailing data is reported and ignored without weakening earlier
blocks. Continuation metadata is grouped only when it produces an unambiguous,
layout-consistent root-to-leaf chain. Missing parents, duplicate IDs, branches,
cycles, and changed probe layouts are shown rather than guessed through.
Valid files in an unsafe component remain available as explicitly isolated
segments. A child whose root is missing keeps its own raw relative timeline and
states that time before the file is excluded; it is never presented as a
complete logical run.

The timeline uses observed logger time. A maximum-duration continuation remains
continuous only when the child records its measured sample-to-trigger delay and
its footer, boot identity, sample interval, and ordered probe layout all agree
with the predecessor; repeated pre-trigger samples are then omitted. Every
other continuation boundary is an explicit unknown-duration gap, and no line
or duration calculation crosses it. The selected probe uses the portal accent
and the other seven stay gray. The table is the accessible source for exact
per-probe peak, mean, missing-sample, and heating-rate summaries.

When multiple valid files are open, **Show segments separately** rebuilds the
analysis so each physical `.slog` is its own selectable view. This is useful
when a hot start or end measurement should be interpreted independently. The
choice is reversible and affects only analysis and export: the files' recorded
continuation metadata is not edited, and device removal still treats linked
segments as one run.

The heating and cooling rate chart shows only the selected probe in °C/min. At
each sample it fits a centered 60-second linear trend, using only contiguous
valid readings. It never fits or draws through a missing reading or an unknown
continuation gap. Its observed-time domain, plot margins, and x ticks match the
temperature timeline above it.

The start summary calls out an already-hot or partially captured start. This is
descriptive, not a claim about the unobserved heating period. Raw `.slog` files
remain the source of truth.

### Export session data

After selecting a run, **Export CSV** downloads one row per committed sample.
It includes compressed observed time, the one-based segment number, session ID,
original session-relative time, an `unknown_gap_before` marker, P1–P8
temperatures, logger chip temperature, and sample status flags. The observed
time column explicitly excludes unknown power-off durations; use the session
and gap columns whenever segment boundaries matter.

**Export Excel** creates a standard `.xlsx` workbook locally with three sheets:

- **Measurements** contains the same sample table as the CSV.
- **Probes** records each P1–P8 relative height and ROM address.
- **Gaps** lists continuation boundaries, their kind, and whether the duration
  is known.

Exports are derived convenience files. Preserve the CRC-checked `.slog` files
as the source of truth.

## Preserve and remove device records

**Records** first verifies `SYS INFO` against the supported sauna logger
identity, then reads `LOG STATUS` and `LOG LIST`. It shows active recording,
free and total space, the full-session reserve, automatic retention history,
and logical continuation chains. Downloads and analysis transfers are disabled
while a session is active.

There are two download paths:

- **Save and verify** uses `showSaveFilePicker`, downloads and CRC-validates
  the device bytes, writes the selected file, then reads it back and compares
  it byte for byte. Only that manager-issued receipt can authorize removal.
- **Quick download** works where the file-system picker is unavailable. The
  bytes are still CRC-validated and may be analyzed, but the browser cannot
  prove where the download was saved. After every unverified segment in a run
  has been Quick downloaded, the portal offers a clearly labeled removal
  override instead of presenting the copies as verified.

Normal removal requires an unused verified-save receipt for every segment of an
unambiguous logical run. The override requires a CRC-validated Quick download
for every segment without such a receipt and an explicit confirmation that one
or more saved copies were not verified. Both paths re-read the current device
file and compare it with the earlier validated bytes immediately before
deletion. A confirmation names the entire chain, and segments are removed
newest to oldest. The portal also blocks both paths during recording,
unresolved commissioning/restart
state, journaled automatic retention, an unsafe catalog, or a probable
hot-start continuation. It does not offer format, bulk erase, or crash-dump
erase.

Receipts exist only in the connected page. Quick-download override state is
also temporary and is cleared on catalog refresh, disconnect, or reload. A
later visit must repeat the relevant download or preservation operation;
ordinary browser download history is intentionally not trusted.

Switching portal sections, applying a service-worker update, closing the page,
or disconnecting is blocked during a transfer or removal. Probe setup and
firmware installation keep their existing stronger lifecycle guards.
