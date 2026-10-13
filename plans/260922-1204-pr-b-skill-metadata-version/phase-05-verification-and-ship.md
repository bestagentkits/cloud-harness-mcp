---
phase: 5
title: "Verification, docs and ship"
status: in_progress
priority: P1
effort: "2-3h"
dependencies: [4]
---

# Phase 05 — Verification, docs and ship

## Tests

- Migration: v11 → v12 applies once, is idempotent, preserves rows as `NULL`.
- Trigger: an `UPDATE` changing `version` aborts; unrelated updates still work.
- Parser: the accept/reject matrix from phase 02, including hostile roster text.
- Contract: `version` optional, malformed refused, unknown fields still rejected.
- Behaviour: non-bump warns and still creates the revision.
- Dashboard: Version column, revision version, empty state, drift warning.

## Docs and guidance

Because this changes a public contract and a workspace-facing feature, both doc
surfaces move together:

- `docs/` — the skills/contract document that owns `skill_revision_create` and
  `skill_create_custom` inputs, and the version semantics (store, warn on drift,
  reject malformed).
- `docs-site/dashboard/skills.md` — operator-facing description of the Version
  column and the drift warning.
- `.agents/skills/cloudharness/` — tool-usage guidance for the new field, then
  `npm run plugin:sync` so `.agents/skills/cloudharness/` and
  `plugins/cloud-harness/skills/cloudharness/` stay byte-identical.
- `npm run docs:reference` if the tool/contract reference surface changed.

## Gate

`npm run verify` plus `npm run verify:compose`, `npm run docs:reference`,
`npm run docs:check`, `npm run docs:build`. Runner changes touch a database
migration, so also exercise the runner suite directly before the full gate.

## Ship

Branch off updated `main`, squash-merge after CI is green, then watch the
deploy. Confirm the promoted `release-current` on the host and `readyz`, and
remember that a deploy restarts the runner — so it is also the moment the
`dependency-access` admission fix from v0.57.1 is exercised again in production.

## Definition of done

- All acceptance criteria in `plan.md` hold.
- Docs, docs-site and skill guidance updated and in sync.
- Merged, released, deployed, and production verified healthy.
