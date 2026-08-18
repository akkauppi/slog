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

The start summary calls out an already-hot or partially captured start. This is
descriptive, not a claim about the unobserved heating period. Raw `.slog` files
remain the source of truth.

## Preserve and remove device records

**Records** first verifies `SYS INFO` against the supported sauna logger
identity, then reads `LOG STATUS` and `LOG LIST`. It shows active recording,
free and total space, the full-session reserve, automatic retention history,
and logical continuation chains. Downloads and analysis transfers are disabled
while a session is active.

There are two download paths:

- **Preserve raw file** uses `showSaveFilePicker`, downloads and CRC-validates
  the device bytes, writes the selected file, then reads it back and compares
  it byte for byte. Only that manager-issued receipt can authorize removal.
- **Browser download** works where the file-system picker is unavailable. The
  bytes are still CRC-validated and may be analyzed, but the browser cannot
  prove where the download was saved, so it never authorizes deletion.

Removal is available only when every segment of an unambiguous logical run has
an unused verified-save receipt. A confirmation names the entire chain, and
segments are removed newest to oldest. The portal also blocks removal during
recording, unresolved commissioning/restart state, journaled automatic
retention, an unsafe catalog, or a probable hot-start continuation. It does not
offer format, bulk erase, or crash-dump erase.

Receipts exist only in the connected page and are cleared on disconnect or
reload. A later visit must read each saved file back through a new preservation
operation; ordinary download history is intentionally not trusted.

Switching portal sections, applying a service-worker update, closing the page,
or disconnecting is blocked during a transfer or removal. Probe setup and
firmware installation keep their existing stronger lifecycle guards.
