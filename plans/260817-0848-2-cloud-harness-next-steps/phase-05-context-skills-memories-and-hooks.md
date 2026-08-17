---
phase: 5
title: "Context, skills, memories, and hooks"
status: pending
priority: P2
effort: "4-6d"
dependencies: [1, 2]
---

# Phase 5: Context Skills Memories and Hooks

## Overview

Turn today’s repository-local discovery into portable, provenance-aware
context primitives while keeping repository-supplied instructions and scripts
untrusted. This benefits every MCP client without tying behavior to one agent
vendor.

## Requirements

- [ ] Define source precedence for built-in, owner, repository, and workspace
  skills; keep an explicit selected source and version in every result.
- [ ] Generate a bounded workspace context manifest from known files such as
  `AGENTS.md`, `CLAUDE.md`, skill roots, language manifests, and test commands.
- [ ] Replace workspace-file-only memories with owner/repository/workspace
  scopes, provenance, explicit write authorization, bounded search, retention,
  and deletion.
- [ ] Replace manual-only hooks with named lifecycle events only where the
  security model permits; hook execution remains inside the executor and is
  never a policy or network boundary.

## Related Code Files

- Modify: `packages/contracts/src/runner-api.ts`, `packages/contracts/src/tool-schemas.ts`, `worker/harness-worker.mjs`, `apps/runner/src/workspace-service.ts`, `apps/runner/src/state-store.ts`, `docs/mcp-api.md`.
- Create: context-manifest and memory-store modules as small focused owners.
- Test: `packages/contracts/test/contracts.test.ts`, `test/e2e/coding-workflow.docker.test.ts`.

## Implementation Steps

1. Specify scope/precedence/provenance schemas and the threat model for
   repository-controlled instructions.
2. Implement passive discovery and a bounded context-manifest response; never
   automatically execute a discovered script.
3. Implement scoped memory storage and search with source attribution,
   optimistic concurrency, explicit deletion, and retention cleanup.
4. Add a small event registry and explicit run semantics for safe hook events;
   retain manual execution when an event would change privilege or authority.
5. Test precedence, persistent-prompt-injection resistance, restart behavior,
   output bounds, and deletion/cleanup.

## Todo

- [ ] Scope and precedence contract approved.
- [ ] Context/memory/hook schemas and tests added.
- [ ] MCP usage/security documentation updated.

## Success Criteria

- [ ] A client can identify where a skill, memory, or context item came from
  and who may change it.
- [ ] Repository content cannot silently create privileged persistent memory or
  bypass egress, Git, or authorization policy.
- [ ] All new context results remain bounded and cursorable where needed.

## Risk Assessment

Persistent context is a long-lived prompt-injection surface. Provenance,
explicit mutation, reviewable output, and TTL are more important than broad
automatic injection.
