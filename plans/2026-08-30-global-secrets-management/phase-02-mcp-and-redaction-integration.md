# Phase 2: MCP Tooling `secrets_list` Scope & Output Redaction

## Context & Objectives
- Update `secrets_list` MCP tool to return global secrets as well as environment-specific secrets.
- Add `scope: 'global' | 'environment'` property to returned secret metadata items.
- Ensure all injected global secrets are protected by the Ingest-time Aho-Corasick Output Redactor in `apps/runner/src/output-redactor.ts`.

## Requirements
1. **MCP Tool `secrets_list` Updates:**
   - In `apps/runner/src/workspace-service.ts`:
     - Load active global secrets for `ownerId`.
     - If an `environmentId` is resolved (from input or workspace context), load environment secrets and merge with global secrets (environment overrides global on key collision).
     - Each returned secret includes `{ name, description, scope: 'global' | 'environment', environmentId: string, version, updatedAt }`.
     - Supports `query` filtering over name and description across both scopes.
2. **Output Redactor:**
   - The redactor constructed at `workspace_open` (and during `ensureActiveExecutor` / `getRedactor`) automatically receives the merged map of all injected secrets (global + environment).
   - Ingest-time redaction masks any global secret value present in command outputs or error messages to `[REDACTED_SECRET: <NAME>]`.

## Files to Modify
- `apps/runner/src/workspace-service.ts`
- `packages/contracts/src/tool-schemas.ts` (if schema types updated)
- `.agents/skills/cloudharness/references/workspace-lifecycle-and-results.md`

## Phase 2 Tests
- `apps/runner/test/workspace-secrets-redaction.test.ts` (test global secret discovery, override by environment secret with same name, and output redaction of global secrets).
