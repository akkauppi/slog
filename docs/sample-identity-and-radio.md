# Sample identity and the first live transport

This contract is implemented by the logger writer, Python reader, browser reader,
and shared C++ codec. It supersedes the receiver integration plan's earlier,
unimplemented 150-byte V3 proposal. Eight probes and 10-second acquisition remain
fixed for this deployment. Wi-Fi/UDP is a later adapter; encrypted ESP-NOW is the
only enabled radio mode in this release.

## Repository ownership

The logger is public; keep the receiver separate for a private remote. The logger's
`lib/saunan_wire` and `lib/saunan_link` are the canonical shared sources. They
contain protocol, identity, storage encoding, configuration, and SDK adapter
code; they contain no receiver dashboard or product assets. The receiver
consumes a pinned, hash-verified snapshot. A third repository is unnecessary
until other consumers or independent releases justify it. Neither firmware build
requires access to the other's repository or a private remote.

Changes to a shared contract start in the logger, run its golden/parity tests,
and are then imported into the receiver. Treat this as one matched release even
though the products live in separate repositories. Repository separation is not
itself a review of what is appropriate to publish; review code and history before
making a repository public. No repository visibility or licensing was changed.

## Acquisition identity

The tuple `(source_id, boot_nonce, acquisition_sequence)` identifies one acquired
sample. `source_id` is the six station-MAC bytes interpreted as a big-endian
integer, zero-extended to 64 bits. Human-readable form is 16 lowercase hex digits;
all binary integer fields are little-endian. A fresh nonzero 64-bit boot nonce
comes from the hardware RNG with its temporary bootloader entropy source enabled
before sensor/ADC use and disabled immediately afterwards. It is an epoch
identifier, not an authentication key.

The logger increments its boot counter only when persistence and readback
succeed. Failure or exhaustion records counter zero and clears counter-valid;
local logging continues. Nonce-based receiver epoch recovery remains available.

Sequence increments once per acquisition, including acquisitions that cannot
enter the configured logging pipeline. Monotonic milliseconds come from the
64-bit ESP timer at collection start after the conversion wait. They are neither
UTC nor power-off duration. The skipped-schedule counter counts nominal slots
intentionally skipped by the scheduler, independently of sequence and radio
loss. These facts are assigned once to `SensorReading.identity`; raw encoding
and SAUW live encoding use those same values. The legacy relative-seconds field
remains for existing analysis conventions; V3 analysis uses monotonic differences for within-boot timing, including jitter,
and does not invent duration across a changed boot nonce.

Only mapped, non-commissioning samples are offered live, after local pipeline
acceptance. A filesystem outage still permits live readings with storage-ready
cleared. Session-active reports current recording state, not durable receipt of
the current sample. No live durable-through cursor is claimed by SAUW V1.

Device-local session numbers remain labels and can repeat after an explicit
format. Do not use them as global archive identities. Raw artifacts are keyed by
SHA-256; samples by the identity tuple above. A published segment always has a
complete initial block, so its first acquisition identity is also inspectable.

## SLOG V3 layout

V1 (130-byte header/21-byte record) and V2 (142/25) stay readable and are never
rewritten. New recordings use V3 with an exact 204-byte header and 41-byte record.
The magic stays `SAUNLOG1`. All integers are explicitly encoded little-endian.

Header bytes 0–137 preserve the V2 prefix and eight ROM/height descriptors:
version at 8 is 3, header length at 10 is 204, channel count at 26 is 8, reserved
byte 27 is zero. Descriptors start at 58 and retain **centimetre** heights
`0,-20,...,-140`; no silent unit migration occurs. Header bytes 138 onward are:

| Offset | Size | Meaning |
| ---: | ---: | --- |
| 138 | 8 | Nonzero source ID |
| 146 | 8 | Nonzero boot nonce |
| 154 | 4 | Nonzero probe mapping generation |
| 158 | 2 | Geometry ID 1 |
| 160 | 1 | Expected mask `0xff` |
| 161 | 1 | Identity flags: bit 0 counter valid, bit 1 producer commit known, bit 2 dirty build; other bits zero |
| 162 | 20 | Git SHA-1 bytes, conventional hex-pair order; zero when unknown |
| 182 | 16 | Firmware version ASCII, at most 15 characters, zero-padded |
| 198 | 2 | Reserved, zero |
| 200 | 4 | CRC-32/ISO-HDLC over bytes 0–199 |

A dirty producer SHA identifies its base revision, not the complete working
patch. Use clean matched release artifacts and archive the source to reproduce a
field build. Unknown producer identity remains explicit.

Record bytes 0–24 retain V2 meanings: relative seconds `i32`, eight centi-degree
`i16` values, validity mask, chip centi-degrees, and status flags. Invalid readings
use `INT16_MIN`; validity and chip/degraded flags must agree with their values.

| Offset | Size | Meaning |
| ---: | ---: | --- |
| 25 | 4 | Acquisition sequence |
| 29 | 8 | Monotonic collection-start milliseconds |
| 37 | 4 | Cumulative skipped schedule count |

A block still has the 16-byte `BLK1` envelope, with 1–60 records. **V3 block CRC
covers envelope bytes 0–11 concatenated with the payload**, excluding the stored
CRC at 12–15. V1/V2 retain their payload-only CRC. Decoders recover complete
validated prefixes and stop on an invalid V3 block, including non-advancing
acquisition identity, decreasing monotonic time, or inconsistent validity.
The 20-byte footer and its CRC convention are unchanged.

Header and record sizes are exact; reserved fields are zero. Unknown versions or
mandatory identity flags are rejected, not guessed. A future incompatible record
needs a new version. 64-bit values are exposed without rounding: IDs as fixed
hex strings and monotonic milliseconds as decimal strings in Python/browser
normalized models and exports. Raw bytes always remain the authority.

The complete 12-hour V3 segment bound is about 177 KiB including pretrigger and
block overhead. Start reserve and browser transfer/parser bounds are 256 KiB;
partitions and the ten-minute commit interval are unchanged. Validate free space
before departure. The 12-hour acquisition payload is about 177 KB before block,
pretrigger and filesystem overhead.

## ESP-NOW and provisioning

Both units default to radio off. A valid saved configuration enables station
mode without joining an AP, fixes channel 1–11, and installs exactly one encrypted
unicast peer with a generated PMK and LMK. Source ID and peer MAC are checked
before receiver state changes. No broadcast discovery, auto-pairing, network
fallback, or simultaneous transports are enabled.

`RADIO STATUS` reports the unit's station MAC, local source ID, configured mode,
channel, active/fault/reboot state, and sender counters. It never returns keys.
Prepare pairing files offline after obtaining the two MAC addresses:

```sh
.venv/bin/python tools/pair_radio.py prepare --logger-mac AABBCCDDEEFF --receiver-mac 102233445566 --channel 6 --output radio-pairing
.venv/bin/python tools/pair_radio.py apply --port /dev/ttyACM0 --config radio-pairing/logger.json
.venv/bin/python tools/pair_radio.py apply --port /dev/ttyACM1 --config radio-pairing/receiver.json
```

Replace example addresses and ports with actual values; MACs must be unicast.
The private directory contains generated keys in mode-0600 JSON files. Preserve
both files for offline recovery and keep them out of source control. `prepare`
uses only Python's standard library; `apply` uses the existing pyserial dependency,
checks the connected MAC, and requires a verified commit response. It never
uploads firmware. Reboot each unit after provisioning, either by power cycling
or with the explicit `RADIO REBOOT` serial command while recording is inactive.
Check `RADIO STATUS` after reboot: expected mode/channel, active=1, fault=0.

Wire configuration command: `RADIO ` followed by exactly 120 hexadecimal digits
(126 characters total, within the existing 127-character USB bound). The 60-byte
blob is `SRAD`, schema 1, mode (0 off/1 ESP-NOW), channel, reserved zero, source ID
at 8, peer MAC at 16, reserved zeros at 22, PMK at 24, LMK at 40, and CRC over
0–55 at 56. Off is canonical all-zero fields after schema/mode, with a valid CRC.
The blob is stored atomically as one NVS value in the dedicated `sauna_radio`
namespace and read back byte-for-byte. Invalid configuration fails closed to off.
Any uncertain commit stops radio and requires reboot. Probe mapping, boot counter,
retention journal, and SDK Wi-Fi storage are separate. Configuration writes and
reboot are refused during recording; `RADIO OFF` persists off and stops radio.

The logger's offer path only encodes/copies into a fixed latest-value mailbox.
Polling occurs after acquisition scheduling. One datagram may be in flight and
one pending; a newer pending sample replaces the older one. Pending data expires
after 20 seconds. Callbacks only copy into fixed FreeRTOS queues. A receive queue
retains one latest datagram; it is not a recording archive.

A missing send callback times out after two seconds and requests radio-only
recovery in a separate worker; local sampling continues. The worker tears down
ESP-NOW and Wi-Fi before clearing callback queues and restoring the saved peer.
Ordinary send failures discard that sample and try the next acquisition. See
Radio-only recovery below for retry policy and bench fault injection.

The receiver boots with empty history and renders waiting/live/stale/lost state
on a timer, even without new packets. It labels last-known readings and separates
storage availability from current recording. `DEMO ON` is an explicit, boot-local
selection while radio is inactive; `DEMO OFF` returns to empty real-input state.
Synthetic samples never enter the logger or its files.

## Wi-Fi later and release gates

The existing SAUW envelope, sample identity, `ReceiverState`, and latest-value
semantics remain transport-neutral. Wi-Fi/UDP can feed the same receive boundary
and send the same bytes. Add a new versioned configuration with SSID/credentials
and endpoint binding when implementing it; schema 1 rejects reserved mode 2.
No Wi-Fi credentials or AP are required for this ESP-NOW slice. Range depends on
the actual installation; longer range is a reason to test the later LAN adapter,
not a guarantee from changing transport names.

Host tests cover configuration corruption, latest-value replacement/expiry,
production V3 golden encoding, V1/V2 compatibility, and Python/browser identity
parity including integers above 2^53. Firmware builds exercise both SDK callback
signatures. Physical pairing/encryption, radio placement/range, acquisition jitter,
stack/heap margin, power cuts, and slow USB transfer of a maximum-size V3 file
remain mandatory hardware checks. No hardware upload or serial access was used
for this implementation.

## Radio-only recovery and portal preparation

A send callback missing for two seconds requests a radio-only restart. SDK
teardown/startup runs in a persistent FreeRTOS worker, outside the acquisition
loop; it unregisters callbacks, deinitializes ESP-NOW, stops Wi-Fi, clears callback
queues, and restores the same saved channel and encrypted peer. Queues remain
allocated throughout. Retries back off from one second to sixty seconds. Invalid
or absent pairing stays off. No Wi-Fi/UDP fallback or NVS write occurs on recovery.

`RADIO RECOVER` requests the same recovery while recording is allowed. `RADIO
STATUS` adds role, recovering, recovery_attempts and recoveries. Normal delivery
failure does not restart the radio or stop sampling. Reconfiguration and unit
reboot remain blocked during recording. Radio polling obtains a fresh clock
internally so a caller cannot prematurely expire a just-offered sample.

`portal/radio.html` prepares or imports a private pairing kit, reads board status,
checks target MAC and role before writing, and exposes radio recovery. Save the
kit before applying, configure both boards from the same kit, reboot and verify
live receiver readings. Current firmware exposing the role field is required.
The Python prepare command also writes `pairing-kit.json` for browser import;
individual files remain usable by its existing apply command. No keys are
published, cached by the page, or included in diagnostics.

The MCU-only bench adds `BENCH TIMEOUT` to drop one send callback deliberately.
This hook is compiled only with `SAUNA_RADIO_BENCH_TEST` in the separate bench
project. It is absent from production firmware.

## Cold standby extension

SAUW V1 status bits 9 and 10 now announce cold standby and its test heartbeat profile. See [power management](power-management.md) for fixed intervals, sequence semantics, paired-update requirements and USB controls. Active recording cadence and SLOG V3 are unchanged.
