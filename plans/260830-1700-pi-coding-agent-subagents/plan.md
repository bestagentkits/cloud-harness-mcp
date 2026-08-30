# Plan: Pi Coding-Agent Subagents (Issue #19)

- Status: in_progress
- Mode: feature
- Route: ak:cook --tdd --auto
- Issue: https://github.com/bestagentkits/cloud-harness-mcp/issues/19
- Brainstorm Brief: plans/reports/brainstorm.html

## Outcome
Integrate six bounded `agent_*` MCP tools (`agent_spawn`, `agent_status`, `agent_logs`, `agent_message`, `agent_cancel`, `agent_list`) backed by `@earendil-works/pi-coding-agent` running in dedicated ephemeral containers, strictly isolated from the workspace, host, and control plane, communicating via stdio JSONL tool proxy with 10 safe file/search operations and routed through a trusted Model Gateway with scoped capability leases.

2. [Phase 02: Agent Runtime, Model Gateway & Container Topology](phase-02-agent-runtime-and-model-gateway.md) — `apps/agent-runtime` (pinned exact package family `@earendil-works/pi-coding-agent@0.84.2` and `@earendil-works/pi-ai@0.84.2`, in-memory `ResourceLoader`, zero ambient discovery, JSONL bridge, `docker/agent.Dockerfile`), `apps/model-gateway` (lease validation, budget pre-reservation/settlement, provider-egress only, `docker/model-gateway.Dockerfile`), Compose integration (`compose.yaml`, `compose.production.yaml`, `scripts/verify-compose-boundaries.mjs`), and profiles.
3. [Phase 03: Runner AgentManager, SQLite Durability & Cleanup Barrier](phase-03-runner-lifecycle-and-state.md) — `AgentManager`, `AgentLauncher`, `AgentGatewayControl`, `AgentStateRepository` sharing `StateStore.database`, epoch fencing, 32-way idempotency, and cascading cleanup barrier (Revoke -> Drain -> TERM/KILL -> Remove -> Verify 0 residual) wired before `WorkspaceService.safeRemovePath`.
4. [Phase 04: API MCP Tools & Dispatch](phase-04-api-and-mcp-tools.md) — Connect 6 `agent_*` tools via generated `TOOL_SPECS` in `apps/api/src/mcp-server.ts`, generic `RunnerClient` translation, server-derived principal authorization, and non-enumerating error responses.
5. [Phase 05: Docker E2E, Crash Matrix & Adversarial Suite](phase-05-tests-and-verification.md) — Unit tests across packages, SQLite transaction/fencing tests, Docker E2E fake TLS provider test, 32-way concurrency, crash injection matrix, zero-residual checks, and root verification gates.
6. [Phase 06: Documentation, Docs-Site, Skill Guidance & Plugin Sync](phase-06-documentation-and-skill-sync.md) — Update `docs/mcp-api.md`, `docs/system-architecture.md`, `docs-site/`, `.agents/skills/cloudharness/SKILL.md`, `.agents/skills/cloudharness/references/`, run `npm run plugin:sync`, verify `cloudharness-skill-contract.test.ts`, and define live-provider canary runbook.

## Acceptance Criteria
- [ ] Exactly 6 public tools (`agent_spawn`, `agent_status`, `agent_logs`, `agent_message`, `agent_cancel`, `agent_list`) with strict schemas, opaque handles, and server-derived principal authorization.
- [ ] Dedicated agent container with read-only rootfs, non-root user, no Docker socket, zero host/repo mounts, zero secrets, and isolated network.
- [ ] Workspace `networkMode: none` admission requirement strictly enforced (reject spawn if workspace is `bridge`).
- [ ] Closed proxy universe of exactly 10 operations (`files_list`, `files_read`, `files_write`, `files_apply_patch`, `files_delete`, `files_move`, `files_mkdir`, `grep_search`, `symbols_search`, `symbols_references`) with server-injected workspace scope.
- [ ] Pi `AgentSession` lockdown: `noTools: "all"`, `tools: proxyToolNames`, in-memory ResourceLoader (0 extensions/skills/prompts/themes/context discovery), disabled ambient `auth.json`/provider env, disabled nested `agent_spawn`.
- [ ] Model Gateway capability leases: single-agent, scoped, hashed, atomically pre-reserved token/cost budget, provider-egress only.
- [ ] Cascading cleanup barrier: Revoke lease -> Drain/abort requests -> TERM/KILL -> Remove container & network -> Verify zero residual -> only then allow workspace deletion.
- [ ] SQLite crash consistency: transaction before side effect, epoch bump, no auto-replay of unverified side effects, explicit `outcomeUnknown: true` and `INTERRUPTED`.
- [ ] 32-way concurrent idempotency for spawn and message operations.
- [ ] Secret redaction before persistence and public response across all streams.
- [ ] Documentation, docs-site, agent skill, and plugin sync byte-identical parity verified.
