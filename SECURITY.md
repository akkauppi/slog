# Security policy

## Supported versions

Security fixes target the current `main` branch and the firmware/portal package
currently published from it. Older commits, locally modified builds, and
third-party mirrors are not maintained as supported releases.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could expose data, bypass
firmware-package validation, corrupt retained records, weaken recovery, or
mislead users about a destructive operation.

Use GitHub's
[private vulnerability reporting](https://github.com/akkauppi/slog/security/advisories/new).
If that option is unavailable, contact the maintainer privately through
[@akkauppi's GitHub profile](https://github.com/akkauppi) without including
exploit details in public. Include the affected commit or portal URL, impact,
reproduction conditions, and a minimal proof of concept when safe.

The project aims to acknowledge a complete report within seven days. Timing of
a fix or disclosure depends on severity, hardware access, and the need to
preserve user data during upgrades.

## Safety and privacy

A raw `.slog` record and some diagnostics can contain stable probe ROM
addresses. Redact them unless they are necessary to reproduce the issue. Do not
send exact locations, occupant identities, health data, Wi-Fi credentials, or
unrelated serial output.

SLOG is not a certified safety controller. General questions about mains
wiring, heater control, hot-zone materials, or medical use are not security
vulnerabilities and should not be tested on people or live installations as a
proof of concept.
