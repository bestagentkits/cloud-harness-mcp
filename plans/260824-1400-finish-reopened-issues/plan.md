# Plan: Complete Reopened Issues (#89, #90, #91, #94)

**Status:** IN_PROGRESS
**Created:** 2026-08-24
**Branch:** mrgoonie/finish-reopened-issues
**Route:** Feature & Hardening
**Mode:** Official Stable (--ship)

## Overview
Deliver the complete, rigorous implementations for the remaining acceptance criteria of issues #89, #90, #91, and #94:
1. **Issue #89:** Compound `issue_publish` action in `github_action` for atomic comment posting and label mutations in one call with idempotency.
2. **Issue #91:** Snapshot-bound pagination cursors with deterministic `CONFLICT` stale-cursor detection when underlying files/commits change.
3. **Issue #94:** Persisted mutation fence (`mutation_locked_until`) in SQLite `StateStore` to protect all mutations from concurrent reaping.
4. **Issue #90:** Comprehensive operation tracking across all potentially long operations, 10-minute terminal result reconnect window, and structured timeout envelope with `retryAfterMs`, `deadline`, and `retryable`.

## Phases
- [Phase 1: Contracts & Tool Schemas](./phase-01-contracts-and-schemas.md)
- [Phase 2: Persisted Mutation Fence & Reconnect Window](./phase-02-persisted-fences-and-reconnect.md)
- [Phase 3: Compound GitHub Action & Snapshot-Bound Cursors](./phase-03-compound-github-and-snapshot-cursors.md)
- [Phase 4: Verification, Quality Gates & Release](./phase-04-verification-and-release.md)

## Acceptance Criteria
- [ ] `github_action` supports compound `issue_publish` (comment + add/remove labels) with idempotency (#89).
- [ ] Pagination cursors encode snapshot identity and return `CONFLICT` stale-cursor error when underlying files or commits change (#91).
- [ ] `StateStore` and `WorkspaceService` persist `mutation_locked_until` in SQLite so mutations cannot be reaped mid-flight even across runner passes (#94).
- [ ] All potentially long-running operations return tracked `operationId` with 10-minute reconnect retention and structured timeout responses (#90).
- [ ] All 50+ test suites pass, `npm run verify` passes, and CI is 100% green.
