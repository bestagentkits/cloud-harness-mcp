# Phase 4: Remote-Git Unified Idempotency, CAS & Error Taxonomy

**Status:** completed
**Priority:** High  
**Dependencies:** Phase 1

## Requirements
- Preserve existing CAS push in `worker/git-transfer-helper.sh` (`--force-with-lease=<ref>:<expectedRemoteOid>`), `packages/contracts/src/tool-schemas.ts`, and `apps/runner/src/workspace-service.ts`.
- Replace/unify `finalize_idempotency` with `git_operation_idempotency` table: store transaction records with request fingerprint before push/finalize execution.
- If a subsequent retry arrives with the same `idempotencyKey` and request fingerprint matches, return the previous result with `alreadyFinalized: true`. If fingerprint differs, reject with `CONFLICT`.
- Enhance error taxonomy in `packages/contracts/src/mcp-results.ts`:
  - `UNKNOWN_REMOTE_STATE` when network times out during push, with structured payload containing `resumeAction: "reconcile_push"`.
  - `STALE_HEAD` / `CONFLICT` when CAS lease is rejected or `expectedHeadOid` does not match.
- For `git_commit`, add optional `expectedHeadOid` verification rejecting commits with `CONFLICT` (`STALE_HEAD`) if workspace HEAD changed.
- Implement remote reconciliation: probe remote ref via `git ls-remote` before re-pushing on `UNKNOWN_REMOTE_STATE`.

## Files to Modify / Create
- `apps/runner/src/workspace-service.ts` (Modify: Push idempotency checking, error classification for CAS vs network drop)
- `packages/contracts/src/tool-schemas.ts` (Modify: Ensure `expectedHeadOid` on `git_commit` schema)
- `packages/contracts/src/mcp-results.ts` (Modify: Ensure error codes include `UNKNOWN_REMOTE_STATE`, `STALE_HEAD`)
- `apps/runner/test/git-push-durability.test.ts` (Create: Tests for idempotency, CAS rejection, unknown-outcome recovery)

## Implementation Steps
1. Extend `git_commit` schema with optional `expectedHeadOid` and validate against workspace HEAD before commit.
2. Store push transaction in `git_operation_idempotency` table in `StateStore`.
3. In `remotePush()`, handle network failures by returning structured error with code `UNKNOWN_REMOTE_STATE` and `resumeAction: "reconcile_push"`.
4. Handle CAS failure with clear `CONFLICT` error containing `currentRemoteOid` and `expectedRemoteOid`.
5. Add unit tests for CAS push conflict, retry idempotency, and network error classification.

## Tests and Validation
- `npm run test:unit apps/runner/test/git-push-durability.test.ts`
