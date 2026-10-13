---
title: "Map Diagram Facts And Motion"
status: completed
---

# Map Diagram Facts And Motion

## Context

- `docs/system-architecture.md` defines the public ingress, API, runner,
  Docker, executor, and transfer-helper boundaries.
- `docs/mcp-api.md` defines open, work, remote Git, and close semantics.
- `site/index.html` currently uses `.signal-flow`, `.coding-rail`, and
  `.architecture-map` card rails with decorative connector motion.

## Requirements

- [x] Translate only verified runtime relationships into visual nodes and paths.
- [x] Give every motion path a semantic role: request, result, lifecycle state,
  or Git transfer.
- [x] Define a static readable state before motion and a reduced-motion state.

## Diagram Contracts

1. **How it works:** owner client sends an authenticated MCP request through
   credential-free ingress and stateless API to runner policy; runner starts or
   manages the non-root, TTL-bound executor. The request path must not show an
   API-to-Docker edge or client-to-executor bypass.
2. **Coding workflow:** `workspace_open` creates the opaque workspace identity;
   file, command, shell, session, and task work stays in the executor. Optional
   Git fetch/pull/push branches through sibling transfer helpers while the
   executor is paused. Show token flow only between trusted runner and helper,
   never into the executor or repository checkout.
3. **Architecture:** public edge contains ingress and API; trusted control
   contains runner, state, Docker authority, and optional helper; execution
   contains the non-root workspace. Show executor networking as disabled by
   default and GitHub as reachable only through the helper when that branch is
   illustrated.

## Implementation Steps

1. Inventory labels directly against the two architecture documents; simplify
   without changing authority claims.
2. Choose one consistent node grammar, directional paths, and restrained
   state colors from existing CSS tokens.
3. Specify animation timing and pauses for each path using transform/opacity
   or SVG stroke/dash properties only.

## Success Criteria

An implementation can distinguish request, result, and privileged transfer
paths without relying on prose beneath the diagram.
