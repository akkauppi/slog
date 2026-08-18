# Web commissioning portal

The first portal slice does one job: it commissions the eight ordered
temperature probes over USB and verifies the stored map after the logger
restarts. It is a static, local-first web application in [`portal/`](../portal/).
It does not flash firmware, read sauna logs, analyze data, or publish records.

## Requirements

- a desktop version of Chrome or Edge with Web Serial support
- an HTTPS page (GitHub Pages) or a local `http://localhost` server
- a USB data cable and exclusive access to the serial port
- logger firmware implementing commissioning protocol version 1

Safari, Firefox, iOS, and a page opened directly with a `file:` URL cannot use
the USB setup path. The Python commissioning tool remains available for those
who need the warm-one-at-a-time method or a command-line workflow.

## What the portal does

1. The user explicitly chooses a serial device. The portal sends only the
   read-only `SYS INFO` and `CFG GET` commands until product, protocol,
   partition layout, and OTA slot have been validated.
2. The logger pauses automatic session logging before probes are rearranged.
3. The user disconnects all probes, then connects P1 through P8 one at a time.
   Each accepted scan must contain exactly one new CRC-valid DS18B20 address,
   with every previously accepted probe still present.
4. The portal checks the final eight-probe set, shows the physical order, and
   asks for an explicit confirmation before writing.
5. It sends the eight positions, commits the CRC-protected map, reads it back,
   and restarts the logger.
6. After reconnecting, it verifies the active generation and ordered map, then
   performs one final eight-probe bus check. Only then can the verified
   `sensor-map.json` be downloaded.

The fixed order is P1 at the top/farthest end, followed by 20 cm steps toward
the logger, ending with P8 at the bottom/nearest end. Discovery order is never
used as physical identity.

## Data and recovery behavior

The app has no analytics, accounts, remote APIs, or third-party runtime assets.
Serial traffic remains in the browser. Partial position work is stored only in
local browser storage, and the final JSON is created as a local download.
Existing `.slog` files are not read, changed, or deleted by commissioning.

While a configuration transaction is open, the portal sends a serialized
keepalive once per minute. Closing or suspending the tab can still interrupt
that lease, so the page makes the paused-logging state visible. On reconnect it
inspects the logger before allowing another write. A lost connection after
commit is treated as an unknown result: the logger is restarted and its
boot-selected complete record is inspected rather than blindly rewritten.

Protocol version 1 does not expose a unique logger ID. During restart recovery,
the portal therefore reuses the previously authorized serial port when it can
and verifies the exact configuration generation, CRC, ordered ROM addresses,
and live eight-probe set. It never accepts a port based only on its USB model.

The application shell is cached after the first successful visit and can then
be opened without a network connection. Browser permission to use the USB port
is separate and may still need to be granted again. A waiting portal update is
not activated during an open commissioning transaction.

## Run locally

From the repository root, serve the portal on localhost:

```sh
python3 -m http.server 8000 --directory portal
```

Open `http://localhost:8000/` in Chrome or Edge. The browser's device chooser
must be opened by clicking **Choose logger**. Do not run a serial monitor at the
same time.

Run the dependency-free portal tests with:

```sh
npm test
```

The protocol and workflow tests use fake transports. They do not prove Web
Serial behavior on real hardware; the complete path still requires a manual
XIAO ESP32-C3 test before calling this slice production-ready.

## GitHub Pages

The `Portal` workflow tests the browser modules on pull requests. On a push to
`main`, it publishes only the `portal/` directory with the official GitHub
Pages actions. Set the repository's Pages source to **GitHub Actions** once;
the generated deployment URL is then reported by the workflow. Keep the
`github-pages` environment's deployment branch rule restricted to `main`, in
addition to the workflow's own main-branch condition.

The portal uses relative asset URLs so it works beneath the repository Pages
path. No repository source, raw logs, or development files are included in the
Pages artifact.

## Deliberately deferred

- warm-one-at-a-time browser commissioning
- firmware installation and updates
- log download and offline analysis
- build instructions inside the portal
- record submission, comparison, accounts, or CRUD administration

Those should be added as separate slices after this one end-to-end setup path
has been exercised on the actual logger.
