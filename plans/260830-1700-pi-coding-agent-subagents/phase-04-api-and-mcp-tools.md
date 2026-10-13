# Phase 04: API MCP Tools & Dispatch

## Context Links
- Master Plan: [plan.md](plan.md)
- Phase 03: [phase-03-runner-lifecycle-and-state.md](phase-03-runner-lifecycle-and-state.md)

## Requirements
1. **MCP Server Tool Registration (`apps/api/src/mcp-server.ts`):**
   - Ensure all 6 `agent_*` tools are dynamically registered via `TOOL_SPECS` with their Zod schemas, annotations, and descriptions.
   - Dispatch requests to `RunnerClient` without creating custom non-standard handlers.
2. **Runner Client Bridge (`apps/api/src/runner-client.ts`):**
   - Forward `agent_*` operations as private versioned runner operations.
   - Include authenticated `principal` context.
3. **Security & Non-Enumerating Responses (`apps/api/src/request-security.ts`):**
   - Enforce authentication and scope checks.
   - Return non-enumerating error responses on unauthorized or missing agent/workspace handles.
4. **API Integration Tests:**
   - Test MCP tool listing parity.
   - Test unauthorized/cross-principal rejection.

## Files to Modify / Create
- `apps/api/src/mcp-server.ts`
- `apps/api/src/runner-client.ts`
- `apps/api/src/request-security.ts`
- `apps/api/test/agent-api.test.ts`
- `apps/api/test/http-security.test.ts`

## Tests & Validation
- `npm test -w apps/api`
