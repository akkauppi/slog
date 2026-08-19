# SLOG — sauna temperature logger

[![Portal](https://github.com/akkauppi/slog/actions/workflows/portal-pages.yml/badge.svg)](https://github.com/akkauppi/slog/actions/workflows/portal-pages.yml)

SLOG is open source software for logging saunas. The reference logger is a
power-loss-resilient Seeed Studio XIAO ESP32-C3 with eight powered DS18B20
temperature sensors. Wi-Fi is disabled. Measurements are available over USB,
while detected sauna sessions are stored in internal flash.

## Start here: use the browser portal

Open the hosted portal at **[akkauppi.github.io/slog](https://akkauppi.github.io/slog/)**.
For normal use, this is the SLOG application. Installing Python, PlatformIO, or
the source repository is **not** required for firmware installation, probe
setup, record download, charts, or CSV/Excel export.

| Task | Normal interface | Python required? |
| --- | --- | --- |
| Install or update firmware | Portal · **Prepare** | No |
| Verify the logger and map eight probes | Portal · **Prepare** | No |
| Download, preserve, or remove records | Portal · **Records** | No |
| View charts and export CSV or Excel | Portal · **Analyze** | No |
| Initialize blank session storage once | Serial command or supplied Python helper | Only when using the helper |
| Develop firmware, retrieve crash dumps, or make batch reports | Command-line tools | Yes |

The one current exception is explicit storage initialization. The portal never
formats flash, so a factory-new or erased logger needs the one-time
`LOG FORMAT YES` serial command before it can record sessions. This is
explained under [First-use storage initialization](#first-use-storage-initialization).
Python is one convenient way to send that command; it is not part of installing
firmware, mapping probes, or processing downloaded data.

### Browser workflow

1. Wire the logger as shown below and connect it over USB.
2. Open the portal in a current desktop Chrome or Edge.
3. In **Prepare**, install SLOG firmware, verify the running logger, and map the
   eight probes. The portal downloads a backup of the completed probe map.
4. If **Records** reports that storage is unavailable, perform the one-time
   storage initialization described below.
5. Disconnect USB and power the logger for the sauna run.
6. Reconnect later and use **Records** to CRC-check and preserve the raw
   `.slog` files.
7. Use **Analyze** to open those files locally, inspect charts and the selected
   probe's heating/cooling rate, and export CSV or Excel.

Firmware installation normally needs no button sequence, even on a new board:
choose the normally connected logger and SLOG enters ROM download mode
automatically. Manual BOOT access is retained only as a connection-recovery
fallback.

Logger access requires Web Serial, so use a current desktop Chrome or Edge on
Windows, macOS, or Linux. File-only analysis works in other modern browsers.
All processing is local, nothing is uploaded, and the portal remains available
offline after its application files and firmware package have been cached.
GitHub Pages rebuilds the portal and its commit-identified firmware package
from `main`; local development must use `tools/serve_portal.py` as described in
[`docs/web-commissioning-portal.md`](docs/web-commissioning-portal.md).

## Project scope and example

The repository contains the embedded logger, browser portal, optional USB and
analysis tools, CRC-safe log parser, and self-contained interactive analysis
reports. Development invariants and verification commands for coding agents
are summarized in `AGENTS.md`.

The agreed roadmap for turning this into a reproducible DIY build and curated
community dataset is documented in
[`docs/community-project-plan.md`](docs/community-project-plan.md).

The first full sauna run is retained as a de-identified reproducible example.
Like every raw `.slog`, it still contains stable probe ROM identifiers. See
[`docs/runs/2026-08-16-session-1.md`](docs/runs/2026-08-16-session-1.md) for the
observations and commands used to regenerate its CSV and interactive report.

[![Eight probe temperatures from the first full sauna run](data/2026-08-16-sauna/session-1-main-chart.png)](docs/runs/2026-08-16-session-1.md)

## Wiring

The firmware uses XIAO pin `D2` for the 1-Wire data line. Connect every sensor
in powered (three-wire) mode:

- sensor GND to XIAO GND
- sensor VDD to XIAO 3V3
- sensor DATA to XIAO D2
- 4.7 kOhm pull-up from DATA to 3V3 as an initial value

Prefer a linear trunk with short sensor branches. Do not use parasite power.
The final pull-up value may need adjustment for the installed cable length and
topology.

## Set up the probes

The firmware is generic: it contains no installation-specific probe addresses.
On the first boot of this version, on a new device, or after NVS has been
erased, probe discovery and fresh temperature scans remain available over USB
but session logging is disabled until all eight probes have been mapped. Probe
identity always comes from the DS18B20 ROM address, never from discovery order.

Use **Prepare** in the browser portal for the normal setup. It commissions a
fully assembled eight-probe column by asking you to warm one metal probe tip at
a time, verifies the committed map after restart, and downloads a
`sensor-map.json` backup. The secondary browser method supports connecting
probes individually.

The portal uses a fixed, SHA-256-checked firmware package and has no arbitrary
firmware picker or whole-flash erase option. See
[`docs/web-commissioning-portal.md`](docs/web-commissioning-portal.md) for
browser requirements and recovery behavior.

### Optional command-line probe setup

The repository also includes a Python commissioning tool for development,
bench work, and scripted recovery. Its default method connects probes one at a
time, starting with probe 1 at the top/farthest end and finishing with probe 8
at the bottom/nearest end:

```sh
.venv/bin/python tools/identify_sensors.py --method connect
```

For an assembled harness, use its warm-one-at-a-time method:

```sh
.venv/bin/python tools/identify_sensors.py --method warm
```

Both the portal and tool validate every ROM's family and Maxim CRC, require
eight unique addresses, and confirm that the final discovered set exactly
matches the proposed map. The configuration is staged in RAM, written as a
CRC-protected record to the inactive NVS slot, read back, and then activated by
reboot.
After reconnecting, the workflow verifies that boot activated that exact
generation and that the same eight ROMs are still present. The previous valid
slot is never erased during a normal commit. Partial identification progress
is saved to `sensor-map.pending.json`, so an interrupted replacement cannot
overwrite the last verified `sensor-map.json`. The final map replaces `sensor-map.json`
atomically only after all post-reboot checks pass.

Commissioning does not format LittleFS or alter existing `.slog` files.
`LOG FORMAT YES` likewise leaves the probe mapping in NVS intact. A full-chip
erase does remove the mapping, so keep `sensor-map.json` as a backup. The
line-oriented protocol intended for both this tool and the browser portal is
documented in
[`docs/probe-commissioning.md`](docs/probe-commissioning.md).

## Session logging

- Samples are taken every 10 seconds.
- No session can start without one complete, valid eight-probe configuration.
- The latest 10 minutes are retained in RAM while idle.
- A session starts after any valid probe remains above 40 C for 30 seconds.
- The pre-trigger readings are committed immediately; later blocks are flushed
  every 10 minutes, limiting sudden-power-loss exposure to the current block.
- A normal session ends after the hottest probe remains below 45 C and at least
  15 C below the session peak for 30 minutes. Probe 1 and at least six probes
  must be healthy for automatic ending.
- Logs use CRC-protected binary blocks. An absent footer marks a power-cut
  session; valid committed blocks remain downloadable.
- Every 10-minute block is opened, appended, flushed, and closed independently.
  An unexpected power cut can therefore lose or corrupt only the block being
  assembled or written; the offline parser stops at the first incomplete or
  invalid block and preserves all earlier blocks.
- If power returns while the sauna is still hot, the new session records the
  interrupted session ID as a probable continuation. A cold reading from at
  least six probes cancels that link.
- Device flash is a bounded rolling store, not the permanent archive. Immediately
  before opening a new session, the logger requires enough free space for a full
  12-hour recording. If necessary, it may retire the oldest eligible completed
  logical run to make that reserve. Segments linked by continuation metadata are
  treated as one run, and an interrupted session that may be continued is
  protected.
- Linked segments are retired newest first. If power fails between removals,
  the remaining files are still a valid prefix and the same run is completed
  immediately before the next session starts.
- Retention never runs during an active session. If the full-session reserve
  cannot be made from eligible completed runs, the new session is refused and
  every existing raw log is left in place.
- The firmware records boot/reset metadata, RTC source and fallback state,
  sensor-health flags, and the ESP32-C3's internal temperature alongside probe
  readings. Wi-Fi remains disabled.

### First-use storage initialization

SLOG never formats its flash filesystem automatically, and the portal does not
offer a format button. A factory-new board—or a board whose session partition
has been deliberately erased—must therefore be initialized once before it can
record sessions.

This is the only normal setup operation that is not yet available in the
portal. Python is not inherently required: with the running logger connected,
any 115200-baud serial terminal can send this exact line:

```text
LOG FORMAT YES
```

Wait for `LOG_FORMAT ok=1`. Formatting destroys any session records already in
that partition, so use it only for new or intentionally cleared storage. It
does not erase the probe map stored in NVS.

From a SLOG development checkout, the supplied Python helper sends the same
command:

```sh
.venv/bin/python tools/logs.py format --yes
```

### Browser record handling and analysis

Downloading neither removes the device copy nor marks it as archived. Because
the logger cannot know whether a completed run has been copied elsewhere,
download and CRC-validate raw `.slog` files regularly, ideally after every
measurement. Automatic retention may eventually retire an old completed run.
Manual deletion remains available when you have already preserved every linked
segment of that logical run.

The portal's **Records** section shows the rolling-store reserve and logical
chains, supports CRC-validated raw downloads, and prefers whole-run removal
only after every segment has been saved and read back through the file-system
picker. Browsers without that API can use an explicit, strongly warned
override after Quick downloading every segment; the portal CRC-checks the
transfer and compares fresh device bytes again immediately before deletion,
but cannot prove the browser saved a copy.

**Analyze** opens one or more `.slog` files entirely offline and groups only
unambiguous continuations by default. The user can instead view each segment
alone without changing its raw linkage metadata. It shows an eight-probe SVG
timeline with explicit unknown-duration gaps and a selected-probe derivative
chart on the same time axis. The selected view can be exported as CSV or an
Excel `.xlsx` workbook; both keep segment-relative time and mark unknown power
gaps instead of inventing elapsed time. See
[`docs/web-data-workspace.md`](docs/web-data-workspace.md) for the preservation
and deletion gates and the export schema.

### Optional development and command-line tools

Nothing in this section is required for the normal browser workflow. These
commands are for firmware development, automation, deeper reports, and device
diagnostics.

PlatformIO is installed in the repository-local Python virtual environment:

```sh
.venv/bin/pio run
.venv/bin/pio run --target upload
.venv/bin/pio device monitor
```

Exit the serial monitor with `Ctrl-C`. Install the optional offline-report
dependency once:

```sh
.venv/bin/pip install -r requirements-analysis.txt
```

The command-line record tools are:

```sh
.venv/bin/python tools/logs.py status
.venv/bin/python tools/logs.py list
.venv/bin/python tools/logs.py download 1 session-1.slog
.venv/bin/python tools/logs.py export session-1.slog session-1.csv
.venv/bin/python tools/logs.py plot session-1.slog session-1.html
.venv/bin/python tools/logs.py report session-1.slog
.venv/bin/python tools/logs.py delete 1
```

The `plot` result is a self-contained interactive HTML report with raw and
optional 50-second-median traces, a time/height thermal map, linked vertical
profiles, stratification analysis, threshold timing, rapid-warming candidates,
and logger-health information. Related continuation segments retain explicit
unknown power-off gaps. Use `--no-chain` to inspect one physical file alone.

Compare complete runs, aligned at their 40 C triggers, with:

```sh
.venv/bin/python tools/logs.py compare session-1.slog session-8.slog \
  --output comparison.html
```

`status` provides additional firmware diagnostics, including RTC source,
reset cause, probe state, retention activity, and crash-dump presence. If a
watchdog crash occurred, preserve its raw dump before erasing it:

```sh
.venv/bin/python tools/logs.py crash-download crash.bin
.venv/bin/python tools/logs.py crash-erase
```

The task watchdog, brownout detector, and flash core dumps are enabled in the
build. ESP-IDF falls back if XTAL32K cannot start; the logger records the active
RTC source and any fallback for later review.

## Installation geometry

Probe 1, at the end opposite the ESP32, is the highest probe near the ceiling.
Probes increase in number downward toward the ESP32 at 20 cm intervals. Probe 8
is therefore 140 cm below probe 1. These are relative heights; an absolute
ceiling or floor height can be added later without changing sensor identity.

## Unattended sauna test checklist

1. In the portal's **Prepare** section, install or verify the firmware and
   complete probe setup. Initialize blank storage once if **Records** reports
   that the filesystem is unavailable.
2. In **Records**, confirm that the 12-hour storage reserve is ready and
   preserve any sessions not already backed up. Keep the XIAO and wiring in the
   coolest practical location; keep the USB power bank outside the sauna.
3. Disconnect serial, power from the power bank, and let the firmware start the
   session automatically after a probe stays above 40 C for 30 seconds.
4. Unannounced power removal is supported. On the next USB connection, use
   **Records** to download every relevant `.slog`.
5. Open the saved files in **Analyze**, review the charts, and export CSV or
   Excel before deleting anything from the device. Retain the original
   `.slog` files for later analysis.

## Contributing

Focused code, documentation, hardware-design, and test contributions are
welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
Use the issue forms for bugs and proposals, and report vulnerabilities through
the private process in [SECURITY.md](SECURITY.md). Community measurement intake
remains closed until its consent and privacy-review workflow is implemented;
do not attach raw records to an issue.

Project decisions and maintainer review rules are documented in
[GOVERNANCE.md](GOVERNANCE.md). Participation is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Licensing

SLOG deliberately separates licenses by material:

- software is licensed under Apache-2.0;
- documentation is licensed under CC BY 4.0;
- hardware design files are licensed under CERN-OHL-P-2.0; and
- measurements and catalog metadata are dedicated under CC0 1.0.

The exact path rules and full license texts are in
[`LICENSES/README.md`](LICENSES/README.md). Vendored dependencies retain their
upstream licenses.
