# Phase 1: Contracts, Provenance Models & Behavior Matrix

## Context Links
- Issue #15: `https://github.com/bestagentkits/cloud-harness-mcp/issues/15`
- Plan: `plans/260830-0700-15-provenance-aware-workspace-context-skills-memories-hooks/plan.md`
- Code: `packages/contracts/src/runner-api.ts`, `packages/contracts/src/tool-schemas.ts`, `packages/contracts/src/index.ts`

## Requirements
- Define strict, canonical Provenance mapping enforced at Runner boundary:
  - `built-in` -> `trust: trusted-control-plane`, `mutableBy: release`
  - `owner` -> `trust: owner-controlled`, `mutableBy: owner`
  - `workspace` -> `trust: untrusted-executor`, `mutableBy: workspace-process`
  - `repository` -> `trust: untrusted-executor`, `mutableBy: repository-commit`
- Define `ProvenanceSchema`:
  - `source`: `built-in` | `owner` | `workspace` | `repository`
  - `trust`: `trusted-control-plane` | `owner-controlled` | `untrusted-executor`
  - `mutableBy`: `release` | `owner` | `workspace-process` | `repository-commit`
  - `path`: relativePath optional
  - `contentSha256`: 64 lowercase hex string
  - `discoveredAt`: ISO datetime
- Define `ContextManifestItemSchema` with kind, format, clients (`all`, `claude`, `codex`, `cursor`, `aider`), contentSha256, byte count, excerpt, and strict `provenance`
- Define `MemoryScopeSchema = z.enum(['owner', 'repository', 'workspace'])`
- Define `HookEventSchema = z.enum(['on_workspace_open', 'post_checkout', 'pre_commit', 'post_commit', 'manual'])`
- Expand `RunnerOperationSchema` with `memories_search`, `memories_delete`, `hooks_activate`, `hooks_deactivate`
- Clean cutover for `memories_write`: require `scope` and `expectedGeneration` (CAS); add `memories_search` and `memories_delete`
- Update `tool-schemas.ts` for:
  - `workspace_context`: optional `clientProfile`, `include`, `contentMode` (`none` | `excerpt`), `cursor`, `maxBytes` (4 KiB - 128 KiB, default 32 KiB)
  - `skills_list`: optional pagination, `includeShadowed: boolean`
  - `skills_read`: `name`, `source?`, `expectedSha256?`, `offset?`, `limit?`
  - `skills_run`: `name`, `source?`, `script`, `args`, `timeoutMs`, `expectedSha256` (required)
  - `hooks_list`: optional `event?`, `includeInactive?`
  - `hooks_run`: `name`, `event`, `expectedSha256`, `timeoutMs`
  - `hooks_activate`: `manifestSha256`, `events: HookEvent[]`
  - `hooks_deactivate`: `events?: HookEvent[]`
  - `memories_list`: `scope?`, `tags?`, `cursor?`, `limit?`
  - `memories_read`: `name` or `memoryId`
  - `memories_write`: `scope`, `name`, `content`, `tags`, `retentionSeconds?`, `expectedGeneration` (CAS: 0 for create, >0 for update)
  - `memories_search`: `query` (literal tokens), `scope?`, `tags?`, `cursor?`, `limit?`
  - `memories_delete`: `memoryId` or `name` + `scope`, `expectedGeneration` (>0)
- Update `TOOL_SPECS`, `readOnly`, `destructive`, `idempotent` sets in `packages/contracts/src/tool-schemas.ts`
- Export all schemas and inferred TypeScript types in `packages/contracts/src/index.ts`

## Files to Modify/Create
- `packages/contracts/src/runner-api.ts`
- `packages/contracts/src/tool-schemas.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/test/contracts.test.ts`

## Implementation Steps
1. Add strict canonical provenance mapping, context manifest item schemas, memory scope, and hook event schemas in `packages/contracts/src/runner-api.ts`.
2. Update tool input schemas in `packages/contracts/src/tool-schemas.ts` with pagination, filters, and CAS expected generations.
3. Update `TOOL_SPECS`, `readOnly`, `destructive`, `idempotent` sets in `packages/contracts/src/tool-schemas.ts`.
4. Export new schemas and types in `packages/contracts/src/index.ts`.
5. Write and run unit tests in `packages/contracts/test/contracts.test.ts` verifying all schema invariants.

## Tests & Validation
- `npm test packages/contracts/test/contracts.test.ts`
- Verify parsing of both legacy queries and new enriched parameters.
