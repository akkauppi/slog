# Offline field archives (version 1)

The Lapland workload is eight probes, at most 12 recorded hours total, with a
10-minute power-loss window accepted. Keep the existing partition layout and
60-sample commit interval. V2 encoding costs about 109 KB for 12 hours before
per-session/pretrigger and filesystem overhead. Verify actual free space on the
unit before departure; repeated short sessions and staged artifacts also consume
space. This estimate is not permission to erase existing recordings.

Create an archive from downloaded files, then copy the entire directory to a
second medium and verify that copy with the same command:

```sh
.venv/bin/python tools/archive_logs.py create downloads/*.slog --output archives/lapland-001 --context field-notes.json
.venv/bin/python tools/archive_logs.py verify archives/lapland-001
.venv/bin/python tools/archive_logs.py verify /media/backup/lapland-001
```

Create `archives` first. The output directory must not already exist. The tool
has no device commands and never deletes or rewrites source measurements. No
network or new dependencies are required beyond the existing logger Python
environment. The durable directory-sync implementation targets the field Linux
laptop; other operating systems need validation before use.

An optional `field-notes.json` contains a JSON object of user-supplied context:

```json
{
  "installation_id": "lapland-sauna-1",
  "device_label": "logger-A",
  "experiment_date_local": "2026-09-06",
  "timezone": "Europe/Helsinki",
  "top_probe_below_ceiling_mm": null,
  "calibration_reference": null,
  "notes": "Eight probes; fill in actual placement and observations."
}
```

These are operator assertions, not facts measured by firmware. Omit unknown
values or use null; never infer acquisition UTC from archive creation time.
Context applies to every listed file. Create separate archives where installation
or placement differs. Context is extensible JSON, not a new firmware format.

## Stable archive contract

`manifest.json` has schema `saunan.archive.v1`, an archive-creation UTC timestamp,
a `context` object, and a nonempty `files` array. Each entry has lowercase
`sha256`, integer `bytes`, canonical `path` (`raw/<sha256>.slog`), original
`source_names` (basenames only), and a creation-time `inspection` object. Unknown
manifest fields may be ignored; unknown schema identifiers must be rejected.

Raw SHA-256 identifies exact file contents, independently of device-local session
numbers. Identical input bytes are stored once, with their source basenames;
different files sharing a session number remain separate. The archive does not
infer device identity, link sessions, or claim two identical copies came from
the same device. V1/V2 lack enough identity information to prove those facts.

Every byte is preserved, including unreadable headers and torn tails. Inspection
states are `finalized` (reader reports a footer and no warnings), `recoverable`
(reader decoded a header but the segment is interrupted or has warnings), or
`unreadable`. These are the existing reader's observations, not a stronger
validation of every acquisition or lifecycle invariant. Inspection is historical;
verification does not compare future parser output or warning wording against it.

Verification checks supported schema, canonical unique paths, file sizes, exact
SHA-256 matches, and absence of unlisted raw files. Symlinked archive paths are
rejected. A successful verification establishes raw-byte integrity relative to
the manifest, not authenticity, correct measurements, or complete recordings.
The context and creation-time inspection are not cryptographically authenticated.

The writer exclusively creates the output directory, synchronizes raw files,
then publishes the synchronized manifest by rename. A failed creation leaves its
partial directory for recovery and never overwrites it on retry. Without a valid
`manifest.json`, verification fails. Keep that directory and retry into a new
name; the tool does not clean up possibly valuable data automatically.

Keep original archives immutable by convention. For revised notes, create a new
archive from the same raw files and retain the previous one. Future `.slog`
versions can use this archive without changing their raw bytes or this envelope;
older inspection tools may label them unreadable while still preserving them.

V3 integration update: the same archive also preserves and inspects V3. New
recording payload uses about 177 KB per 12 hours before block/pretrigger and
filesystem overhead; firmware start reserve is now 256 KiB. Partitions and the
accepted ten-minute loss window remain unchanged. See
[the V3 identity contract](sample-identity-and-radio.md).
