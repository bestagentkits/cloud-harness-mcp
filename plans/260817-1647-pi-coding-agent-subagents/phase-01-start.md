---
phase: 1
title: "Contract, policy, and durable state"
status: pending
priority: P1
effort: "2-3d"
dependencies: []
---

# Phase 1: Contract, policy, and durable state

## Overview

Define the additive public contract and durable state machine before launching Pi or exposing side effects. Tests pin every bound, annotation, migration, idempotency rule, and non-enumerating ownership check.

## Requirements

- Add opaque `AgentIdSchema` and the six operation names to the canonical runner enum.
- Define bounded schemas for prompt/message text, lineage, configured profile, a caller subset of a closed `AgentProxyOperationSchema`, TTL, output bytes, token/cost budgets, status lookup, cursors, and list pagination. Reject agent spawn unless the workspace network mode is `none`.
- Mark annotations truthfully: status/logs/list read-only; spawn/message/cancel destructive; spawn/message/cancel idempotent; only spawn/message have open-world model effects.
- Add validated runner configuration for agent image/network, global/principal/workspace active and lifetime record caps, TTL/log/event/token/cost ceilings, cancellation grace, retention/lookup horizons, and public model-profile metadata. Gateway secret paths and environment remain service-specific and absent from runner/API config.
- Migrate SQLite from schema version 1 with transactional agent, message-idempotency, usage, log-chunk/watermark, cleanup-retry, and tombstone tables. Every lookup includes principal and workspace; global/principal/workspace row/byte/age quotas bound closed history.
- Persist spawn reservation before Docker/model/tool side effects. Use `BEGIN IMMEDIATE` to check capacity, workspace status/generation, parent status/generation, and admission fences in the same transaction as child insertion. Unique `(principal, workspace, idempotencyKey)` replay rejects mismatched payloads.

## Architecture

`RunnerOperationSchema -> exhaustive tool schema map -> generated TOOL_SPECS -> MCP registration -> version-1 runner request -> explicit AgentManager dispatch`. Agent-specific states live under the existing result envelope; no generic envelope change or public identity field.

Durable rows include agent/principal/workspace/parent IDs, prompt hash, profile/tool/budget snapshot, generation, deterministic container/network identity, state, timestamps, usage, terminal/cleanup reason, unknown-outcome flag, and log cursor offsets. Message rows use `RESERVED`, `SENT`, `REJECTED`, or `UNKNOWN` delivery state fenced by agent generation. Keep a fixed lifetime record cap per active workspace so idempotency keys remain authoritative until workspace close; compact closed-workspace logs/rows transactionally after the documented lookup horizon.

## Related code files

- Modify: `packages/contracts/src/identifiers.ts`, `runner-api.ts`, `tool-schemas.ts`, `config.ts`
- Modify: `apps/runner/src/config.ts`, `state-store.ts`
- Test: `packages/contracts/test/contracts.test.ts`, `cloudharness-skill-contract.test.ts`, `apps/runner/test/state-store.test.ts`

## TDD implementation steps

1. Add failing identifier/schema/annotation tests for all valid defaults and every upper/lower boundary.
2. Add failing state-store migration/reopen/rollback tests from a schema-1 database and new-database tests for schema 2.
3. Add concurrent `BEGIN IMMEDIATE` reservation tests: same key/same payload replays one ID; same key/different payload conflicts; final capacity slot admits exactly one; spawn loses to parent cancellation or workspace reaping.
4. Add ownership/lineage tests for foreign/missing agent equivalence, cross-workspace parents, cycles, message delivery states, fixed record caps, tombstone horizons, and global/principal/workspace retention.
5. Implement contract schemas/config and focused agent state/log repositories backed by the existing database with atomic append/evict/watermark transactions.
6. Run contract and state-store suites before continuing.

## Success criteria

- [x] Six tools have exact schemas, titles, and annotations with no enum/spec drift.
- [x] Schema 1 upgrades transactionally to schema 2 without losing workspace rows; failed migration/rollback leaves the original usable.
- [x] Durable spawn/message state survives process reopen and never reports a duplicate or unknown delivery as successful.
- [x] Principal/workspace predicates and generation/admission fences apply before existence, logs, status, lineage, message, spawn, or cancellation details/actions.
- [x] Configuration rejects missing paired values, provider secrets in runner/API profile data, unsafe profile URLs, network-enabled agent workspaces, unsafe proxy operations, and unbounded limits/retention.

## Risk assessment

The highest risk is treating idempotency and admission as metadata rather than one durable side-effect fence. Reserve, capacity-check, workspace/parent generation-check, and child insertion in one immediate transaction; retain tombstones for the fixed active-workspace lifetime and reject new work when the cap is full.
