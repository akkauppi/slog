# Session publication and durable commits

The first Lapland hardening slice retains the V2 binary format, 10-second
acquisition cadence, 60-record commit cadence, partition layout, and existing
probe-configuration and retention rules. V1 and V2 remain readable.

## Publication

A new recording is assembled at `/staging/NNNNNNNN.slog` on LittleFS. Its header
and initial pretrigger block are written through the checked POSIX adapter,
synchronized, and closed before an atomic rename publishes the file at
`/sessions/NNNNNNNN.slog`. The application marks the session active and advances
its durable record counters only after successful publication.

An interrupted creation can leave a staged file. The firmware preserves it,
does not overwrite its ID, and excludes it from the published-session catalog.
Staged files still consume space. They are not automatically retired, promoted,
or offered by `LOG LIST`/`LOG GET`; recovery/export of staged artifacts remains a
separate maintenance slice. Existing malformed files in `/sessions` continue to
block unsafe retention. This change does not delete or repair existing files.

LittleFS is mounted at `/littlefs`; Arduino filesystem reads and the POSIX
writer refer to that same mount. `StoreFiles` is the small injectable boundary
for opening, writing, syncing, closing, and renaming files. There is one firmware
storage writer. New staging files use exclusive creation, and append never
creates a missing published file.

## Appends

The storage adapter handles short writes and checks synchronization and close
results. Any write, sync, or close failure is an unsuccessful transaction even
if a later close happens to persist some or all of its bytes. The logger does
not acknowledge the block or advance its committed count. It interrupts the
segment without appending another block or footer after the uncertain tail.
Already completed CRC blocks remain recoverable. Diagnostic events distinguish
open, write, sync, close, and publication failures.

This removes the previous reliance on Arduino's void-returning `File.flush()`
and `File.close()`. It does not reduce the pending RAM block's ten-minute loss
window. Choosing a shorter commit interval requires a separate capacity and
flash-latency decision.

## Continuations and analysis

Reboot recovery decodes a bounded catalog using the same segment reader used
for retention. Only the newest segment in a valid catalog can be an interrupted
restart candidate. An older interrupted parent cannot become a new candidate
after a completed successor or newer completed run. Layout and hot-sample checks
still determine whether the candidate may actually be continued.

Python discovery walks ancestors and descendants with separate traversal state,
so selecting any member includes that requested segment. Identical duplicate
files are deduplicated; conflicting bytes with the same local session ID are
rejected rather than selected by directory iteration order.

For V2 `max_duration_sample_anchored` continuations, Python now uses the same
footer, boot, interval, and delay evidence as the browser to remove pretrigger
overlap from derived time. Raw samples are unchanged. Unproven timing continues
to have an unknown-duration gap.

## Verification

`tests/session_store_test.cpp` exercises the production POSIX adapter and an
injectable filesystem model, including cuts after create/write/sync/close/rename,
partial and zero-progress writes, sync/close failures, existing destinations,
preserved staged orphans, and missing append targets. The retention tests cover
completed successors, newer completed runs, newest interrupted leaves, invalid
catalogs, and branches. `tests/test_session_chains.py` checks discovery and runs
both analysis implementations against the same raw continuation files.

After PlatformIO installs the pinned dependencies, the suite also compiles the
actual LittleFS sources with the production transaction layer. It interrupts
each physical program/erase boundary of session creation and append, remounts
the surviving flash image, and verifies that a published new file is complete
and the previously committed prefix survives. CI runs this test after its
firmware build so a clean checkout cannot silently skip that dependency-backed
coverage. This simulator assumes whole program/erase operations; torn physical
flash operations and actual board timing still require hardware testing.

Run the Python suite, portal suite, and PlatformIO build before release. These
host tests do not replace physical power-cut testing of LittleFS, acquisition
timing, or the full session lifecycle. Radio/provisioning, a revised archival
contract, bounded USB transfers, and field soak testing remain later slices.

## Integration follow-up

The subsequent identity slice writes V3 with the same staging/commit mechanism.
Its record growth raises start reserve to 256 KiB; partition and commit cadence
remain unchanged. See [the implemented V3 contract](sample-identity-and-radio.md).
