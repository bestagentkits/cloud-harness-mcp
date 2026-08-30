# Phase 03: Runner AgentManager, SQLite Durability & Cleanup Barrier

## Context Links
- Master Plan: [plan.md](plan.md)
- Phase 02: [phase-02-agent-runtime-and-model-gateway.md](phase-02-agent-runtime-and-model-gateway.md)

## Requirements
1. **SQLite State Store Integration (`apps/runner/src/agent-state-repository.ts`):**
   - Use the shared `StateStore.database` instance (do NOT open a second SQLite connection).
   - Create migrations for:
     - `runtime_epochs`
     - `agents` (unique `(owner_id, workspace_id, idempotency_key)`)
     - `agent_workspace_admission`
     - `agent_messages`
     - `agent_effects`
     - `agent_usage`
     - `agent_log_watermarks`, `agent_log_chunks`
     - `agent_cleanup_retries`
     - `agent_tombstones`
   - Implement `BEGIN IMMEDIATE` reservation and CAS state transitions with `workspace_generation`, `agent_generation`, and `runtime_epoch`.
2. **Runner AgentManager (`apps/runner/src/agent-manager.ts`):**
   - Enforce workspace `networkMode: none` admission (reject spawn if workspace is `bridge`).
   - 32-way concurrent idempotency reservation for spawn and message operations.
   - Epoch fencing on startup: bump epoch, reconcile old-epoch records to `INTERRUPTED`, `outcomeUnknown: true` after cleanup.
   - Manage message ordering and delivery state tracking (`RESERVED`, `SENT`, `REJECTED`, `UNKNOWN`).
   - Cascading cleanup barrier: Revoke lease -> Drain/abort requests -> TERM/KILL -> Remove container & network -> Verify 0 residual before workspace path deletion.
3. **Agent Launcher (`apps/runner/src/agent-launcher.ts`):**
   - Create ephemeral Docker container with read-only rootfs, non-root user, dropped capabilities, no mounts, no secrets.
   - Attach unique internal Docker network to container and Model Gateway.
   - Manage stdio JSONL process attachment.
4. **Model Gateway Control (`apps/runner/src/agent-gateway-control.ts`):**
   - Issue/revoke capability leases via control API.
   - Coordinate budget reservation and settlement.
5. **Integration with `WorkspaceService` (`apps/runner/src/workspace-service.ts`):**
   - Wire 6 `agent_*` runner operations into `WorkspaceService.execute()`.
   - Wire 10-tool proxy dispatcher into existing safe handlers (injecting bound workspace ID).
   - Wire agent cleanup barrier into `WorkspaceService.closeRecord()` *before* `safeRemovePath()`.

## Files to Modify / Create
- `apps/runner/src/agent-manager.ts`
- `apps/runner/src/agent-launcher.ts`
- `apps/runner/src/agent-gateway-control.ts`
- `apps/runner/src/agent-state-repository.ts`
- `apps/runner/src/agent-protocol.ts`
- `apps/runner/src/workspace-service.ts`
- `apps/runner/src/metadata-schema.ts`
- `apps/runner/src/config.ts`
- `apps/runner/test/agent-manager.test.ts`
- `apps/runner/test/agent-state-repository.test.ts`
- `apps/runner/test/agent-api-contract.test.ts`

## Tests & Validation
- `npm test -w apps/runner`
