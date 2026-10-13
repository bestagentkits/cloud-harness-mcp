# Implementation Plan: Global Secrets & Credentials Management

- **Status:** ready
- **Branch:** `mrgoonie/global-secrets-management`
- **Owner:** Cloud Harness MCP Core Engineering
- **Security Invariant:** Global secrets are encrypted at rest with AES-256-GCM + AAD bound to `[principalId, 'global', name, version]` in runner SQLite; secret values are write-only on API/DOM; exact injected plaintext values are redacted from output/errors; and CSP `default-src 'none'` is strictly preserved.

## Summary

Expand Secrets & Credentials Management to support **Global Secrets** (principal-scoped secrets automatically available across all projects and workspaces):
1. **Core Persistence & Merge Engine:** Add principal-scoped global secrets to `SecretMetadataStore` and `MetadataStore` with AAD `[principalId, 'global', name, version]`. In `workspace_open`, merge global secrets with environment secrets (environment overrides global on key collision) and persist the combined encrypted snapshot.
2. **MCP Tooling & Discovery:** Update `secrets_list` to list global secrets alongside environment secrets (with a `scope: 'global' | 'environment'` indicator) and ensure the Aho-Corasick Ingest-time Redaction Engine protects all injected global secrets.
3. **Dashboard Sidebar Navigation & UI:** Add a dedicated **Secrets** entry in the Dashboard left navigation under Configuration (`/dashboard/secrets`). Build the Global Secrets page with Description editing, Rotate, Delete, Bulk `.env` import modal, and Export `.env.example`.
4. **Verification & Quality Gates:** Full unit, integration, and UI contract tests (`dashboard-ui-contract.test.ts`), and documentation sync.

## Phases

- [Phase 1: Global Secrets Persistence, AAD Binding & Snapshot Merge](phase-01-global-secrets-persistence.md)
- [Phase 2: MCP Tooling `secrets_list` Scope & Output Redaction](phase-02-mcp-and-redaction-integration.md)
- [Phase 3: Dashboard Sidebar Navigation & Global Secrets View](phase-03-dashboard-global-secrets-ui.md)
- [Phase 4: Comprehensive Verification, Regression Tests & Docs Sync](phase-04-verification-and-docs.md)

## Acceptance Criteria

- [ ] Global secrets can be created, listed, rotated, updated (description), and deleted per principal with AAD `[principalId, 'global', name, version]`.
- [ ] At `workspace_open`, workspace inherits all active global secrets merged with environment secrets (environment takes precedence on name collision).
- [ ] `workspace_secret_snapshots` saves the merged snapshot, and `ensureActiveExecutor` recovers all pinned secrets (global + environment).
- [ ] Dashboard left sidebar includes **Secrets** under Configuration (`href="/dashboard/secrets"`).
- [ ] `/dashboard/secrets` provides a complete management UI for Global Secrets with descriptions, inline edit/rotate, bulk `.env` import, and `.env.example` export.
- [ ] `secrets_list` MCP tool discovers global secrets when no environment is selected or includes them with `scope` metadata.
- [ ] Output redaction masks all injected global secrets from command outputs and error messages.
- [ ] `npm run verify` passes completely.
