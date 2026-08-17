# Phase 1 — Contracts and local primitives

## Context

- Public schema owners: `packages/contracts/src/runner-api.ts`, `packages/contracts/src/tool-schemas.ts`.
- Runtime owners: `apps/runner/src/workspace-service.ts`, `apps/runner/src/operation-manager.ts`, `worker/harness-worker.mjs`.

## Work

- Add bounded file delete/move/directory operations.
- Add Git add/merge/rebase primitives with option-shaped argument rejection.
- Add named process sessions without claiming restart durability.
- Add dependency-aware tasks and a graph projection.
- Add ctags-backed symbol definitions and lexical reference search.
- Add repository-manifest deployment listing/execution without secret injection.

## Validation

- Extend contract and worker-focused tests first, then the real MCP Docker E2E workflow.
- Verify cleanup and retention bounds for sessions and dependency tasks.

## Risks and rollback

- New mutable tools widen remote-code-execution capability; annotations and docs must remain explicit.
- Roll back by reverting the additive schema/handler/worker changes together.

## Completion

- [x] Contracts, local primitives, lifecycle bounds, and focused coverage are complete.
