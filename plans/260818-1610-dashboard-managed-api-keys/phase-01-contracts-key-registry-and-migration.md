---
phase: 1
title: "Contracts, key registry, and reversible migration"
status: completed
priority: P1
effort: "1.5-2d"
dependencies: []
---

# Contracts, key registry, and reversible migration

## Context links

- [Plan](./plan.md)
- [Internal runner contract](../../packages/contracts/src/internal-runner-api.ts)
- [Metadata schema](../../apps/runner/src/metadata-schema.ts)
- [Principal store](../../apps/runner/src/principal-store.ts)
- [Recovery](../../docs/operations.md)

## Overview

Add an internal-only lifecycle contract and principal-owned SQLite registry. Public MCP names and tool inputs remain unchanged.

## Requirements and architecture

- Extend version-2 internal runner operations with `api_key_create`, `api_key_list`, `api_key_revoke`; define a separate service-authenticated verification schema so presented keys never become general runner operations.
- Generate with `randomBytes(32)` and strict `chm_key_<random-public-id>.<secret>` format. Persist only immutable random ID, `principal_id`, SHA-256 hash, safe display prefix, name, `ACTIVE|REVOKED`, positive generation, and created/expires/last-used/revoked timestamps.
- Accept a normalized name and integer `expiresInDays` `1..365`; never accept caller principal/hash/expiry timestamp/state/ID/prefix.
- Enforce 10 active, unexpired keys within the same `BEGIN IMMEDIATE` create transaction; test concurrent creators.
- Principal-qualify list/revoke; foreign and missing IDs are indistinguishable. Revoke uses expected-generation CAS.
- Runner owns generation and returns plaintext only through a dedicated typed successful-create response, never generic `ToolResultSchema`. List/revoke/auth verification and every error are safe metadata only. Audit create/revoke without secret/hash.
- Successful verification conditionally updates `last_used_at` at a fixed coalescing interval after the auth decision.

## Related files

- Modify contracts internal schema/exports and tests.
- Modify runner metadata schema/store, dashboard control service, internal operation dispatch, and app.
- Create focused `apps/runner/src/api-key-store.ts` plus narrow verification service if needed.

## Implementation steps

1. Write contract tests for lifecycle inputs, expiry, strict objects, safe responses, and exclusion from public runner operations.
2. Add metadata schema v2 with `api_keys`, unique hash, and safe-prefix plus principal/state/expiry indexes.
3. Implement transactional v1→v2 and idempotent v2 restart; reject future versions.
4. Add a quiesced v2→v1 rollback command that drops only API-key state, resets version to 1, and preserves all unrelated tables/data.
5. Implement generation-fenced create/list/revoke. Parse the exact public key ID, perform a one-row indexed lookup by ID, then constant-time compare the secret digest; display prefix never participates in lookup/authentication.
6. Implement state/expiry verification, uniform failure, and post-decision coalesced usage telemetry.
7. Test migration failure, restart, down migration, backup/restore, concurrency, random-ID collision retry, malformed/oversized keys, and foreign ownership.

## Success criteria

- [x] G4–G10 pass in focused tests.
- [x] Database/audit contain no plaintext or hash disclosure.
- [x] v1→v2→restart→v1 preserves unrelated state exactly.
- [x] Public MCP schemas/tool inventory have zero diff.

## Risks and rollback

Back up quiesced SQLite first. Failed upgrade rolls back transactionally. Application rollback disables gateway/origin route, quiesces key mutation, backs up v2, runs tested down migration (invalidating all API keys), then starts prior binary. Never overwrite newer unrelated data with the pre-cutover snapshot.

## Unresolved questions

None.
