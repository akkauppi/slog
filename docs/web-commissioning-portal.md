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

The page loads only `./generated/firmware/manifest.json` from its own HTTPS or
localhost origin. Manifest schema version 1 fixes the product, ESP32-C3 target,
XIAO board, 4 MB flash, partition-layout identifier, image roles and offsets.
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

The portal also requires an origin-wide exclusive Web Lock before it creates or
changes that marker. It requests the lock without waiting: if another portal
tab owns an installation or the browser has no Web Locks API, writing stays
disabled. The owning tab keeps the lock through write/reset uncertainty,
post-write verification, and removal of the verified marker. A definite
pre-write cancellation releases it only after the bootloader transport has
been reset and closed; closing the page releases the browser lock naturally
while the durable marker remains available to the next recovery tab.

After a successful write, reset the board into normal operation and reconnect
to the application serial port. The portal reads `SYS INFO` and requires the
expected protocol, `sauna_logger` product, `sauna_ota_v1` partition identifier,
OTA application slot, firmware version, and source commit from the manifest.
The package, board identity, and these expected runtime fields remain in the
recovery marker across reloads. The marker is cleared only after the exact
running-firmware check succeeds; probe setup is offered only after that check.
Commissioning protocol version 1 does not yet report the bootloader's hashed
hardware identity from the running application, so the user must still choose
the serial port that reappears from the same physical board. The portal proves
the running release identity at that boundary, but cannot cryptographically
bind the application port to the earlier bootloader port.

## Probe commissioning

The browser intentionally implements only the connect-one-at-a-time method:

1. The user starts a configuration transaction, which pauses automatic session
   logging before probes are rearranged.
2. The portal requires an empty 1-Wire bus.
3. The user connects P1 through P8 one at a time, leaving every accepted probe
   connected. Each scan must add exactly one CRC-valid DS18B20 address without
   losing a previously accepted address.
4. The portal checks the final eight-probe set, shows the physical order, and
   asks for explicit confirmation before writing.
5. It sends all eight positions, commits the CRC-protected map, reads it back,
   and restarts the logger.
6. After reconnecting, it verifies the active generation and ordered map, then
   performs one final exact eight-probe bus check. Only then can the verified
   `sensor-map.json` be downloaded.

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

## Advanced diagnostics

The collapsed **Advanced mode** is a read-only aid for troubleshooting managed
installation and probe setup. It retains at most 300 timestamped entries:
textual serial TX/RX lines, sanitized esptool messages, state changes, and
coarsened flash progress. Flashing frames are summarized; raw firmware payload
bytes are not recorded. Manual commands and free-form terminal input are not
provided in this release, so the managed workflow keeps exclusive control of
the device.

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

This creates `portal/generated/firmware/manifest.json` and its image files from
the pinned PlatformIO build. The generator decodes `partitions.bin`, verifies
its MD5 record, compares it exactly with `partitions.csv`, reads flash offsets
from ESP-IDF's generated `flasher_args.json`, and checks that the compiled
firmware contains the same release identity placed in the manifest. A source
checkout without that generated directory displays an honest unavailable
state; it does not substitute a remote or user-selected binary.

Public release automation should add `--require-release-metadata` so dirty,
unknown, or abbreviated source identities cannot be published.

## Run locally

Serve the portal rather than opening its HTML file directly:

```sh
python3 -m http.server 8000 --directory portal
```

Open `http://localhost:8000/` in a current desktop browser with Web Serial.
Current Brave is suitable; Firefox requires version 151 or newer and remains a
hardware-test target. Run the dependency-free portal tests with:

```sh
npm test
```

Tests use fake transports and generated fixture images; they never access
hardware. The complete install-to-commission path still requires an explicit
manual XIAO ESP32-C3 test before it can be called production-ready.

## Offline and GitHub Pages behavior

The application shell and pinned flashing runtime are cached locally. A
successfully validated same-origin firmware package is also copied to a
dedicated cache keyed by its package SHA-256. That immutable cache is outside
the service worker's release-cache cleanup, so an interrupted installation can
still restore the exact package after a portal deployment or reload. The most
recent complete cached package can also be installed without a network
connection. Browser permission to use a serial port is separate and may need
to be granted again. Clearing site data removes both the offline package and
any recovery marker, so do not clear it while installation or verification is
pending.

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

- warm-one-at-a-time browser commissioning
- routine OTA updates or arbitrary firmware uploads
- log download and offline analysis
- build instructions inside the portal
- record submission, comparison, accounts, or CRUD administration

These remain separate slices after install, verification, and probe setup have
been exercised end to end on hardware.
