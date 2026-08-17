---
title: Fix diagram edge endpoints
status: completed
priority: P1
effort: medium
branch: codex/fix-diagram-edge-endpoints
tags: [website, svg, diagrams, accessibility]
created: 2026-08-17
---

# Fix diagram edge endpoints

Status: completed

## Outcome

Every visible diagram connector starts and ends on the declared node side,
keeps its animated packet on the same route, and remains correct while the
mobile canvas is horizontally panned.

## Constraints

- Preserve the existing industrial-dark design, copy, animation rhythm,
  security boundaries, keyboard pan, and reduced-motion behavior.
- Keep continuous request/result traces when intermediate nodes are declared
  as `via` hops and occlude both the line and packet.
- Do not change MCP behavior, deployment, client guidance, or page structure.

## Topology contract

| Diagram | Connector | Source | Via | Target |
|---|---|---|---|---|
| Hero | request | OWNER right | RUNNER | WORKSPACE left |
| Hero | result | WORKSPACE bottom | RUNNER | OWNER bottom |
| Process | request | OWNER right | INGRESS, API | RUNNER left |
| Process | execute | RUNNER top | none | EXECUTOR left |
| Process | result | EXECUTOR bottom | RUNNER, API, INGRESS | OWNER bottom |
| Workflow | open | OPEN right | none | WORK left |
| Workflow | work loop | WORK bottom at 75% | none | WORK bottom at 25% |
| Workflow | transfer | WORK right | HELPER | ORIGIN top |
| Workflow | transfer result | ORIGIN bottom | HELPER | WORK bottom |
| Workflow | close | WORK left | none | CLOSE right |
| Architecture | request | OWNER right | INGRESS, API, RUNNER | EXECUTOR left |
| Architecture | result | EXECUTOR bottom | RUNNER, API, INGRESS | OWNER bottom |
| Architecture | state | RUNNER bottom | none | STATE top |
| Architecture | Docker | RUNNER bottom | none | DOCKER top |
| Architecture | Git helper | RUNNER bottom | none | GIT HELPER top |
| Architecture | GitHub | GIT HELPER bottom | none | GITHUB left |
| Architecture | blocked egress | EXECUTOR right | none | blocked cross |

## Implementation

1. Add stable node and edge metadata to the existing inline SVGs. Keep the
   locked topology as a separate hard-coded test oracle.
2. Re-anchor and route the 16 arrowed connectors plus the blocked-egress stub.
3. Align marker reference points with their polygon tips.
4. Paint animated packets after paths and before nodes; keep motion paths equal
   to their visible connector paths.
5. Add a focused Vitest geometry regression that covers boundary anchors,
   references, declared via-node crossings, undeclared crossings, marker tips,
   paint order, and motion-path equality. Map packets explicitly to edges and
   model blocked egress as a source-only stub.

## Verification

- [x] New regression failed against pre-fix markup, then passed after repair.
- [x] Browser audit at 375x812 and 390px, all canvas start/end pan positions.
- [x] Normal and reduced-motion runtime checks, packet timing, console check.
- [x] `npm run pages:check`, `npm run pages:links`, `git diff --check`, and
  `npm run verify` (17 test files, 43 tests) on the reconciled release head.

## Completion evidence

- 16 arrowed connectors attach to declared source and target boundaries.
- Blocked egress remains a source-only stub from the executor's right edge.
- 11 animated packets follow their visible routes and paint behind nodes.
- Delayed packets stay hidden until their motion begins; no SVG-origin flash.
- Mobile canvases pan from 0 to exact maximum at 375px and 390px without
  document overflow; reduced motion hides packets and SMIL animation.
- Evergreen docs impact: none; topology and public product behavior unchanged.
- Shipping note: reconciled with `origin/main` at `73d0d65`; the same gates
  passed on the merged state before commit.

## Risks and rollback

- Cubic self-loop intersection checks are limited to the commands used here;
  sample the curve rather than implementing a general SVG parser.
- Marker and packet paint-order mistakes can look correct in static source;
  browser verification is authoritative.
- Rollback is the single focused commit; no runtime data or configuration is
  changed.
