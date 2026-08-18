# Probe commissioning protocol

This protocol is the firmware boundary for the Python commissioning tool and
the planned browser portal. It is newline-delimited ASCII over the normal USB
serial connection at 115200 baud. Version 1 keeps all existing `LOG ...`
commands and autonomous `TELEM ...` lines backward compatible.

## Configuration model

The only supported geometry is `column8_20cm_v1`:

- P1 is the top probe, farthest from the ESP32, at relative height 0 cm.
- P2 through P8 descend toward the ESP32 in 20 cm steps.
- P8 is at relative height -140 cm.

A valid mapping contains exactly eight unique, family-`0x28`, CRC-valid
DS18B20 ROM addresses. Discovery order is never used as identity.

The device stores two independent record keys in the `probe_cfg` NVS namespace.
Each 84-byte record contains a magic value, schema version, record size,
nonzero generation, geometry ID, sensor count, ordered ROM addresses, and
CRC32. Boot selects the wrap-aware newest valid generation. Equal conflicting
generations and a half-range generation difference are ambiguous and disable
logging.

There is no separate active-slot pointer. `CFG BEGIN` and `CFG SET` modify only
RAM. `CFG COMMIT` validates the complete mapping and current bus, writes the
inactive slot, reloads both slots, and accepts the commit only after exact
readback. It never erases the previous valid slot. The newly stored mapping is
activated only by reboot, keeping one immutable mapping in use by acquisition
and log-header generation for the entire boot.

Commissioning never formats LittleFS or deletes logs. A corrupt, missing,
ambiguous, or unavailable configuration fails closed: USB probe scans and log
retrieval remain available, but a recording cannot start. The store uses
ESP-IDF NVS calls directly so `not found` remains distinguishable from an I/O
error; an unreadable slot never silently falls back to an older map.

An ambiguous pair is intentionally not overwritten by the version 1 commit
path. It can arise only from externally written conflicting valid records or a
half-range generation conflict, not from the normal alternating-slot sequence.
There is not yet a power-cut-safe marker-based reset command. If this state is
reported, preserve the device and its logs for a recovery tool rather than
erasing the whole flash.

## Commands

Clients should ignore unrelated boot diagnostics, `TELEM` messages, and logger
events while waiting for the named response frame.

### Device information

```text
> SYS INFO
< SYS_INFO protocol=1 product=sauna_logger firmware=0.3.0-dev commit=unknown partition=sauna_ota_v1 ota=app0 configured=1 active_generation=7 restart_required=0 commissioning=0 compatibility=SAUNA_COMMISSIONING_PROTOCOL=1
```

Compatibility is determined from `protocol`, `product`, `partition`, and the
running OTA slot. A client must require protocol `1`, product `sauna_logger`,
partition `sauna_ota_v1`, and slot `app0` or `app1` before sending `CFG BEGIN`.
Release builds will replace the development firmware and commit values.

### Discover probes

`CFG SCAN` is allowed while no session is active and the logger is either
unconfigured or explicitly in commissioning mode. It starts a fresh temperature
conversion, reports ROM-sorted results for deterministic display, and does not
assign physical positions. Requiring a transaction on an already configured
logger prevents diagnostic polling from shifting or starving normal 10-second
acquisition.

```text
> CFG SCAN
< CFG_SCAN_BEGIN count=2 bus_count=2 overflow=0
< CFG_SCAN_SENSOR rom=2825E1BD00000058 temperature_c=21.31 mapped_position=1
< CFG_SCAN_SENSOR rom=2856BE530000003F temperature_c=NA mapped_position=0
< CFG_SCAN_END count=2
```

`temperature_c=NA` means the address was discovered but no valid reading was
available. `mapped_position=0` means the active boot mapping does not contain
that ROM. Results may be sorted for presentation only.

### Read configuration

```text
> CFG GET
< CFG_GET_BEGIN state=valid generation=7 geometry=column8_20cm_v1 count=8 valid_slots=2 detail=ready restart_required=0
< CFG_MAP position=1 relative_height_cm=0 rom=2825E1BD00000058
< ...
< CFG_MAP position=8 relative_height_cm=-140 rom=2801F3520000001E
< CFG_GET_END count=8 crc32=89ABCDEF
```

The stable wire states are `unconfigured`, `valid`, and `invalid`. The additive
`detail` field distinguishes internal causes such as `corrupt`, `ambiguous`, or
`storage_unavailable`. Clients must preserve P1-to-P8 order and verify the
complete readback after committing.

### Stage and commit

```text
> CFG BEGIN geometry=column8_20cm_v1
< CFG_BEGIN ok=1 geometry=column8_20cm_v1

> CFG SET position=1 rom=2825E1BD00000058
< CFG_SET ok=1 position=1 rom=2825E1BD00000058

...set every position exactly once...

> CFG COMMIT
< CFG_COMMIT ok=1 generation=8 crc32=0123ABCD reboot_required=1
```

`CFG COMMIT` requires that the currently discovered set is exactly the staged
eight-ROM set. After the acknowledgement, the client must issue `CFG GET` and
compare all positions before activating it:

```text
> SYS REBOOT
< SYS_REBOOT ok=1
```

The port normally disconnects and re-enumerates after this acknowledgement.
If a write or readback result is ambiguous, logging remains suspended and a
reboot is required so boot-time slot selection can determine the valid
generation.

The commissioning client must reconnect after reboot before reporting success.
It verifies `configured=1`, `restart_required=0`, and the exact committed
`active_generation` from `SYS INFO`; then it re-reads the ordered configuration
and opens a short commissioning transaction while `CFG SCAN` checks that the
same eight ROMs are present. It then explicitly aborts that diagnostic
transaction. Only after these checks does it replace the verified local
`sensor-map.json`.

`CFG ABORT` is idempotent and discards only RAM staging. If no commit may have
reached flash, it resumes normal idle sampling with the boot mapping. An idle
staging transaction times out after ten minutes without a scan, set, or
`CFG KEEPALIVE` command. Interactive clients send a serialized keepalive once
per minute while waiting at user prompts. A timeout clears the staged RAM map
but deliberately keeps logging suspended; the operator must start again, issue
`CFG ABORT`, or reboot. Rearranging probes therefore cannot silently time out
and resume logging with the previous map. `SYS INFO commissioning=1` exposes
this lock; the commissioning client sends the idempotent abort when it recovers
an abandoned, non-restart-required transaction.

### Errors

Rejected configuration commands produce a terminal response such as:

```text
CFG_ERROR command=commit code=probe_set_mismatch
```

System-command failures use the same convention with `SYS_ERROR`. Codes are
stable machine-readable tokens; UI text should be supplied by the client.

## Recommended wizard

The primary workflow begins a transaction, asks the builder to disconnect all
probes, and then adds exactly one new probe per scan from P1 to P8. The set
difference must contain exactly one addition and no disappearance. For a sealed
harness, the alternative workflow learns five ambient scans and accepts a
warmed probe only after it rises by at least 3 C and leads every other unmapped
probe by at least 1 C.

The client saves partial progress locally as `sensor-map.pending.json`, but only
the readback-verified NVS record makes the device configured. It atomically
replaces `sensor-map.json` only after that readback and keeps the old verified
file if commissioning is interrupted. The final JSON is a backup and future
portal import format; it is not the logger's runtime source of truth.

The version 1 JSON object records `schema_version`, `device`, `one_wire_pin`,
`geometry`, orientation, spacing, and an ordered `sensors` array. Each sensor
has `position_from_reference_end`, `relative_height_cm`, and `rom`. Files written
after a successful activation also record `configuration_generation` and
`configuration_crc32`; migrated pre-commissioning maps may omit them. Pending
files may contain fewer than eight sensors and omit those two fields.
