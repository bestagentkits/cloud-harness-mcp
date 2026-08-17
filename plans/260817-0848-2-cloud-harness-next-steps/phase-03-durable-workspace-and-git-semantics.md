---
phase: 3
title: "Durable workspace and Git semantics"
status: pending
priority: P1
effort: "5-8d"
dependencies: [1, 2]
---

# Phase 3: Durable Workspace and Git Semantics

## Overview

Build durability around the credential-isolated Git contract delivered by the
in-progress `Complete coding harness tool surface` plan. The existing
independent-clone workspace remains the safe fallback; a repository cache is
an optimization only after it proves safe for each owner.

## Requirements

- [ ] Introduce a durable, owner-bound repository record separate from a
  workspace and define cache/worktree lifetime, locking, and cleanup rules.
- [ ] Keep each executor's writable checkout isolated; never share writable
  `.git` state across principals.
- [ ] Consume the accepted helper-mediated fetch/push contract from the
  dependent tool-surface plan; do not reimplement its credential boundary.
- [ ] Extend the remote Git contract with durable expected-head, idempotency,
  conflict, and unknown-outcome records where the accepted implementation does
  not already provide them.
- [ ] Persist task metadata/log cursors and bounded artifacts separately from
  runner-memory handles; decide whether to additionally expose the MCP Tasks
  extension after validating host support.

## Related Code Files

- Modify: `packages/contracts/src/identifiers.ts`, `packages/contracts/src/runner-api.ts`, `packages/contracts/src/tool-schemas.ts`, `apps/runner/src/state-store.ts`, `apps/runner/src/workspace-service.ts`, `apps/runner/src/operation-manager.ts`, `apps/runner/src/github-app-broker.ts`.
- Create: focused repository-cache, artifact-store, and trusted Git-helper modules only after the data model is approved.
- Test: `apps/runner/test/state-store.test.ts`, `apps/runner/test/github-app-leak.test.ts`, `test/e2e/coding-workflow.docker.test.ts`.

## Implementation Steps

1. Wait for the dependent tool-surface plan’s Git contract and tests to be
   accepted, then measure clone, disk, and concurrency pressure; retain independent clones
   when a cache has no demonstrated benefit.
2. Extend SQLite with repository, task result, and artifact metadata using a
   versioned migration and bounded retention.
3. Implement owner-scoped cache/capsule acquisition with explicit locks and
   no cross-owner writable sharing.
4. Integrate with—not duplicate—the accepted helper-mediated fetch/push
   boundary, then add only missing durable expected-head/idempotency records.
5. Add cursorable logs,
   cleanup, restart reconciliation, and adversarial credential-leak tests.

## Todo

- [ ] Repository and task/artifact data model accepted.
- [ ] Helper-mediated Git contract and conflict semantics documented.
- [ ] Migration, restart, cleanup, and leak tests pass.

## Success Criteria

- [ ] A retry cannot silently duplicate a commit/push when its expected head
  has changed.
- [ ] Private credentials never appear in executor environment, checkout,
  remote URL, output, artifacts, or logs.
- [ ] Restart/TTL/close cleanup removes only verified owner-scoped state.

## Risk Assessment

Repository caching and durable Git state add the most authority in this
roadmap. Reuse the dependent plan’s runner/helper token boundary and preserve
the credential-free clone fallback for failure recovery.
