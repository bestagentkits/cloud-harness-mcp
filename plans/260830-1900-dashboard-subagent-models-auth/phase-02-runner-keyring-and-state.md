# Phase 02: Runner Keyring, StateStore Schema v8 & Operations

## Context Links
- Master Plan: [plan.md](plan.md)
- Phase 01: [phase-01-contracts-and-schemas.md](phase-01-contracts-and-schemas.md)
- StateStore: `apps/runner/src/state-store.ts`
- Principal Store: `apps/runner/src/principal-store.ts`
- Secret Keyring: `apps/runner/src/secret-keyring.ts`

## Requirements

1. **SQLite Schema v8 Migration (`apps/runner/src/principal-store.ts`):**
   - Create table `model_provider_credentials`:
     `id TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT, label TEXT NOT NULL, provider TEXT NOT NULL, auth_mode TEXT NOT NULL, active_version INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL`.
   - Create table `model_provider_credential_versions`:
     `principal_id TEXT NOT NULL, credential_id TEXT NOT NULL, version INTEGER NOT NULL, key_version INTEGER NOT NULL, nonce TEXT NOT NULL, ciphertext TEXT NOT NULL, auth_tag TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(principal_id, credential_id, version), FOREIGN KEY(credential_id) REFERENCES model_provider_credentials(id) ON DELETE CASCADE`.
   - Create table `agent_model_profiles`:
     `id TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE RESTRICT, display_name TEXT NOT NULL, credential_id TEXT NOT NULL REFERENCES model_provider_credentials(id) ON DELETE RESTRICT, desired_revision_id TEXT, active_revision_id TEXT, generation INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL`.
   - Create table `agent_model_profile_revisions`:
     `id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, principal_id TEXT NOT NULL, model TEXT NOT NULL, api_mode TEXT NOT NULL, downstream_path TEXT NOT NULL, upstream_url TEXT NOT NULL, input_micros_per_million INTEGER NOT NULL, output_micros_per_million INTEGER NOT NULL, max_input_tokens INTEGER NOT NULL, max_output_tokens INTEGER NOT NULL, max_cost_micros INTEGER NOT NULL, max_proxy_operations_json TEXT NOT NULL, digest TEXT NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY(profile_id) REFERENCES agent_model_profiles(id) ON DELETE CASCADE`.
   - Implement `downgradeStateSchemaToV7(database: DatabaseSync)`.
   - Update `downgradeStateSchemaToV6`, `V5`, `V4`, `V3` to handle v8 cascading downgrades.

2. **Model Profile State Repository & SecretKeyring Integration (`apps/runner/src/model-profile-state-repository.ts`):**
   - Implement CRUD for credentials with AES-256-GCM encryption and domain-separated AAD (`purpose: 'model_provider_credential'`).
   - Implement rotation logic: insert version $N+1$, update active version, update generation.
   - Implement profile CRUD: compute immutable revision hash digest, link to credential slot.
   - Implement principal isolation: verify ownership on every operation; return non-enumerating 404 for foreign IDs.

3. **Runner Internal Operations Dispatch (`apps/runner/src/internal-runner-operations.ts`):**
   - Register operations: `model_credential_create`, `model_credential_list`, `model_credential_rotate`, `model_credential_delete`, `model_profile_create`, `model_profile_list`, `model_profile_update`, `model_profile_delete`, `model_profile_activate`.

## Files to Modify / Create
- `apps/runner/src/principal-store.ts` (modify: migration to version 8 and downgrade to version 7)
- `apps/runner/src/state-store.ts` (modify: export downgradeStateSchemaToV7 and profile operations)
- `apps/runner/src/model-profile-state-repository.ts` (create)
- `apps/runner/src/internal-runner-operations.ts` (modify: wire profile operations)
- `apps/runner/test/model-profile-state-repository.test.ts` (create)
- `apps/runner/test/state-schema-v8.test.ts` (create)

## Tests & Validation
- `npx vitest run apps/runner/test/state-schema-v8.test.ts`
- `npx vitest run apps/runner/test/model-profile-state-repository.test.ts`
- `npm run typecheck -w @cloud-harness/runner`
