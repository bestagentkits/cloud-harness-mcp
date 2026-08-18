---
phase: 3
title: "Durable agent lifecycle and MCP dispatch"
status: pending
priority: P1
effort: "3-4d"
dependencies: [1, 2]
---

# Phase 3: Durable agent lifecycle and MCP dispatch

## Overview

Implement `AgentManager`, explicit runner dispatch, durable logs/messages/usage, admission, cancellation, and restart reconciliation. All side effects remain principal- and workspace-scoped.

## Requirements

- Keep `AgentManager` separate from process-local `OperationManager`; reuse only cursor/status/termination concepts.
- Spawn sequence: validate the configured profile and requested safe-tool subset; in one `BEGIN IMMEDIATE` transaction recheck workspace `ACTIVE`/generation/network `none`, parent `RUNNING`/generation, open admission fences, and capacity while inserting `SPAWNING`; then launch the deterministic labeled container/network, attach bounded drains, fenced-update `RUNNING`, and return promptly.
- Define a closed `AgentProxyOperationSchema` independent of the public runner enum. Least-privilege defaults expose bounded file/search/patch operations; profiles may widen only inside that schema and can never grant remote Git, deployments, skills/hooks, tasks/sessions, worktrees, agent nesting, or other brokered/open-world operations.
- Execute proxy tools through a principal-scoped internal dispatcher that reuses input/path/worker/resource validation but never calls `touch`. Recheck workspace generation/status/expiry before and after each tool and reject all agent work for a network-enabled workspace.
- Enforce global, principal, workspace, and per-parent active counts transactionally. Agent TTL cannot exceed the current workspace expiry and background agent/model/tool activity cannot extend it.
- Before every model request, atomically reserve worst-case input/output/cost from the remaining lease and have the gateway clamp output tokens; reconcile actual streamed usage. Track output bytes, event count, tool time, and wall time. Any exhausted ceiling closes admission and begins recursive cancellation.
- Append log chunks, usage, aggregate eviction, and retained-base cursor watermark in one `BEGIN IMMEDIATE` transaction; startup repair enforces caps before reads. Apply global/principal/workspace byte/row/age quotas and return deterministic decimal cursor/truncation semantics.
- Make `agent_message` independently idempotent with durable `RESERVED/SENT/REJECTED/UNKNOWN` state and one per-agent admission mutex. Fence delivery by agent generation; close message/child admission before entering `CANCELLING`.
- Cancel descendants post-order; abort and drain every request-ID-scoped executor proxy call; revoke and drain gateway leases/upstream requests; TERM, bounded grace, KILL/remove the agent container; disconnect/remove its network; only then mark terminal. Cleanup failure stays nonterminal in `CANCELLING`/workspace `REAPING` with retry metadata.
- On runner start, correlate persisted nonterminal rows, labeled containers, networks, and gateway leases. Retry cleanup with bounded backoff before readiness; mark `INTERRUPTED`/unknown only after absence/drain is confirmed. Never auto-replay.
- `WorkspaceService.closeRecord` first fences agent spawn/message admission, then awaits `AgentManager.stopWorkspace` after claiming `REAPING` and before executor/path removal.

## Architecture

`WorkspaceService.execute` explicitly routes all six public names to AgentManager before its generic executor fallback. The manager receives the server-derived principal and validated workspace record. A separate internal no-touch dispatcher maps only `AgentProxyOperationSchema` values to worker operations and owns request-scoped abort controllers; its injected launcher/protocol/tool-execution interfaces keep Docker, persistence, and Pi testable independently.

The existing network-`none` workspace executor remains the only repository writer. Agent proxy tools invoke fixed worker operations there without refreshing parent TTL, so path/symlink/output/timeout/network policy is reused without giving Pi brokered credentials or a second writable checkout.

## Related code files

- Create: `apps/runner/src/agent-manager.ts` and small focused agent persistence/log/launcher modules as needed
- Modify: `apps/runner/src/workspace-service.ts`, `docker-engine.ts`, `index.ts`, `state-store.ts`
- Modify: `packages/contracts/src/runner-api.ts`, `tool-schemas.ts` only for phase-1 contract propagation
- Test: new `apps/runner/test/agent-manager.test.ts`, `agent-api-contract.test.ts`; extend cleanup/restart/state tests

## TDD implementation steps

1. Build fake launcher/channel/tool-executor tests for every state transition and race: reserve/create/start/run/finish/cancel/drain/remove, including repeated removal failures.
2. Add concurrent spawn/message replay, capacity-slot, child-spawn-vs-parent-cancel, and spawn-vs-workspace-close barrier tests; prove one row/container/effect and truthful message delivery state.
3. Add principal/workspace/parent authorization, lineage cycle, descendant cancellation, unrelated-sibling, network-enabled workspace rejection, no-touch expiry, and workspace-close ordering tests.
4. Add log append/eviction fault injection, cursor/UTF-8 boundaries, secret redaction, pre-request token/cost reservation, time/output exhaustion, global retention, and startup repair tests.
5. Add crash-point reconciliation tests before/after reservation, Docker/network create, provider dispatch, tool side effect, message write, log eviction, container removal, and terminal persistence.
6. Implement manager, explicit public dispatch, closed no-touch proxy dispatch, message/control/gateway channels, reaper integration, and ordered shutdown: stop all mutation admission, await/abort HTTP work, drain manager work, persist unresolved rows, close streams, then close SQLite.
7. Re-run focused runner tests and exact race/cancellation reproductions.

## Success criteria

- [x] Same spawn key returns one agent during the documented active-workspace lifetime; lookup by key recovers a lost response and a full lifetime record cap rejects rather than evicts.
- [x] Different principals/workspaces cannot infer, message, cancel, parent, or read each other's agents/logs.
- [x] Parent/workspace cancellation fences admission, drains provider/tool work, and removes every descendant/network before terminal/closed state is reported.
- [x] Every limit is enforced before an unbounded provider/tool action where possible, has a tested terminal reason, and cannot grow memory/disk/event queues/rows beyond configuration.
- [x] Restart remains nonterminal while cleanup is unconfirmed, then records durable unknown outcome without duplicate execution.
- [x] Every public agent operation and every safe proxy operation is explicitly dispatched; neither can fall through to generic/open-world runner behavior.
- [x] Graceful stop rejects all new agent mutations, drains or marks uncertain work, and closes SQLite only after request/manager shutdown ordering completes.

## Risk assessment

Crash consistency spans SQLite, Docker container/network creation, gateway leases, protocol attachment, executor side effects, message delivery, log eviction, and shutdown. Deterministic identities plus immediate transactions, generation/admission fences, abort/drain barriers, and confirmed removal are mandatory; status accuracy is more important than optimistic recovery.
