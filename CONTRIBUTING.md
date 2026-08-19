# Contributing to SLOG

SLOG welcomes focused fixes, tests, documentation, and hardware-design work.
It is preparing a separate, carefully reviewed path for measurement
contributions. Open an issue before a large or architectural change so its
scope and safety implications can be agreed first.

## Before opening an issue

Use the issue forms for bugs and proposals. Security vulnerabilities belong in
the private process described in [SECURITY.md](SECURITY.md), not in a public
issue. Do not attach raw `.slog` records, serial transcripts, or probe maps
until you have checked them for stable DS18B20 ROM addresses and personal
context.

The community dataset intake is not open yet. A raw record being useful to the
project does not make it safe or authorized to publish. Until the documented
review and consent path exists, discuss a possible contribution without
uploading the file.

## Pull requests

1. Keep each pull request centered on one coherent change.
2. Explain the problem, the chosen behavior, and any compatibility or safety
   effect.
3. Add or update automated tests for behavior changes.
4. Update user-facing documentation when commands, workflows, formats, or
   hardware guidance change.
5. Complete the pull request checklist and wait for the repository checks.

For firmware changes, run:

```sh
.venv/bin/python -m unittest discover -s tests -v
.venv/bin/pio run
```

For portal-only changes, also run:

```sh
npm test
```

Use `tools/serve_portal.py` for local browser testing and reuse its existing
managed server. Do not start an ad-hoc HTTP server or silently switch ports.

## Project invariants

Contributions must preserve the behavioral and hardware rules in
[AGENTS.md](AGENTS.md). In particular, probe identity is by ROM address, power
loss is normal, CRC-valid completed blocks are preserved, unknown time gaps
remain unknown, LittleFS is never formatted automatically, Wi-Fi remains off,
and partition changes require decoding the generated partition table.

Hardware guidance must distinguish tested facts from proposals. Do not present
mains wiring, hot-zone electronics, enclosure materials, or human-safety
limits as validated without appropriate evidence and review.

## Licensing contributions

By submitting a contribution, you agree that it may be distributed under the
license assigned to its destination in [LICENSES/README.md](LICENSES/README.md):
Apache-2.0 for software, CC BY 4.0 for documentation, CERN-OHL-P-2.0 for
hardware designs, and CC0 for measurements and catalog metadata. Mark material
that you do not intend as a contribution clearly and do not submit content you
do not have permission to license.

All contributors must follow the [Code of Conduct](CODE_OF_CONDUCT.md).
