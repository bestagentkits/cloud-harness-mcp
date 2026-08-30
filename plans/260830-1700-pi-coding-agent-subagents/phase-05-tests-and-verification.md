# Phase 05: Tests, Verification & Adversarial Suites

## Context Links
- Master Plan: [plan.md](plan.md)
- Phase 04: [phase-04-api-and-mcp-tools.md](phase-04-api-and-mcp-tools.md)

## Requirements
1. **Docker E2E & Fake Provider Suite (`test/e2e/pi-agent.docker.test.ts`):**
   - End-to-end flow with real agent image and test-only TLS Fake Provider.
   - 32-way concurrent spawn/message idempotency test.
   - Lost spawn response recovery via `agent_status{idempotencyKey}`.
   - Cascading cancellation post-order on parent-child trees.
   - Token & cost budget cutoff enforcement.
   - Secret redaction canary verification across DB, logs, and responses.
2. **Container Isolation & Security Probes (`test/integration/agent-isolation.docker.test.ts`):**
   - Probe `/var/run/docker.sock`, `/proc`, host mounts, secrets, and unauthorized network endpoints.
   - Verify non-root user, read-only rootfs, bounded tmpfs, and zero host/repo mounts.
   - Verify agent cannot access public internet or control plane networks.
3. **Crash Injection & Epoch Fencing Matrix:**
   - Test crash failpoints across reservation, container creation, tool execution, message delivery, and cleanup phases.
   - Assert zero auto-replay of unverified side effects and `INTERRUPTED/outcomeUnknown: true`.
4. **Root Verification Gates:**
   - Run `npm run verify:compose`
   - Run `npm run test:unit`
   - Run `npm run test:integration`
   - Run `npm run lint`
   - Run `npm run typecheck`

## Files to Modify / Create
- `test/e2e/pi-agent.docker.test.ts`
- `test/integration/agent-isolation.docker.test.ts`
- `test/agent-docker-test-support.ts`

## Tests & Validation
- `npm run verify`
