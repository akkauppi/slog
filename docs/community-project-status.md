# Community project status

Last updated: 2026-08-18, Europe/Helsinki.

This is the rolling handoff for the community-project work. Update it when a
session changes the active branch, pull request, completed slice, or immediate
next action. The longer-term design remains in
[`community-project-plan.md`](community-project-plan.md).

## Repository snapshot

- Repository: `akkauppi/saunan`
- Remote base: `origin/main` at `3a43bb8`
- Active branch: `agent/community-roadmap`
- Roadmap commit: `88c4c40` (`Document community project roadmap`)
- Remote branch: `origin/agent/community-roadmap`
- Local and remote branch were synchronized with a clean worktree before this
  handoff was added.
- No pull request exists for `agent/community-roadmap` as of this update.

The earlier `agent/document-example-sauna-run` branch belongs to merged PR #1
and must not be reused for new work.

## Completed

- Added the community roadmap covering the reference build, generic probe
  commissioning, browser flashing and management, local analysis, metadata,
  public catalog, governance, licenses, and release gates.
- Adopted a one-primary-outcome rule for each slice and pull request: ship and
  verify the narrow outcome first, then discuss independently deliverable
  extensions.
- Split raw-session preservation from generic probe commissioning. Preservation
  is now Slice 1; commissioning follows only after that focused change is
  merged.
- Recorded hot-start/public-sauna behavior as a first-class observation mode,
  including automatic stabilization estimation, left-censored threshold
  semantics, and separate heating/steady-state/cooling coverage.
- Chose one offline-first portal for building instructions, released firmware,
  commissioning, retrieval, and local analysis. Publishing is an explicit
  online action into a small private inbox followed by manual review and a
  generated static catalog; contributors do not file GitHub issues or create
  Zenodo records.
- Assigned Zenodo the narrower role of periodic, curated dataset snapshots with
  versioned archival citations rather than one archive deposit per submitted
  run.
- Kept the initial data model focused on temperatures and minimum comparison
  metadata. An occupancy switch and structured experience questions are
  deferred; the first release allows only an optional observation note for that
  context.
- Recorded canonical SI storage with metric and imperial input/display.
- Recorded the Git workflow: one short-lived branch and draft PR per coherent
  slice, with no long-lived redesign branch.
- Linked the roadmap from the README and clarified that public raw `.slog`
  files retain stable probe ROM identifiers.
- Reviewed the documentation for conflicts with `AGENTS.md` and checked it for
  trailing whitespace and Git diff errors.

No firmware, log-format, analysis, build, partition, or hardware state was
changed. Firmware tests were not run because the branch changes documentation
only.

## Publication status

The branch and commit are safely pushed. Draft PR creation was attempted but
did not complete:

1. The GitHub app returned an internal error after timing out.
2. `gh pr create` reached GitHub but its GraphQL endpoint returned HTTP 503 on
   two attempts.
3. A subsequent GitHub PR search confirmed that no duplicate or partial PR was
   created.

GitHub CLI authentication for account `akkauppi` was verified successfully.
The failure appeared to be a transient GitHub service problem rather than a
repository or authentication problem.

The intended PR is:

- Base: `main`
- Head: `agent/community-roadmap`
- Draft: yes
- Title: `Document community project roadmap`
- Scope: `README.md` and the roadmap/status documentation only

The PR description should summarize the roadmap and branch workflow, explain
that it establishes reviewable boundaries for later firmware/web/data work,
state that runtime behavior is unchanged, and list the documentation checks.

## Start here next session

1. Confirm the checkout is on `agent/community-roadmap` and clean:

   ```sh
   git status -sb
   git log -3 --oneline --decorate
   ```

2. Confirm GitHub still has no PR for the branch, then retry creating the draft
   PR. Prefer the connected GitHub app; use `gh pr create` if necessary.
3. Review the rendered Markdown and PR diff. Merge only after the roadmap is
   acceptable; there are no firmware checks required for this documentation-only
   PR.
4. Fetch the merged `main`, then create a new short-lived branch for the first
   implementation slice. Do not continue implementation on the roadmap branch.
5. Start Slice 1 with the preservation fix: remove unverified automatic session
   deletion and make insufficient reserve block a new session without deleting
   existing raw logs. Make preservation under storage pressure the PR's only
   primary outcome.
6. After Slice 1 is reviewed and merged, start a new branch for Slice 2 generic
   probe commissioning. Do not combine its NVS mapping or USB protocol work
   with the preservation PR.

All later work—including commissioning, the offline-first portal, analysis,
private intake, and static publication—must continue to preserve ROM-based
identity, the fixed eight-probe geometry, power-cut safety, CRC validation,
explicit interruption metadata, manual filesystem formatting, Wi-Fi disabled,
RTC diagnostics, and the committed partition layout.
