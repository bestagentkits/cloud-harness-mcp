# Phase 2: Persisted Mutation Fence & Reconnect Window

## Objectives
- Add `mutation_locked_until` column to `workspaces` table in `StateStore`.
- Update `reapExpired` and `ensureCapacity` to query `expiresAt <= now AND (mutation_locked_until IS NULL OR mutation_locked_until <= now)`.
- Implement `withMutationLease` with database persistence of `mutation_locked_until`.
- Enhance `OperationManager` to retain terminal results for a 10-minute reconnect window with timeout envelope.

## Affected Files
- `apps/runner/src/state-store.ts`
- `apps/runner/src/operation-manager.ts`
- `apps/runner/src/workspace-service.ts`
