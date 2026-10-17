---
title: "Pi coding-agent subagents"
description: "Bounded, durable agent_* MCP tools backed by a pinned Pi AgentSession runtime outside the control plane and executor credential boundary."
status: completed
priority: P2
effort: "8-12d"
issue: 19
branch: feat/pi-coding-subagents
tags: [agents, pi, mcp, isolation, durability]
blockedBy: []
blocks: []
created: 2026-08-17
---

# Pi coding-agent subagents

## Outcome

Add `agent_spawn`, `agent_status`, `agent_logs`, `agent_message`, `agent_cancel`, and `agent_list` so an authenticated caller can run bounded Pi coding-agent sessions against one existing workspace. Every agent remains principal-, workspace-, lineage-, TTL-, budget-, model-profile-, and tool-policy-bound. A lost response or runner restart never silently duplicates side-effecting work.

## Constraints and non-goals

- Preserve the private single-owner threat model. Use the current server-derived `ownerId` as an opaque principal key; public tools never accept identity. Issue #13 can replace this internal key without changing the public agent schemas.
- Pin `@earendil-works/pi-coding-agent` exactly to `0.84.2`, npm `gitHead` `914cf1472e715297caa30db4b9535d534a9eb718`, and its published integrity in the lockfile. Do not expose both SDK and RPC implementations.
- Run Pi in a dedicated, ephemeral, non-root agent container. It receives no Docker socket, jobs/state mount, repository/provider/control-plane credential, or general outbound network.
- Disable Pi built-ins, extensions, project resource discovery, persistent Pi sessions, and arbitrary commands. Set both `noTools: "all"` and `tools: proxyToolNames`; expose only a closed `AgentProxyOperationSchema` over a strict bounded JSONL protocol.
- Give each agent a unique internal model network shared only with the gateway. The trusted gateway uses a separate `provider-egress` network, exact gateway-only secret mounts, and a fixed validated provider profile; it never joins a runner/API/control network or receives repository/state/Docker mounts.
- Operator-defined model profiles own provider, model, upstream HTTPS base URL, pricing metadata, hard ceilings, and a maximum safe proxy-tool subset. Callers select only a configured profile and narrower budgets/subset.
- Persist bounded orchestration metadata, redacted provenance, usage, message idempotency, and cursorable logs. Enforce global/principal/workspace row/byte/age quotas and a documented lookup horizon; preserve active-workspace idempotency tombstones or reject new work when its fixed record cap is full.
- Never auto-replay after restart. Persist `INTERRUPTED` with `outcomeUnknown: true` only after correlated agent containers, gateway requests, and executor proxy calls are confirmed stopped; otherwise remain nonterminal with cleanup retry metadata.
- Do not claim hostile multi-tenant isolation, unrestricted provider support, durable Pi conversation continuation, or production provider verification without owner-supplied sanitized evidence.

## Architecture decision

```text
MCP agent_* call
  -> API derives principal and sends versioned runner request
  -> WorkspaceService validates principal/workspace and dispatches AgentManager
  -> AgentManager reserves durable state before side effects
  -> constrained Pi worker container (no mounts/secrets/general egress)
       <-> bounded JSONL custom-tool proxy <-> no-touch safe dispatcher -> existing workspace executor
       -> unique internal model network -> model gateway -> dedicated provider-egress -> configured provider
```

Use direct `AgentSession`, not `pi --mode rpc`: the SDK exposes typed events, `prompt`, `steer`, `followUp`, `abort`, and explicit custom tools without RPC's broader command surface or event-correlation ambiguity. `AgentSession.abort()` is cooperative, so every proxy propagates `AbortSignal`, request-scoped runner work is aborted and drained, gateway requests are revoked and drained, and AgentManager retains a TERM/grace/KILL/removal fallback.

## Public contract

- `agent_spawn`: workspace, prompt, idempotency key, configured profile, optional validated parent, TTL, output/token/cost ceilings, and requested tool subset. It acknowledges after durable reservation/launch, not after completion.
- `agent_status`: lookup by agent ID or spawn idempotency key; returns lineage, status, timestamps, budgets/usage, terminal reason, and `outcomeUnknown`.
- `agent_logs`: decimal cursor over bounded retained UTF-8 events; reports truncation when older bytes were evicted or another page remains.
- `agent_message`: idempotent `steer` or `followUp` message with its own idempotency key.
- `agent_cancel`: idempotent post-order cancellation of the target and descendants.
- `agent_list`: bounded workspace-scoped pagination without log payloads.

Terminal states: `SUCCEEDED`, `FAILED`, `CANCELLED`, `TIMED_OUT`, `LIMIT_EXCEEDED`, and `INTERRUPTED`. Nonterminal states: `SPAWNING`, `RUNNING`, and `CANCELLING`.

## Phases

| # | Phase | Dependency | Status |
|---|---|---|---|
| 1 | [Contract, policy, and durable state](./phase-01-start.md) | — | Pending |
| 2 | [Pi SDK worker and model gateway](./phase-02-pi-sdk-worker-and-model-gateway.md) | 1 | Pending |
| 3 | [Durable agent lifecycle and MCP dispatch](./phase-03-durable-agent-lifecycle-and-mcp-dispatch.md) | 1, 2 | Pending |
| 4 | [Isolation verification and operator guidance](./phase-04-isolation-verification-and-operator-guidance.md) | 1, 2, 3 | Pending |

## Acceptance criteria

- [ ] The exact public tool inventory, schemas, annotations, runner dispatch, canonical skill inventory, and E2E behavior include all six `agent_*` operations.
- [ ] Concurrent retries with one spawn/message idempotency key produce one durable record and one side effect; status lookup recovers a lost response.
- [ ] Foreign principal/workspace/parent/agent handles are non-enumerating and cannot read, message, cancel, or reuse another agent.
- [ ] Workspace close, workspace TTL, agent TTL, budget exhaustion, or parent cancellation removes descendants deterministically before workspace files are removed.
- [ ] Pi has no control-plane/provider credential, Docker socket, repository mount, default tool, extension, peer-agent route, control network, or general egress; only its configured proxy tools and per-agent model-gateway path are reachable.
- [ ] Logs, metadata, provenance, event queues, messages, model/tool outputs, rows, and tombstones stay bounded; log append/eviction/watermark updates are atomic and secrets are redacted before persistence or response.
- [ ] Runner restart aborts and drains executor/gateway work, confirms agent-container removal, records unknown outcome, retains in-scope idempotency tombstones, and never auto-replays.
- [ ] Focused contract/unit/integration tests, `npm run verify`, Compose boundary verification, image builds, Docker tests, and E2E tests pass with a fake provider and no production credentials.

## Existing-plan relationship

- Builds on completed issue #11/tool-surface plan.
- Uses the current request-derived `ownerId` seam and aligns with issue #13 without importing its unmerged types or provider-secret implementation.
- Implements the durable agent-specific portion of `plans/260817-0848-2-cloud-harness-next-steps/phase-03-durable-workspace-and-git-semantics.md`; it does not implement repository caching or generic durable tasks.

## Evidence

- Local boundary owners: `packages/contracts/src/runner-api.ts`, `packages/contracts/src/tool-schemas.ts`, `apps/api/src/mcp-server.ts`, `apps/runner/src/workspace-service.ts`, `apps/runner/src/state-store.ts`, `apps/runner/src/operation-manager.ts`.
- Upstream: published `@earendil-works/pi-coding-agent@0.84.2`, npm `gitHead` `914cf1472e715297caa30db4b9535d534a9eb718`, integrity `sha512-l4E+B7hgXKWddRo8bC/eSue2aWZjEgJ9xIpf5p0Og+lq8a2TArCwJ0HCoCPCgaBP/tN4zbYH/wOwvx9pJpeLCA==`; SDK docs and security guidance require an external sandbox and expose typed AgentSession lifecycle/cancellation.
- Current lifecycle evidence: only workspace metadata is durable; shell/session/task handles disappear on runner restart, so AgentManager must not reuse `OperationManager` storage.

## Red Team Review

### Session — 2026-08-17

**Findings:** 15 deduplicated (15 accepted, 0 rejected); 0 Critical, 12 High, 3 Medium.

| # | Accepted finding | Severity | Applied to |
|---|---|---|---|
| 1 | Isolate workers on per-agent internal model networks | High | Phase 2 |
| 2 | Separate trusted gateway egress from runner/control networks and narrow its claim | High | Phase 2 |
| 3 | Reject agent spawn for network-enabled workspaces | High | Phases 1, 3, 4 |
| 4 | Define a closed agent-safe proxy-operation schema and profile maximum | High | Phases 1, 3 |
| 5 | Execute agent tools without refreshing workspace idle expiry | High | Phase 3 |
| 6 | Serialize child spawn against parent cancellation and workspace reaping | High | Phases 1, 3 |
| 7 | Abort and drain executor proxy calls before terminal state | High | Phases 2, 3 |
| 8 | Revoke and drain gateway requests before terminal state | High | Phases 2, 3 |
| 9 | Split gateway credentials from runner/API environment and mounts | High | Phases 1, 2, 4 |
| 10 | Bound rows, logs, messages, and tombstones with explicit horizons/quotas | High | Phases 1, 3 |
| 11 | Activate custom Pi tools explicitly with `tools: proxyToolNames` | High | Phase 2 |
| 12 | Reserve model budget before each provider request and clamp output | High | Phases 2, 3 |
| 13 | Define a production-faithful, test-only TLS fake-provider topology | Medium | Phases 2, 4 |
| 14 | Pin the npm artifact's real git head/integrity and add a gateway image | Medium | Plan, Phase 2 |
| 15 | Make shutdown, restart cleanup, message delivery, and log eviction crash-consistent | Medium | Phases 1, 3, 4 |

### Whole-Plan Consistency Sweep

- Files reread: `plan.md` and all four phase files.
- Decision deltas checked: 15.
- Reconciled stale references: shared networks, runner egress, unrestricted proxy operations, touch-based execution, post-hoc budgets, unbounded tombstones, unconditional restart terminal state, Pi provenance, and gateway image/test topology.
- Unresolved contradictions: 0.

## Validation Log

### Verification Results

- Tier: Standard; claims checked: 40.
- Verified: 40; Failed: 0; Unverified: 0.
- Evidence covers the generated tool-registration chain, owner-bound private runner request, explicit worker fallback, state schema/fencing, operation retention, executor flags, Compose networks/mounts, cleanup order, HTTP abort flow, and published Pi package metadata.
- No user interview question remained after applying the evidence-backed red-team decisions; issue #19 fixes the outcome and autonomous beta pipeline fixes the delivery mode.

### Whole-Plan Consistency Sweep

- Files reread: `plan.md` and all four phase files after validation.
- Rechecked public names, statuses, network names, secret ownership, safe proxy operations, TTL semantics, retention, cancellation barriers, test topology, and Pi provenance.
- Unresolved contradictions: 0.

## Open questions

None. The provider profile format starts with operator-configured Pi-supported HTTP APIs through the fixed gateway; adding provider-specific OAuth or local-model transports requires a later explicit contract.

<!-- slug: pi-coding-agent-subagents -->
