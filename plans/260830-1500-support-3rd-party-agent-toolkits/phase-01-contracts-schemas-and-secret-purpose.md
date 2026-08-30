---
phase: 1
title: "Contracts, Schemas & Public Interfaces"
status: pending
priority: P1
effort: "2d"
dependencies: ["phase-00-feasibility-gates-and-secret-purpose.md"]
---

# Phase 1: Contracts, Schemas & Public Interfaces

## Overview
Define and export all public Zod schemas, contract types, result envelopes, error taxonomies, and provenance extensions for third-party agent toolkits and secret purpose classification across `packages/contracts/`.

<!-- red-team-applied: Findings 1, 2, 3, 4, 5, 16 -->

## Requirements
- Functional:
  - Define `ToolkitSelectionSchema` as a strict discriminated union over `kind: 'preset' | 'git'`:
    - `preset`: `id` in `['mattpocock/skills', 'obra/superpowers', 'bestagentkits/agentkit']`, `scope: 'owner' | 'workspace'`, strict per-preset config, optional allowlist skill filters.
    - `git`: `instanceId`, `url`, `ref` (using `gitObjectId` supporting both 40-char SHA-1 and 64-char SHA-256 commit hashes), `subdirectory`, `layout`, `scope`.
  - Extend `WorkspaceOpenSchema` with `toolkits`, `allowToolkitWorkspaceChanges`, and `confirmToolkitSecretUse`.
  - Define internal runner operation schemas in `packages/contracts/src/internal-runner-api.ts` for `toolkits_list` and `toolkits_preview` (internal dashboard operations, avoiding unnecessary public MCP tool pollution).
  - Extend `ProvenanceSchema` exclusively in `packages/contracts/src/runner-api.ts` with optional `origin` metadata (`kind: 'toolkit'`, `toolkitId`, `resolvedRevision`, `bundleSha256`, `adapterVersion`, `verification`).
  - Extend Secret contracts in `packages/contracts/src/secret-policy.ts` with `SecretPurposeSchema` (`'runtime' | 'provisioning'`).
  - Add toolkit-specific error classifications to `HarnessError` without breaking backward compatibility.
- Non-functional:
  - Omitted `toolkits` and `toolkits: []` default to empty array and preserve pristine workspace behavior.
  - Separate static Zod syntax checks from dynamic runtime host authorization via `validateRepositoryUrl(url, allowedGitHosts)`.

## Architecture
```text
packages/contracts/src/
  ├── tool-schemas.ts         (ToolkitSelectionSchema, workspace_open with gitObjectId)
  ├── runner-api.ts           (RunnerOperation, ToolkitLockRecord, single-source ProvenanceSchema + origin)
  ├── internal-runner-api.ts  (toolkits_list, toolkits_preview internal dashboard operations)
  ├── secret-policy.ts        (SecretPurpose: runtime vs provisioning)
  └── index.ts                (Public contract exports)
```

## Related Code Files
- Modify: `packages/contracts/src/tool-schemas.ts`
- Modify: `packages/contracts/src/runner-api.ts`
- Modify: `packages/contracts/src/internal-runner-api.ts`
- Modify: `packages/contracts/src/secret-policy.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/toolkit-schemas.test.ts`

## Implementation Steps
1. Add `SecretPurpose` to `packages/contracts/src/secret-policy.ts`:
   ```typescript
   export const SecretPurposeSchema = z.enum(['runtime', 'provisioning']).default('runtime');
   export type SecretPurpose = z.infer<typeof SecretPurposeSchema>;
   ```
2. In `packages/contracts/src/tool-schemas.ts`, implement `ToolkitSelectionSchema`:
   - Use `gitObjectId` regex (`^(?:[0-9a-f]{40}|[0-9a-f]{64})$`) for Git `ref`.
   - Implement strict per-preset configurations (no open `Record<string, unknown>`).
3. Update `workspace_open` input schema in `packages/contracts/src/tool-schemas.ts`:
   ```typescript
   toolkits: z.array(ToolkitSelectionSchema).max(8).default([]),
   allowToolkitWorkspaceChanges: z.literal(true).optional(),
   confirmToolkitSecretUse: z.literal(true).optional(),
   ```
4. Define internal operations `toolkits_list` and `toolkits_preview` in `packages/contracts/src/internal-runner-api.ts`.
5. Update `ProvenanceSchema` in `packages/contracts/src/runner-api.ts` (single source of truth) with `origin` metadata.
6. Write exhaustive unit tests in `packages/contracts/test/toolkit-schemas.test.ts` covering:
   - Valid presets (Matt Pocock, Superpowers, AgentKit).
   - Valid custom Git with both 40-char and 64-char commit object IDs.
   - Rejection of invalid URLs, duplicate instance IDs, contradictory include/exclude.
   - Backward compatibility when `toolkits` is omitted or `[]`.

## Success Criteria
- [ ] `packages/contracts/test/toolkit-schemas.test.ts` passes 100% of schema test cases.
- [ ] Typecheck passes across all packages (`npm run typecheck`).
- [ ] Contract compliance tests pass (`npm run test:unit`).

## Risk Assessment
- *Risk:* Dynamic allowlist validation attempted in static Zod schema.
  - *Mitigation:* Zod enforces URL syntax and protocol; runner executes `validateRepositoryUrl(parsed.url, this.config.allowedGitHosts)` at invocation time.
