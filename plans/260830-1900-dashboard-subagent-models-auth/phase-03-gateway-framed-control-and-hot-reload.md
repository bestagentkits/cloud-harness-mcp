# Phase 03: Gateway Framed Stdin Control, Unconfigured Startup & Hot Reload

## Context Links
- Master Plan: [plan.md](plan.md)
- Phase 01: [phase-01-contracts-and-schemas.md](phase-01-contracts-and-schemas.md)
- Model Gateway Config: `apps/model-gateway/src/config.ts`
- Gateway Control: `apps/model-gateway/src/control.ts`
- Gateway Upstream: `apps/model-gateway/src/upstream.ts`
- Runner Gateway Control: `apps/runner/src/agent-gateway-control.ts`

## Requirements

1. **Unconfigured Gateway Startup, Readiness & Recovery (`apps/model-gateway/src/index.ts`, `apps/model-gateway/src/config.ts`):**
   - When started with `MODEL_GATEWAY_DYNAMIC_MODE=true` (or when profiles file is absent), Gateway initializes an empty dynamic projection in RAM.
   - `/healthz` returns `200 OK` as soon as the control socket is listening at `/tmp/model-gateway-control.sock` (`mode 0600`).
   - If no profile is loaded, incoming proxy requests return `401 Unauthorized` / `404 Not Found`.

2. **Framed Stdin Control Channel (`apps/model-gateway/src/control.ts`):**
   - Implement length-delimited JSON framing over the Unix domain socket inside the Gateway container.
   - `apply_snapshot` message handler:
     - Receives credentials and immutable profile revisions via stdin stream.
     - Validates SSRF safety for custom upstream URLs (HTTPS, port 443, no private IP/localhost).
     - Performs atomic swap of active credential slots in memory.
     - Tracks in-flight request references to old key buffers and safely zeros them when refcount drains to 0.
     - Returns `ack` with `gatewayBootId`, `snapshotDigest`, and active counts.
   - `digest` / `status` message handler:
     - Returns `gatewayBootId`, `snapshotDigest`, active profile count, active credential count, and active lease count.

3. **Runner Startup Rehydration & Dynamic Control Client (`apps/runner/src/agent-gateway-control.ts`):**
   - Extend `DockerAgentGatewayControl` with `applySnapshot(credentials, profiles)` and `queryDigest()`:
     - Connects via `docker exec -i <gatewayContainer> ...` using stdin, ensuring secrets never touch command arguments, environment variables, or disk logs.
   - On Runner boot (`AgentManager.start()`), Runner queries Gateway digest:
     - If Gateway is unhydrated, restarted (`gatewayBootId` changed), or digest differs, Runner immediately re-applies the active encrypted snapshot from StateStore before opening admission for agent leases.
   - If Gateway is unreachable, Runner sets sync status to `FAILED` and rejects `agent_spawn` with `503 Service Unavailable`.

4. **Lease Resolution against Dynamic Immutable Revisions (`apps/model-gateway/src/gateway.ts`):**
   - Validate lease against exact `profileRevisionId`.
   - Pre-reserve token and cost budget using revision's pricing.
   - Forward to upstream using credential slot's current active key.

## Files to Modify / Create
- `apps/model-gateway/src/control.ts` (modify: implement framed apply_snapshot and dynamic registry)
- `apps/model-gateway/src/gateway.ts` (modify: support dynamic profile revisions and atomic credential slots)
- `apps/model-gateway/src/config.ts` (modify: support dynamic unconfigured mode)
- `apps/runner/src/agent-gateway-control.ts` (modify: implement dynamic snapshot apply and reconciliation)
- `apps/runner/src/agent-manager.ts` (modify: hook startup rehydration)
- `apps/model-gateway/test/gateway-dynamic-control.test.ts` (create)
- `apps/runner/test/agent-gateway-dynamic-sync.test.ts` (create)

## Tests & Validation
- `npx vitest run apps/model-gateway/test/gateway-dynamic-control.test.ts`
- `npx vitest run apps/runner/test/agent-gateway-dynamic-sync.test.ts`
- `npm run typecheck -w @cloud-harness/model-gateway`
- `npm run typecheck -w @cloud-harness/runner`
