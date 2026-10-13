---
phase: 1
title: "Contracts & API Key Max Duration Extension"
status: completed
priority: P1
effort: "1h"
dependencies: []
---

# Phase 01: Contracts & API Key Max Duration Extension

## Overview
Update the shared schema contract, API router validation, and runner store validation to allow API key lifetimes up to 3,650 days (10 years) instead of being capped at 365 days.

## Requirements
- Functional:
  - `packages/contracts/src/api-key-api.ts`: Change `expiresInDays` validation in `ApiKeyManagementRequestSchema` from `z.number().int().min(1).max(365)` to `z.number().int().min(1).max(3650)`.
  - `apps/api/src/dashboard-control-router.ts`: Update route validation schema for `/api/v1/api-keys` POST to `z.number().int().min(1).max(3650)`.
  - `apps/runner/src/api-key-store.ts`: Update `create()` method validation from `expiresInDays > 365` to `expiresInDays > 3650`.
- Non-functional:
  - Backward compatibility: All existing keys with 1–365 days remain valid and unmodified.
  - Safe bounds: Integer validation is preserved; values <= 0 or > 3650 are rejected with 400 Bad Request.

## Architecture
```
Client (Dashboard / API)
  -> POST /dashboard/api/v1/api-keys { name: "...", expiresInDays: 3650 }
  -> apps/api/src/dashboard-control-router.ts (Zod validation: 1..3650)
  -> packages/contracts/src/api-key-api.ts (ApiKeyManagementRequestSchema: 1..3650)
  -> apps/runner/src/api-key-store.ts (validates expiresInDays 1..3650, creates SQLite row with now + expiresInDays * 86_400_000)
```

## Related Code Files
- Modify: `packages/contracts/src/api-key-api.ts`
- Modify: `apps/api/src/dashboard-control-router.ts`
- Modify: `apps/runner/src/api-key-store.ts`
- Modify: `packages/contracts/test/api-key-api.test.ts`
- Modify: `apps/api/test/dashboard-router.test.ts`
- Modify: `apps/runner/test/api-key-store.test.ts` (if bounds tested)

## Implementation Steps
1. In `packages/contracts/src/api-key-api.ts`, update `expiresInDays: z.number().int().min(1).max(3650)`.
2. In `apps/api/src/dashboard-control-router.ts`, update `expiresInDays: z.number().int().min(1).max(3650)`.
3. In `apps/runner/src/api-key-store.ts`, update line 67 check from `expiresInDays > 365` to `expiresInDays > 3650`.
4. In `packages/contracts/test/api-key-api.test.ts`, update tests to verify 3,650 days is accepted and 3,651 days is rejected.
5. Run `npm test` across `packages/contracts`, `apps/api`, and `apps/runner` to verify schema and store changes pass.
## Success Criteria
- [x] `ApiKeyManagementRequestSchema.parse({ version: 1, principal, operation: 'api_key_create', input: { name: 'CLI', expiresInDays: 3650 } })` succeeds.
- [x] `ApiKeyManagementRequestSchema.safeParse({ version: 1, principal, operation: 'api_key_create', input: { name: 'CLI', expiresInDays: 3651 } })` fails.
- [x] API endpoint `/api/v1/api-keys` accepts `expiresInDays: 3650`.
- [x] Runner `ApiKeyStore.create()` succeeds with `expiresInDays: 3650` and rejects `3651`.
## Risk Assessment
- Risk: Schema mismatch between API and runner contracts if runner store validation is forgotten.
  - Mitigation: Updated both `contracts`, `api`, and `apps/runner/src/api-key-store.ts` in sync.
