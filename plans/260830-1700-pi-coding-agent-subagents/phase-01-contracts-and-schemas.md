# Phase 01: Contracts, Tool Schemas & Proxy Protocol

## Context Links
- Master Plan: [plan.md](plan.md)
- Brainstorm Brief: plans/reports/brainstorm.html

## Requirements
1. **Public MCP Tool Schemas (in `packages/contracts/src/tool-schemas.ts`):**
   - `agent_spawn`: `workspaceId`, `prompt` (max 131,072 chars), `idempotencyKey`, `profileId`, optional `parentAgentId`, optional `proxyOperations` (array of exact 10 ops, unique), `ttlSeconds` (30..86,400, default 900), `maxOutputBytes` (1,024..10,485,760, default 262,144), optional `maxInputTokens`, optional `maxOutputTokens`, optional `maxCostMicros`.
   - `agent_status`: `workspaceId`, exactly one of `agentId` or `idempotencyKey`.
   - `agent_logs`: `workspaceId`, `agentId`, optional `cursor` (decimal offset), `limitBytes` (1,024..262,144, default 65,536).
   - `agent_message`: `workspaceId`, `agentId`, `idempotencyKey`, `mode` (`steer` | `followUp`), `message` (max 65,536 chars).
   - `agent_cancel`: `workspaceId`, `agentId`, optional `reason`.
   - `agent_list`: `workspaceId`, optional `parentAgentId`, optional `status` filter, optional `cursor`, `limit` (1..100, default 50).
2. **Exact 10 Proxy Operations (in `packages/contracts/src/runner-api.ts`):**
   - Define `AgentProxyOperationSchema = z.enum(['files_list', 'files_read', 'files_write', 'files_apply_patch', 'files_delete', 'files_move', 'files_mkdir', 'grep_search', 'symbols_search', 'symbols_references'])`.
   - Define per-operation proxy schemas that omit `workspaceId` (the Runner injects the bound workspace ID server-side; Pi never controls or passes `workspaceId`).
3. **Runner Operation Schemas (in `packages/contracts/src/runner-api.ts`):**
   - Add `RunnerAgentOperation` union to `RunnerOperationSchema`.
   - Add internal request/response schemas for `agent_*` operations.
4. **Model Gateway Schemas (in `packages/contracts/src/runner-api.ts`):**
   - Define `AgentLeaseSchema`, `AgentProfileSchema`, and budget reservation/settlement contracts.
5. **Identifiers & Annotations:**
   - Add `AgentIdSchema`, `AgentLeaseIdSchema`, `AgentMessageIdSchema` in `identifiers.ts`.
   - Update `TOOL_SPECS` with exact metadata and annotations (`readOnlyHint`, `openWorldHint`, `destructive`).

## Files to Modify / Create
- `packages/contracts/src/identifiers.ts`
- `packages/contracts/src/tool-schemas.ts`
- `packages/contracts/src/runner-api.ts`
- `packages/contracts/src/mcp-results.ts`
- `packages/contracts/src/index.ts`
- `packages/contracts/test/contracts.test.ts`

## Tests & Validation
- `npm test packages/contracts/test/contracts.test.ts`
