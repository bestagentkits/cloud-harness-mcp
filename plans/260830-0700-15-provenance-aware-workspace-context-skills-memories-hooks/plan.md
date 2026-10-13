---
issue: 15
title: "P2: Add provenance-aware workspace context, skills, memories, and hooks"
status: completed
route: feature
mode: official
branch: mrgoonie/p2-add-provenance-aware-workspace-context-skills
created_at: 2026-08-30
---

# Implementation Plan: Provenance-Aware Workspace Context, Skills, Memories & Hooks

## Overview
Implement vendor-neutral, portable coding context across MCP clients (Claude, Codex, Cursor, Aider) with non-forgeable provenance, deterministic skill precedence, principal-isolated SQLite memories, declarative lifecycle hooks, and adversarial output-boundary containment.

## Architectural Direction
- **Passive Worker Scanner:** Bounded scanning of known allowlisted instruction files (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules/*.mdc`, `.aider.conf.yml`), language manifests, and test declarations with Zero-Execution.
- **Runner Provenance Engine:** Resolves trust and mutability (`built-in > owner > workspace > repository`) at the trusted runner boundary.
- **SQLite Scoped Memories (StateStore v5):** Principal, repository, and workspace scopes with CAS generation concurrency, TTL cleanup, and tag filtering.
- **Declarative Hooks:** Named lifecycle registry (`pre_commit`, `post_checkout`) with digest-pinned activation in short-lived, no-network, no-secret executor containers.
- **Adversarial Output Boundary:** Provenance-aware text projection formatting and structured encapsulation preventing prompt injection or memory leakage.

## Acceptance Criteria
- [x] Every context item returned by `workspace_context` includes explicit provenance (`source`, `trust`, `mutableBy`, `contentSha256`, `discoveredAt`).
- [x] Passive context scanning performs zero script executions and honors declared byte/file caps with explicit truncation indicators.
- [x] Adversarial repository text with fake SYSTEM headers, forged provenance fields, or delimiters remains strictly escaped inside `untrusted-executor` data and creates zero persistent memory.
- [x] 4 same-name skill candidates resolve strictly to `built-in > owner > workspace > repository` with shadowed candidate visibility.
- [x] Memory operations support `owner`, `repository`, and `workspace` scopes with CAS generation checks, TTL expiry, and tag search.
- [x] Lifecycle hooks execute only with matching SHA-256 digest activations inside unprivileged, no-network executor containers.
- [x] Schema v4 transactionally migrates to v5 and rolls back cleanly on failure.
- [x] All unit, integration, and contract tests pass.

## Phases
1. [Phase 1: Contracts & Schemas](phase-01-contracts-and-schemas.md) - Status: completed
2. [Phase 2: Worker Passive Scanner & Provenance-Aware Formatter](phase-02-worker-passive-scanner-and-provenance-formatter.md) - Status: completed
3. [Phase 3: Skill Precedence & Resolver](phase-03-skill-precedence-and-resolver.md) - Status: completed
4. [Phase 4: Scoped SQLite Memories & CAS](phase-04-scoped-sqlite-memories-and-cas.md) - Status: completed
5. [Phase 5: Declarative Hooks & Sandbox Execution](phase-05-declarative-hooks-and-sandbox-execution.md) - Status: completed
6. [Phase 6: Adversarial Output-Boundary, Verification & Docs Sync](phase-06-adversarial-output-boundary-and-docs-sync.md) - Status: completed
