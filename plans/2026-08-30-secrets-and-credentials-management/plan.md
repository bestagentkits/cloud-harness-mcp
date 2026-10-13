# Implementation Plan: Secrets & Credentials Management, Discovery, and Safe Injection

- **Status:** completed
- **Branch:** `mrgoonie/Manage-secrets-and-credentials`
- **Owner:** Cloud Harness MCP Core Engineering
- **Security Invariant:** Retained secret references are encrypted at rest with AES-256-GCM + per-secret AAD in runner SQLite; secret values are write-only on API/DOM; exact injected plaintext values are redacted from runner-mediated command output and error streams; and CSP `default-src 'none'` is strictly preserved.

## Summary

Build and ship end-to-end Secrets & Credentials Management in Cloud Harness MCP:
1. **Core Policy & Version-Pinned Snapshot Persistence:** Single shared `SecretNamePolicy` (enforcing 4–65,536 byte value bounds and complete forbidden names/prefixes), SQLite metadata migration v2->v3 adding `description TEXT` to `secret_references`, `secret_update` metadata API, `secret_bulk_apply` transactional API, and persisting `environment_id` plus exact secret version snapshot `(workspace_id, secret_reference_id, version)` on `WorkspaceRecord` to fix secret loss on container recovery.
2. **MCP Tooling & Centralized Redaction Engine:** Public MCP tool `secrets_list` (value-free discovery by name & description with local stdio mode handling) and a centralized runner-side Aho-Corasick Ingest-Time Output Redaction Engine to sanitize command output (`exec_run`, `tasks_status`, `shell_io`, `sessions_io`, `runWorker` JSON payload, error messages) before reaching MCP clients.
3. **Dashboard UI & Bulk .env Import:** Enhanced Project/Environment secret management with Description field, inline rotation/edit, Bulk `.env` import modal with live key-only diff & comment-to-description extraction, server-authoritative `secret_bulk_apply` submission, and Export `.env.example` manifest.
4. **Verification & Docs Sync:** Comprehensive unit, integration, and UI contract tests across each phase (`dashboard-ui-contract.test.ts`, `cloudharness-skill-contract.test.ts`), and docs-site documentation sync.

## Phases

- [Phase 1: Core Policy, SQLite Schema v3, Pinned Snapshot & Recovery Fix](phase-01-core-policy-and-persistence.md)
- [Phase 2: MCP Tool `secrets_list` & Centralized Ingest-Time Output Redactor](phase-02-mcp-tool-and-redaction-engine.md)
- [Phase 3: Dashboard UI, Description Management & Server-Authoritative Bulk .env Import](phase-03-dashboard-ui-and-bulk-env.md)
- [Phase 4: Cross-Package Quality Gates, Visual Verification & Documentation Sync](phase-04-verification-and-documentation.md)

## Acceptance Criteria

- [x] `validateSecretName` and `validateSecretValue` in `packages/contracts/src/secret-policy.ts` reject reserved names (`PATH`, `HOME`, `XDG_*`, `NPM_*`, `BUN_*`, `PNPM_*`, `GIT_*`, `HARNESS_*`, `CH_*`, `CLOUDFLARE_*`, `GITHUB_APP_*`, `RUNNER_*`, `LD_*`) and values with nulls/newlines at write time.
- [x] Database schema migration v2->v3 adds `description TEXT` column to `secret_references`, updates `SecretRow`/`SecretView`, and adds `secret_update` and transactional `secret_bulk_apply` operations.
- [x] `WorkspaceRecord` persists `environment_id` and exact pinned secret version snapshot `(workspace_id, secret_reference_id, version)` in SQLite, allowing `ensureActiveExecutor` to recover containers with their original pinned secrets.
- [x] Public MCP tool `secrets_list` returns value-free `{ name, description, environmentId, version, updatedAt }` with optional `query` filter in remote mode and clean unsupported handling in local stdio mode.
- [x] Centralized Aho-Corasick Ingest-time Redactor masks exact injected secrets in stdout/stderr to `[REDACTED_SECRET: <NAME>]` without breaking cursor byte offsets, and sanitizes worker/error messages.
- [x] Dashboard renders Secret Table with Description, inline edit/rotate, and Bulk `.env` import modal with comment parsing and transactional server apply.
- [x] `npm run verify` passes completely (`plugin:check`, `lint`, `typecheck`, `test`, `build`).
