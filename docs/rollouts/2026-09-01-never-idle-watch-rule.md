# 2026-09-01 - Never idle-watch a PR (AGENTS.md rule)

## Context & Objective

Codifies one operational rule in this repo's AGENTS.md: do not poll a PR waiting for it to merge. A PR that is not merging is waiting on an action: unresolved review threads, a merge conflict, a failing or never-dispatched `verify`, auto-merge not armed, or a branch behind `main`. Diagnose which one and take that action instead.

## Changes Made

Docs only. AGENTS.md gains the never-idle-watch rule in the Pull requests section, phrased for the Fleet Tools relay route (`gr_wf_automerge_enable` and relay reads, no direct gh commands). CLAUDE.md is a symlink to AGENTS.md and carries the same text.

## Decisions & Trade-offs

- The rule names a diagnosis, not a prohibition on waiting: one bounded wait on the PR's checks is allowed; repeated polling is not.
- Earlier drafts of this note carried a dated owner attribution and direct gh commands. Both were removed: the attribution is not verifiable from an authenticated channel, and direct gh commands do not match the Fleet Tools relay route this repo's AGENTS.md prescribes.
