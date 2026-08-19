# Governance

SLOG is currently maintained by [@akkauppi](https://github.com/akkauppi).
Project decisions are made in repository issues and pull requests whenever the
discussion can be public.

## Review and merge rules

A change may be merged when:

- its purpose and scope are documented;
- the relevant automated checks pass;
- behavioral, data-integrity, privacy, and hardware-safety effects are covered;
- user-facing behavior and formats are documented; and
- a maintainer accepts the change.

The maintainer may merge their own work after the same evidence is recorded.
Small documentation fixes can use proportionate validation. Changes to data
formats, retention, power-loss behavior, firmware installation, hardware
requirements, privacy boundaries, or licensing require explicit maintainer
review.

Releases and the hosted portal are built from `main`. Short-lived topic
branches are removed after merge. Git history, issues, and pull requests are
the decision record; major reversals should explain why the earlier decision
no longer fits.

## Community measurements

Measurement intake remains curated and closed until the versioned metadata,
consent, privacy review, and durable snapshot process described in the project
plan is implemented. Maintainers may decline a technically valid record when
its consent, privacy, provenance, or comparability is unclear.

Governance can evolve as more maintainers take sustained responsibility. Such
changes should be proposed publicly and recorded in this file.
