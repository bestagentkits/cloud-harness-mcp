# Phase 1: Core Policy, SQLite Schema v3, Pinned Snapshot & Recovery Fix

## Context & Objectives
- Unify env-var and secret name validation into a canonical `SecretNamePolicy` in `packages/contracts`.
- Enforce 4–65,536 byte value bounds (preventing short secrets that bypass redaction).
- Add `description TEXT` to `secret_references` via monotonic migration v2->v3 in `apps/runner/src/metadata-schema.ts`.
- Persist `environment_id` and exact pinned secret version snapshots `(workspace_id, environment_id, secret_reference_id, version)` in `StateStore` (`apps/runner/src/state-store.ts`) so recovered workspaces retain their exact injected secrets across restarts.
- Add `secret_update` (metadata-only update) and `secret_bulk_apply` (transactional server-side bulk create/rotate).

## Requirements
1. **Shared Policy (`packages/contracts/src/secret-policy.ts`):**
   - Exact forbidden names: `PATH`, `HOME`, `SHELL`, `USER`, `LOGNAME`, `GIT_CONFIG_NOSYSTEM`, `GIT_TERMINAL_PROMPT`, `AUTHORIZATION`, `OWNER_ID`, `RUNNER_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, `SECRET_KEYRING`, `LD_PRELOAD`, `LD_LIBRARY_PATH`.
   - Forbidden prefixes: `HARNESS_`, `CH_`, `CLOUDFLARE_`, `CF_`, `GITHUB_APP_`, `ACCESS_`, `RUNNER_`, `DOCKER_`, `XDG_`, `NPM_CONFIG_`, `UV_`, `BUN_`, `PNPM_`.
   - Value bounds: min 4 UTF-8 bytes, max 65,536 bytes, no NUL bytes.
   - Description bounds: max 500 characters.
   - Functions: `validateSecretName(name)`, `validateSecretValue(value)`, `validateSecretDescription(desc)`.
2. **Database Migration v2->v3 (`apps/runner/src/metadata-schema.ts`):**
   - Increment `VERSION = 3`.
   - Migration v2->v3: `ALTER TABLE secret_references ADD COLUMN description TEXT;`.
   - Update downgrade functions `downgradeMetadataSchemaToV2` and `downgradeMetadataSchemaToV1`.
3. **Metadata Records & Store:**
   - Update `SecretRow` and `SecretView` in `apps/runner/src/metadata-records.ts` to include `description: string | null`.
   - Update `SecretMetadataStore.create`, `rotate` to accept optional `description` and validate with `SecretNamePolicy`.
   - Add `SecretMetadataStore.updateMetadata(principalId, environmentId, name, description, expectedGeneration): SecretView | undefined`.
   - Add `SecretMetadataStore.bulkApply(principalId, environmentId, items, expectedGenerations)` running inside a single SQLite transaction.
   - Update `internal-runner-api.ts`: add `secret_update` and `secret_bulk_apply` schemas.
4. **Pinned Snapshot & Workspace Recovery (`apps/runner/src/state-store.ts` & `workspace-service.ts`):**
   - In `StateStore`: add `environment_id TEXT` column to `workspaces` table.
   - Create `workspace_secret_snapshots` table:
     ```sql
     CREATE TABLE IF NOT EXISTS workspace_secret_snapshots (
       workspace_id TEXT NOT NULL,
       environment_id TEXT NOT NULL,
       secret_reference_id TEXT NOT NULL,
       name TEXT NOT NULL,
       version INTEGER NOT NULL,
       PRIMARY KEY(workspace_id, secret_reference_id)
     );
     ```
   - When `workspace_open` injects secrets, persist the exact version list into `workspace_secret_snapshots`.
   - When `ensureActiveExecutor` recreates the container, load the pinned versions from `workspace_secret_snapshots` (decrypting matching versions from `SecretKeyring`), ensuring exact recovery.
   - Legacy workspaces with `environment_id = NULL` recover with `{}` as before.
   - On `workspace_close` or terminal reaping, delete rows from `workspace_secret_snapshots`.

## Files to Modify/Create
- `packages/contracts/src/secret-policy.ts` (create)
- `packages/contracts/src/index.ts`
- `packages/contracts/src/internal-runner-api.ts`
- `apps/runner/src/metadata-schema.ts`
- `apps/runner/src/metadata-records.ts`
- `apps/runner/src/secret-metadata-store.ts`
- `apps/runner/src/metadata-store.ts`
- `apps/runner/src/dashboard-control-service.ts`
- `apps/runner/src/state-store.ts`
- `apps/runner/src/workspace-service.ts`
- `apps/api/src/dashboard-control-router.ts`
- `apps/api/src/dashboard-response.ts`

## Phase 1 Tests
- `packages/contracts/test/secret-policy.test.ts` (test all forbidden names, prefixes, 4-byte minimum value, description bounds).
- `apps/runner/test/metadata-store.test.ts` (test v2->v3 migration, v3->v2 downgrade, `secret_update`, `secret_bulk_apply`).
- `apps/runner/test/workspace-recovery.test.ts` (test container recreation with pinned version snapshots surviving rotation and restart).
