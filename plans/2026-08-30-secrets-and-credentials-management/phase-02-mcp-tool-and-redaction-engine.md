# Phase 2: MCP Tool `secrets_list` & Centralized Ingest-Time Output Redactor

## Context & Objectives
- Expose public MCP tool `secrets_list` allowing agents to discover available credentials (names & descriptions) without seeing or needing raw plaintext values.
- Handle local stdio mode gracefully (structured unsupported response).
- Implement a centralized runner-side Aho-Corasick Ingest-Time Output Redaction Engine that masks injected secret values (`[REDACTED_SECRET: <NAME>]`) from stdout/stderr of `exec_run`, `tasks_status`, `shell_io`, `sessions_io`, `runWorker` JSON results, and error messages.

## Requirements
1. **Public MCP Tool `secrets_list`:**
   - Add `secrets_list` to `RunnerOperationSchema` in `packages/contracts/src/runner-api.ts`.
   - Input schema in `packages/contracts/src/tool-schemas.ts`:
     ```ts
     secrets_list: z.object({
       ...workspace,
       environmentId: EnvironmentIdSchema.optional(),
       query: z.string().max(200).optional(),
       cursor: z.string().max(256).optional(),
       limit: z.number().int().min(1).max(500).default(100)
     })
     ```
   - Precedence: `input.environmentId` > `record.environmentId` > active workspace environment.
   - Output: `{ secrets: [{ name, description, environmentId, version, updatedAt }], cursor?: string }`.
   - Local stdio mode in `apps/api/src/local/local-workspace-backend.ts`: returns structured `{ ok: false, error: { code: 'UNSUPPORTED_OPERATION', message: 'Retained environment secrets are not available in local stdio mode.' } }`.
2. **Centralized Secret Snapshot Redactor (`apps/runner/src/output-redactor.ts`):**
   - Class `SecretSnapshotRedactor`:
     - Built from the workspace's exact injected secret map `Record<string, string>`.
     - Uses Aho-Corasick automaton over bytes with leftmost-longest match resolution.
     - Minimal holdback state during chunked streaming (bytes held only while output matches a secret prefix).
     - Flushes held bytes on stream close / process exit.
     - `redactStream(chunk: Buffer): Buffer`: transforms chunk before appending to `OperationManager` buffer, keeping byte cursor offsets perfectly synced with the redacted stream.
     - `sanitizeString(text: string): string`: string-level replacer for error messages, Docker stderr, and `HarnessError.message`.
     - `sanitizeObject(obj: unknown): unknown`: recursively sanitizes string leaves in parsed worker JSON payloads (`runWorker` output/message/error).

## Files to Modify/Create
- `packages/contracts/src/runner-api.ts`
- `packages/contracts/src/tool-schemas.ts`
- `apps/api/src/local/local-workspace-backend.ts`
- `apps/runner/src/output-redactor.ts` (create)
- `apps/runner/src/operation-manager.ts`
- `apps/runner/src/workspace-service.ts`

## Phase 2 Tests
- `apps/runner/test/output-redactor.test.ts` (unit tests: stream chunk boundaries, overlapping secrets, duplicate values, UTF-8 boundaries, holdback flush on close).
- `apps/runner/test/workspace-secrets-redaction.test.ts` (integration test: `exec_run("echo $SECRET")` output contains `[REDACTED_SECRET: SECRET]`, `secrets_list` returns value-free metadata, error messages are sanitized).
- `apps/api/test/local/local-capabilities.test.ts` (verifies `secrets_list` in local mode).
