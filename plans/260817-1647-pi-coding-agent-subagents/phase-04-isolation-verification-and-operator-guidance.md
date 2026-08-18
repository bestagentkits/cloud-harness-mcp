---
phase: 4
title: "Isolation verification and operator guidance"
status: pending
priority: P1
effort: "1-2d"
dependencies: [1, 2, 3]
---

# Phase 4: Isolation verification and operator guidance

## Overview

Prove public parity, real container boundaries, lifecycle cleanup, and fake-provider E2E behavior; then update only the owning contract/security/configuration/development guidance.

## Requirements

- Replace loose MCP tool-count assertions with exact `RunnerOperationSchema`/`TOOL_SPECS` equality and table-driven annotation checks.
- Extend the canonical Cloud Harness skill inventory and examples so its existing contract test validates all six operations.
- Exercise spawn/status/log/message/cancel/list through the real MCP SDK, private runner transport, AgentManager, actual Pi package, model gateway, fake provider, and Docker worker.
- Add adversarial attempts for foreign workspace/principal handles, default/bypassed/open-world tools, bridge-backed workspaces, traversal/symlink escape, peer-agent/direct Internet/control/Docker/metadata access, credential reads, log poisoning, prompt injection, output flood, hung model/tool, and crash reconciliation.
- Preserve current cleanup-failure assertions and verify request-scoped tool abort, upstream provider disconnect, container/network removal, and gateway lease revocation before workspace executor/path removal.
- Document exact idempotency horizon, lifetime record cap, status/log cursor/message/cancellation/restart semantics in `docs/mcp-api.md`; record boundary rationale in security/system architecture, service-specific secret/network ownership in configuration docs/example env, and Docker verification commands in development docs only when changed.
- Do not claim hostile gateway isolation, a live production provider/private repository/deployment, or support for provider transports that were not verified with owner-authorized sanitized evidence.

## Architecture

Verification layers remain distinct:

1. Contract: identifiers, schemas, defaults, annotations, config, exact inventory.
2. Runner unit/integration: persistence, races, budgets, ownership, logs, cancellation, restart, cleanup failure.
3. HTTP MCP: generated registration and exact private forwarding/result envelope.
4. Compose/Docker: unique agent networks, dedicated provider egress, service-specific mounts/env, UID/capability isolation, peer/control/Internet reachability, gateway lease drain, and confirmed cleanup.
5. E2E: a test-only Compose profile runs a TLS fake provider with a trusted test CA/profile unavailable in production; actual Pi completes and mutates only the assigned network-`none` executor workspace through allowed proxy tools.

## Related code files

- Modify: `test/integration/mcp-http.test.ts`, `docker-sandbox.docker.test.ts`, `test/e2e/coding-workflow.docker.test.ts`
- Modify: `packages/contracts/test/cloudharness-skill-contract.test.ts`, `.agents/skills/cloudharness/SKILL.md`, `.agents/skills/cloudharness/references/canonical-tool-inventory.md`
- Modify when behavior warrants: `docs/mcp-api.md`, `security-model.md`, `system-architecture.md`, `configuration.md`, `development.md`, `.env.example`
- Verify: `scripts/verify-compose-boundaries.mjs`, root `package.json` gates, test-only fake-provider Compose topology

## TDD implementation steps

1. Add exact public inventory/annotation/private-forwarding tests and make them pass without weakening existing assertions.
2. Add Docker isolation tests that inspect per-agent/gateway/provider networks, mounts, user, root filesystem, capabilities, service-specific env/secrets, absence of host ports, peer isolation, and negative control/direct-egress reachability.
3. Add production-config rejection plus a separate test-only TLS fake-provider profile; exercise successful edit, steer/follow-up, log paging, cancel/drain, parent cascade, TTL/pre-request budget stop, workspace close, restart cleanup failure/unknown outcome, and idempotent recovery.
4. Run the narrowest suites while fixing defects; then run `npm run verify:compose` and `npm run verify`.
5. Build `executor-image`, `agent-image`, `model-gateway`, `api`, and `runner`; run `npm run test:docker` and `npm run test:e2e` when Docker/network prerequisites are available.
6. Update executable inventories and evergreen docs; re-run their owning checks.

## Success criteria

- [x] Exact public schema/annotation/dispatch/inventory parity passes.
- [x] Real agent containers cannot reach or mount control-plane, Docker, another agent/workspace, provider credentials, metadata, or general Internet destinations; bridge-backed workspace spawn is rejected.
- [x] Fake-provider E2E proves all six tools, exact proxy-tool policy, bounded logs/messages/records, pre-request budgets, idempotency recovery, cancellation/drain hierarchy, and restart unknown outcome.
- [x] Existing `npm run verify`, Compose, Docker, and E2E gates pass without weakened timeouts/security/cleanup assertions.
- [x] Documentation points to executable owners and states the single-owner, trusted-gateway, service-specific secret, provider-profile, idempotency-horizon, unknown-outcome, and no-live-provider limits truthfully.

## Risk assessment

A mocked AgentSession alone cannot prove the Docker/network boundary. Keep fast unit tests for race coverage, but require at least one real Pi/fake-provider Docker path and negative reachability tests before shipping.
