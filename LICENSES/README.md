# SLOG licensing

SLOG uses different standard licenses for software, documentation, hardware
designs, and published measurements. The path containing a file determines
which license applies.

| Material | Scope | License |
| --- | --- | --- |
| Software | Firmware, portal code, analysis tools, tests, build files, and repository automation unless stated otherwise | [Apache License 2.0](../LICENSE) (`Apache-2.0`) |
| Documentation | Original project prose in top-level Markdown files and under `docs/` | [Creative Commons Attribution 4.0 International](CC-BY-4.0.txt) (`CC-BY-4.0`) |
| Hardware designs | Design-source files under `hardware/` when that directory is added | [CERN Open Hardware Licence Version 2 — Permissive](CERN-OHL-P-2.0.txt) (`CERN-OHL-P-2.0`) |
| Measurements and catalog metadata | Material under `data/`, including raw records and derived plots | [CC0 1.0 Universal](CC0-1.0.txt) (`CC0-1.0`) |

The repository-root `LICENSE` is the default for software and lets GitHub
identify the primary code license. Policy files and license notices are not
hardware designs or measurement submissions merely because they describe
those materials.

For CC BY 4.0 attribution, credit “SLOG contributors” and link to
<https://github.com/akkauppi/slog>. Copyright remains with the respective
contributors.

Third-party material keeps its upstream license. In particular, files under
`portal/vendor/` are covered by the notices stored alongside them and are not
relicensed by SLOG.

Contributions are accepted under the license assigned to their destination.
See [CONTRIBUTING.md](../CONTRIBUTING.md) before submitting code, documentation,
hardware designs, or measurements.
