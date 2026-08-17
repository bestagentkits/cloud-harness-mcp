---
title: "Cloud Harness MCP: Next Evolution"
description: "A staged roadmap from the verified private MVP to durable collaboration primitives and, only after a threat-model decision, stronger tenant isolation."
status: pending
priority: P1
effort: "18-29d"
issue: 2
branch: feature/complete-coding-harness-surface
tags: [roadmap, mcp, security, runner]
blockedBy: []
blocks: []
created: 2026-08-17
---

# Cloud Harness MCP: Next Evolution

## Overview

The completed MVP already implements the control-plane/executor split, modern
stateless Streamable HTTP, owner-bound workspaces, bounded filesystem and
execution tools, shell/task handles, Git/worktree operations, repository-local
skills/hooks/memories, Docker deployment, and live interoperability checks.

This plan deliberately does not rebuild that foundation. It closes the few
private-MVP operational gaps first, then adds the highest-value collaboration
and durability capabilities. The final isolation phase is an explicit product
gate, not permission to market the current Docker design as multi-tenant.

The completed plan
[`Complete coding harness tool surface`](../2026-08-17-11-complete-coding-harness-surface/plan.md)
owns the remote-Git, task-graph, local-primitives, and documentation baseline.
Do not duplicate those edits here; this roadmap starts from that accepted
public contract.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Preserve the verified single-owner operating boundary while making evidence and audit data durable. | P1 |
| 2 | Enable controlled private-repository collaboration without giving credentials to executors. | P1 |
| 3 | Make long-running task results and retained artifacts durable and recoverable. | P2 |
| 4 | Decide and build the required identity, egress, and isolation boundary before any shared-user launch. | P1 |
| 5 | Make skills, workspace context, memories, and hooks useful across clients without treating repository data as trusted policy. | P2 |

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Private MVP operational closure](./phase-01-start.md) | Pending |
| 2 | [Identity, egress, and audit controls](./phase-02-identity-egress-and-audit-controls.md) | Pending |
| 3 | [Durable workspace and Git semantics](./phase-03-durable-workspace-and-git-semantics.md) | Pending |
| 4 | [Tenant isolation and scale readiness](./phase-04-tenant-isolation-and-scale-readiness.md) | Pending |
| 5 | [Context, skills, memories, and hooks](./phase-05-context-skills-memories-and-hooks.md) | Pending |

## Comparison with the originating architecture

| Original concern | MVP status | Roadmap response |
|---|---|---|
| Stateless MCP, opaque workspace/task/shell handles, separated control and execution planes | Implemented and live-verified | Preserve as the public contract. |
| File, search, exec, shell, task, Git, worktree, skill, hook, memory, symbol, session, and deployment tools | Broad structured surface implemented; the executable schema is authoritative | Improve persistence and semantics; do not expand surface speculatively. |
| Private clone without executor credentials | Implemented and leak-tested; live private clone remains owner-gated | Complete owner-authorized verification; brokered fetch/push is owned by the concurrent tool-surface plan. |
| Repository capsule/cache and reusable repo identity | Missing | Phase 3 introduces a durable repository record and per-owner cache only if measurements justify it. |
| Durable task logs/artifacts and standard MCP Tasks facade | Missing; handles/output are runner-memory only | Phase 3. |
| Scoped skills, context manifest, persistent searchable memories, event hooks | Partial: repository-local skills, manual hooks, workspace files | Phase 5. |
| OAuth/RBAC, controlled egress, gVisor/microVM, tenant quotas | Explicitly out of scope for the private MVP | Phase 4 is a prerequisite gate for shared users. |

## Success Criteria

- [ ] Current private-MVP limitations remain truthful, tested, and observable.
- [ ] Brokered Git collaboration cannot leak credentials into executor files, environment, logs, or remote URLs.
- [ ] Task/artifact and repository state have documented restart, retention, idempotency, and cleanup semantics.
- [ ] Context primitives have scope, provenance, and user-controlled mutation semantics.
- [ ] No multi-user or untrusted-repository service is enabled until the Phase 4 threat-model gate passes.

<!-- slug: 2-cloud-harness-next-steps -->
