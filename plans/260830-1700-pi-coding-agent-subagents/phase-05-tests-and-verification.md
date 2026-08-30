# Phase 05: Tests, Verification, Documentation & Release Readiness

## Context Links
- Master Plan: [plan.md](plan.md)
- Phase 04: [phase-04-api-and-mcp-tools.md](phase-04-api-and-mcp-tools.md)
- AGENTS.md requirements: `AGENTS.md`

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

4. **Internal Architecture & Operational Documentation (`docs/`):**
   - Update `docs/mcp-api.md` with the 6 new `agent_*` tools, lifecycle semantics, idempotency, and error codes.
   - Update `docs/system-architecture.md` with the Model Gateway, dedicated agent container topology, and security invariants.
   - Update `docs/security-model.md` with Pi untrusted workload constraints, network isolation, and lease mechanisms.
   - Update `docs/configuration.md` with agent profile and gateway configuration variables.
   - Update `docs/development.md` with agent-image builds, gateway test fixtures, and Docker test commands.
   - Update `docs/operations.md` with the owner-authorized, low-budget real-provider canary runbook.

5. **Official User Documentation Site (`docs-site/`):**
   - Update `docs-site/reference/tools.md` via `npm run docs:reference` to reflect all 81 tools.
   - Update `docs-site/reference/environment-variables.md` for gateway and agent variables.
   - Update `docs-site/ai-tools/overview.md`, `docs-site/agent-skill.md`, `docs-site/how-it-works.md`, and `docs-site/security-model.md`.
   - Verify docs site build cleanly passes via `npm run docs:build`.

6. **Agent Skill & Mirrored Plugin Synchronization:**
   - Update `.agents/skills/cloudharness/SKILL.md` to document the 6 `agent_*` tools and effective usage workflows.
   - Update `.agents/skills/cloudharness/references/execution-and-tasks.md` and `.agents/skills/cloudharness/references/tool-reference.md`.
   - Run `npm run plugin:sync` to mirror changes byte-identically into `plugins/cloud-harness/skills/cloudharness/`.
   - Verify skill contract compliance with `npx vitest run packages/contracts/test/cloudharness-skill-contract.test.ts`.

7. **Root Verification Gates:**
   - Run `npm run verify:compose`
   - Run `npm run test:unit`
   - Run `npm run test:integration`
   - Run `npm run lint`
   - Run `npm run typecheck`
   - Run `npm run plugin:check`
   - Run `npm run docs:build`
   - Run `npm run test:docker` and `npm run test:e2e` (when Docker is available)

## Files to Modify / Create

- Tests & Fixtures:
  - `test/e2e/pi-agent.docker.test.ts`
  - `test/integration/agent-isolation.docker.test.ts`
  - `test/agent-docker-test-support.ts`
  - `scripts/generate-model-gateway-test-fixtures.mjs`
- Internal Documentation:
  - `docs/mcp-api.md`
  - `docs/system-architecture.md`
  - `docs/security-model.md`
  - `docs/configuration.md`
  - `docs/development.md`
  - `docs/operations.md`
- Documentation Site:
  - `docs-site/reference/tools.md`
  - `docs-site/reference/environment-variables.md`
  - `docs-site/ai-tools/overview.md`
  - `docs-site/agent-skill.md`
  - `docs-site/how-it-works.md`
  - `docs-site/security-model.md`
- Agent Skill & Plugin Mirrors:
  - `.agents/skills/cloudharness/SKILL.md`
  - `.agents/skills/cloudharness/references/execution-and-tasks.md`
  - `.agents/skills/cloudharness/references/tool-reference.md`
  - `plugins/cloud-harness/skills/cloudharness/SKILL.md`
  - `plugins/cloud-harness/skills/cloudharness/references/execution-and-tasks.md`
  - `plugins/cloud-harness/skills/cloudharness/references/tool-reference.md`

## Tests & Validation

- `npm run plugin:sync`
- `npm run plugin:check`
- `npx vitest run packages/contracts/test/cloudharness-skill-contract.test.ts`
- `npm run docs:reference && npm run docs:build`
- `npm run verify:compose`
- `npm run verify`
- `CLOUD_HARNESS_REQUIRE_DOCKER_TESTS=1 npm run test:docker`
- `CLOUD_HARNESS_REQUIRE_DOCKER_TESTS=1 npm run test:e2e`
