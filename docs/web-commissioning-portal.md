# Web install and commissioning portal

The portal in [`portal/`](../portal/) is a static, local-first utility for two
connected jobs:

1. install the repository's prepared firmware release on a XIAO ESP32-C3; and
2. commission the eight ordered temperature probes and verify their stored map.

It does not accept arbitrary firmware, perform routine OTA updates, erase the
whole flash, read or delete sauna logs, analyze data, or publish records. Those
boundaries keep the first community-facing tool small enough to audit and test.

## Requirements

- a current desktop browser that exposes Web Serial; Chrome, Chromium, Edge,
  and Brave are the primary supported path
- an HTTPS page (such as GitHub Pages) or a local `http://localhost` server
- a USB data cable and exclusive access to the serial port
- a Seeed Studio XIAO ESP32-C3

Firefox added desktop Web Serial in version 151, but that path has not yet been
exercised on the logger hardware. Firefox 150 and earlier, Safari, iOS,
embedded frames, and a page opened directly with a `file:` URL cannot use the
USB workflows. The Python commissioning tool remains available for
command-line use and for the deferred warm-one-at-a-time method.

## Firmware installation

Installation is intentionally not one opaque button. The page explains how to
enter the ROM bootloader, asks the user to choose the device, validates the
bundled release, asks for an explicit write confirmation, displays progress,
then verifies the running application separately.

To enter BOOT mode:

1. disconnect USB;
2. hold the XIAO's **BOOT** button while reconnecting USB; and
3. release **BOOT** after the computer detects the board, then choose that
   bootloader port in the browser.

Close PlatformIO and other serial monitors first. If the port does not appear,
repeat the sequence rather than choosing an unrelated serial device.

Web Serial access is exclusive across applications, tabs, and website origins.
Before moving from the local portal to GitHub Pages, disconnect the logger and
close the localhost tab; also close any other portal tab or serial monitor. If
the chooser lists the board but opening it fails, close those competing users,
unplug and reconnect the board, and try again. The portal reports the browser's
underlying error name and message when they are available.

The page loads only `./generated/firmware/manifest.json` from its own HTTPS or
localhost origin. Manifest schema version 2 fixes the product, commissioning
protocol version 1, ESP32-C3 target, XIAO board, 4 MB flash,
partition-layout identifier, image roles and offsets. The package generator
also requires the exact compiled `SAUNA_COMMISSIONING_PROTOCOL=1` sentinel, so
an older coherent image cannot be relabeled as portal-compatible.
Every image is fetched from the generated package and checked against its
declared size and SHA-256 digest before writing. The browser flasher dependency
is a reviewed, pinned local copy; installation never imports code from a CDN.
This is package integrity and local/HTTPS provenance, not a claim of a
cryptographic release signature.

The four displayed stages are:

1. validate the manifest and image hashes;
2. prepare and identify the ESP32-C3 bootloader;
3. write the bootloader, partition table, OTA data, and `app0` image at their
   generated offsets; and
4. verify the written image data.

There is no whole-chip erase control. The package generator rejects images that
overlap NVS, `app1`, LittleFS, or the core-dump partition. This preserves the
logger's bounded-store and recovery assumptions instead of treating a browser
installation as permission to discard device state.

The user may cancel after target detection but before writing begins; cancel
resets and closes the bootloader connection. Once writing starts, cancellation
is disabled. Before the first write, the browser must successfully preserve the
exact validated manifest and four images in a content-addressed CacheStorage
cache, then round-trip a local recovery marker. That marker binds the package
hash to a SHA-256 hash of the ESP32-C3 identity. A USB or power interruption is
reported as an uncertain outcome, not success. Put the same board back into
BOOT mode and choose **Recover installation**. Recovery restores and
revalidates those exact cached bytes, rejects a different physical ESP32-C3,
and does not offer an erase fallback.

Schema-1 packages are rejected before images are loaded or a serial port is
requested. The sole exception is an exact schema-1 package already named by a
durable `WRITE_REQUIRED` recovery marker; finishing that interrupted write is
safer than changing packages mid-recovery. A completed legacy write awaiting
runtime verification can instead use the bounded same-device replacement path
below.

The portal also requires an origin-wide exclusive Web Lock before it creates or
changes that marker. It requests the lock without waiting: if another portal
tab owns an installation or the browser has no Web Locks API, writing stays
disabled. The owning tab keeps the lock through write/reset uncertainty,
post-write verification, and removal of the verified marker. A definite
pre-write cancellation of a new installation releases it only after the
bootloader transport has been reset and closed. Cancellation of the bounded
same-logger replacement described below keeps the lock while the portal returns
to the old mandatory verification. Closing the page releases the browser lock
naturally while the durable marker remains available to the next recovery tab.

After a successful write, the adapter asserts reset for 200 ms, releases it,
waits another 200 ms, and closes the bootloader transport. Release **BOOT** and
reconnect to the application serial port. If the port remains silent, press
**RESET** once without holding **BOOT**; if the board has another power source,
remove all power before reconnecting USB. The portal reads `SYS INFO` and
requires the expected protocol, `sauna_logger` product, `sauna_ota_v1`
partition identifier,
OTA application slot, firmware version, and source commit from the manifest.
Before that first request it discards a short, bounded USB diagnostic backlog.
If `SYS INFO` is silent or is visibly joined to a truncated telemetry record,
the portal discards the damaged record and retries this read-only command once.
It never extracts device identity from a damaged line, and it never applies
this retry rule to configuration writes, deletion, or any other mutating
command. Current firmware also emits telemetry as one best-effort bounded line
and starts every solicited response at a fresh line boundary.
The package, board identity, and these expected runtime fields remain in the
recovery marker across reloads. The marker is cleared only after the exact
running-firmware check succeeds; probe setup is offered only after that check.
Commissioning protocol version 1 does not yet report the bootloader's hashed
hardware identity from the running application, so the user must still choose
the serial port that reappears from the same physical board. The portal proves
the running release identity at that boundary, but cannot cryptographically
bind the application port to the earlier bootloader port.

One bounded replacement path exists for a completed, device-MD5-verified write
whose running firmware explicitly rejects `SYS INFO` as legacy or
incompatible. This path is never available while a write outcome is uncertain.
The portal keeps the old `VERIFICATION_REQUIRED` marker and origin-wide lock
while it downloads, validates, and caches the current published package. It
then asks for the original logger in BOOT mode and compares the bootloader's
hashed hardware identity with the old marker. A different board, download or
validation failure, chooser cancellation, or any other definite pre-write
failure leaves the old marker unchanged. Only after package and same-board
preflight, immediately before writing may begin, is the marker atomically
advanced to `WRITE_REQUIRED` for the current package. The normal exact runtime
verification must still succeed before that new marker is cleared.

## Probe commissioning

The primary browser workflow is designed for a finished logger: every probe
stays wired throughout setup.

1. The user starts an assembled-probe transaction, which pauses automatic
   session logging. All eight probes must be connected and cool.
2. The portal takes five complete scans. The ROM set must remain unchanged,
   every probe must return a temperature, and each individual probe must stay
   within a 0.5 °C range. Its five-reading median becomes its baseline.
3. Starting at P1, the user holds only the named metal tip between their
   fingers until it is warmer, then asks the portal to check it. No wire or
   probe is disconnected.
4. A ROM is accepted only when two fresh scans select the same unmapped probe,
   at least 3.0 °C above its own baseline and at least 1.0 °C ahead of every other
   unmapped probe. Previously mapped probes are excluded, so they do not need
   to cool before moving to the next position. The final probe still needs two
   qualifying readings.
5. The portal checks the final eight-probe set, shows the physical order, and
   asks for explicit confirmation before writing.
6. It sends all eight positions, commits the CRC-protected map, reads it back,
   and restarts the logger.
7. After reconnecting, it verifies the active generation and ordered map, then
   performs one final exact eight-probe bus check. Only then can the verified
   `sensor-map.json` be downloaded.

A secondary bench-build method retains the original empty-bus workflow: connect
P1 through P8 one at a time, leaving each accepted probe connected. It is for a
loose or connectorized harness, not a soldered finished product. Each scan must
add exactly one CRC-valid DS18B20 address without losing an accepted address.

P1 is the top/farthest probe. Positions descend toward the logger in 20 cm
steps, ending with P8 at -140 cm, nearest the logger. ROM identity is never
derived from discovery order.

While a configuration transaction is open, the portal sends a serialized
keepalive once per minute. Closing or suspending the tab can still interrupt
the lease, so the paused-logging state remains prominent. A lost connection
after commit is an unknown result: the page inspects the boot-selected complete
record instead of blindly writing again.

Partial position work is stored only in local browser storage. Existing `.slog`
files are never read, changed, or deleted. Protocol version 1 does not expose a
unique logger ID, so recovery always verifies the exact configuration
generation, CRC, ordered ROM addresses, and live probe set; it never trusts a
port based only on its USB model.

If the page is reloaded after all eight positions were saved, the portal does
not infer that a write succeeded. It first inspects the boot-selected map. A
saved map is eligible for recovery only when all eight ordered ROM addresses
exactly match the active configuration and any saved commit generation and CRC
also match. `restart_required=1` is handled before recovery. The user must then
run the same diagnostic `CFG BEGIN` / `CFG SCAN` / `CFG ABORT` live-bus check;
only that successful check marks the map verified and clears the pending local
record. Partial, malformed, or mismatched saved work is never promoted.

## Diagnostics console

A compact **Diagnostics** strip remains at the bottom of every portal section.
Select the strip, or press `F2` while focus is not in an editable field, to open
the read-only console; use the same control to collapse it. `Escape` also
collapses the console when focus is inside it. The page reserves space for both
states, so the fixed console does not make the last controls unreachable.

The console retains at most 300 timestamped entries: textual serial TX/RX
lines, sanitized esptool messages, state changes, and coarsened flash progress.
Its collapsed strip shows the newest retained event. Flashing frames are
summarized; raw firmware payload bytes are not recorded. Unclassified bytes
already buffered when a serial port opens are discarded and represented only
by a record count, preventing a partial raw-log transfer from entering the
transcript. Manual commands and free-form terminal input are not provided in
this release, so the managed workflow keeps exclusive control of the device.
**Advanced mode** in Prepare contains the corresponding firmware,
configuration, and USB metadata.

The transcript stays in this browser tab unless the user explicitly copies it
or downloads a text file. It may contain probe ROM addresses, USB identifiers,
and firmware metadata. Review a diagnostic export before sharing it; the portal
does not upload it.

## Build the firmware package

The generated firmware directory is deliberately not committed. Build the
firmware and create a locally validated portal package from the repository root:

```sh
.venv/bin/python tools/build_web_flash_bundle.py --build
```

This creates `portal/generated/firmware/manifest.json` and a content-addressed
image directory under `portal/generated/firmware/packages/` from the pinned
PlatformIO build. The generator decodes `partitions.bin`, verifies its MD5
record, compares it exactly with `partitions.csv`, reads flash offsets from
ESP-IDF's generated `flasher_args.json`, and checks that the compiled firmware
contains the same release identity placed in the manifest. A source checkout
without that generated directory displays an honest unavailable state; it does
not substitute a remote or user-selected binary.

Publication is safe while a local server is running. All four images are first
copied into a private staging directory, the completed directory is renamed to
its immutable package identity, and `manifest.json` is replaced atomically as
the final commit point. Previously published package directories are retained,
so a tab that read the previous manifest can still finish validating exactly
those bytes. Do not manually edit files below `packages/`; stop the local
server before deleting `portal/generated/firmware` to reclaim development
packages. After generating a new package, reload any tab that had already
finished its package check. A prepared tab intentionally remains bound to the
exact package it validated instead of changing firmware underneath a device
workflow.

Public release automation should add `--require-release-metadata` so dirty,
unknown, or abbreviated source identities cannot be published.

## Run locally

Serve the portal rather than opening its HTML file directly:

```sh
.venv/bin/python tools/serve_portal.py status
.venv/bin/python tools/serve_portal.py start
```

Open `http://localhost:8000/` in a current desktop browser with Web Serial.
The server binds only to the local machine and stays in the foreground; stop it
with Ctrl-C, or from another terminal with
`.venv/bin/python tools/serve_portal.py stop`. The repository lock refuses a
second managed instance, and on Linux startup also refuses an ad-hoc Python
server already serving this `portal/` directory. It never searches for another
free port. Keep this canonical origin: changing ports also changes the browser
storage origin and can bypass an in-progress recovery marker.

Current Brave is suitable; Firefox requires version 151 or newer and remains a
hardware-test target. Run the dependency-free portal tests with:

```sh
npm test
```

Tests use fake transports and generated fixture images; they never access
hardware. The complete install-to-commission path still requires an explicit
manual XIAO ESP32-C3 test before it can be called production-ready.

## Offline and GitHub Pages behavior

The application shell and pinned flashing runtime are cached locally. The
service worker deliberately does not cache the mutable published firmware
manifest. A successfully validated same-origin firmware package is instead
copied to a dedicated cache keyed by its package SHA-256. That immutable cache
is outside the service worker's release-cache cleanup, so an interrupted
installation can still restore the exact package after a portal deployment or
reload. The most recent complete cached package can also be installed without
a network connection. Browser permission to use a serial port is separate and
may need to be granted again. Clearing site data removes both the offline
package and any recovery marker, so do not clear it while installation or
verification is pending.

If the marker survives but its dedicated cache entry is missing or damaged,
the portal may fetch only its fixed same-origin release URL. It fully validates
the manifest, image sizes, SHA-256 hashes, partition-table MD5, target, layout,
and offsets before comparing the resulting package hash and runtime expectation
with the existing marker. Only an exact match is copied back into the recovery
cache and enabled. Redirects, a different deployed release, corrupt bytes, or a
cache write/read-back failure remain fail-closed and never enable a chooser.

A waiting portal update is never activated while a bootloader connection,
firmware write or recovery, restart verification, or probe transaction is in
progress. The Pages artifact contains only `portal/` plus its generated release
package. It has no analytics, account service, third-party runtime request, or
backend API.

To publish the portal, set **Settings → Pages → Build and deployment → Source**
to **GitHub Actions**. The repository workflow tests the portal and firmware,
builds a validated package, and uploads only the `portal/` directory. It deploys
only after a push to `main`; pull requests run the validation job without a
Pages deployment. Protect the `github-pages` environment so deployments are
accepted only from `main`.

## Deliberately deferred

- routine OTA updates or arbitrary firmware uploads
- build instructions inside the portal
- record submission, comparison, accounts, or CRUD administration

These remain separate slices while the portal concentrates on installation,
probe setup, local record preservation, and local analysis.
