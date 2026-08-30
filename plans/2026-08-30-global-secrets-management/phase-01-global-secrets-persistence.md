# Phase 1: Global Secrets Persistence, AAD Binding & Snapshot Merge

## Context & Objectives
- Allow principals to manage Global Secrets (secrets not tied to any project or environment).
- Bind AAD to `[principalId, 'global', name, version]`.
- Implement `globalSecretList`, `globalSecretCreate`, `globalSecretRotate`, `globalSecretUpdateMetadata`, `globalSecretDelete`, and `globalSecretBulkApply`.
- In `workspace_open`, merge global secrets with environment secrets (environment overrides global on key collision) and persist the combined encrypted snapshot.

## Requirements
1. **Database Schema (`apps/runner/src/metadata-schema.ts`):**
   - In `metadata-schema.ts`:
     Add table `global_secret_references`:
     ```sql
     CREATE TABLE IF NOT EXISTS global_secret_references (
       id TEXT PRIMARY KEY,
       principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
       name TEXT NOT NULL,
       description TEXT,
       state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'DELETED')),
       current_version INTEGER NOT NULL CHECK (current_version > 0),
       generation INTEGER NOT NULL CHECK (generation > 0),
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL,
       deleted_at INTEGER,
       UNIQUE(principal_id, id),
       UNIQUE(principal_id, name)
     );
     CREATE TABLE IF NOT EXISTS global_secret_versions (
       principal_id TEXT NOT NULL,
       secret_reference_id TEXT NOT NULL,
       version INTEGER NOT NULL CHECK (version > 0),
       key_version INTEGER NOT NULL CHECK (key_version > 0),
       nonce BLOB NOT NULL,
       ciphertext BLOB NOT NULL,
       auth_tag BLOB NOT NULL,
       created_at INTEGER NOT NULL,
       PRIMARY KEY(principal_id, secret_reference_id, version),
       FOREIGN KEY(principal_id, secret_reference_id) REFERENCES global_secret_references(principal_id, id) ON DELETE RESTRICT
     );
     ```
2. **Global Secret Operations in `SecretMetadataStore`:**
   - Methods: `globalList`, `globalCreate`, `globalRotate`, `globalUpdateMetadata`, `globalDelete`, `globalBulkApply`, `globalSecretEnvelopes`.
   - AAD for encryption: `{ principalId, environmentId: 'global', name, version }`.
3. **Merge Engine in `WorkspaceService`:**
   - In `workspace_open`:
     - Load global envelopes: `globalEnvelopes = this.metadata?.globalSecretEnvelopes(ownerId) ?? []`.
     - Load environment envelopes if `parsed.environmentId`: `envEnvelopes = this.metadata?.environmentSecretEnvelopes(ownerId, parsed.environmentId) ?? []`.
     - Merge with environment overriding global:
       `const mergedMap = new Map();`
       `for (const g of globalEnvelopes) mergedMap.set(g.name, { ...g, environmentId: 'global' });`
       `for (const e of envEnvelopes) mergedMap.set(e.name, { ...e, environmentId: parsed.environmentId });`
     - Save combined snapshot to `this.store.saveSecretSnapshot(workspaceId, parsed.environmentId ?? 'global', combinedEnvelopes)`.
     - Decrypt combined values and pass to `createExecutor`.
4. **Internal Runner API & Dashboard Control Router:**
   - Add routes:
     - `GET /api/v1/secrets` -> `global_secret_list`
     - `POST /api/v1/secrets` -> `global_secret_create`
     - `POST /api/v1/secrets/bulk` -> `global_secret_bulk_apply`
     - `PUT /api/v1/secrets/:name` -> `global_secret_rotate`
     - `PATCH /api/v1/secrets/:name` -> `global_secret_update`
     - `DELETE /api/v1/secrets/:name` -> `global_secret_delete`

## Files to Modify
- `packages/contracts/src/internal-runner-api.ts`
- `apps/runner/src/metadata-schema.ts`
- `apps/runner/src/metadata-records.ts`
- `apps/runner/src/secret-metadata-store.ts`
- `apps/runner/src/metadata-store.ts`
- `apps/runner/src/dashboard-control-service.ts`
- `apps/runner/src/workspace-service.ts`
- `apps/api/src/dashboard-control-router.ts`
- `apps/api/src/dashboard-response.ts`
