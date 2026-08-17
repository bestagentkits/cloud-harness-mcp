---
title: "Real Animated MCP Diagrams"
description: "Replace landing-page card rails with factual animated SVG diagrams for the request, coding, and trust-boundary flows."
status: completed
priority: P1
effort: "4h"
branch: feat/animated-mcp-website
linked_pr: 27
tags: [landing-page, animation, diagrams, security]
created: 2026-08-17
---

# Real Animated MCP Diagrams

## Outcome

Turn the three explanatory landing-page sections into animated, semantic SVG
diagrams. Each diagram must make a real MCP boundary easier to understand,
not decorate the page with generic moving connectors.

## Constraints

- Keep existing Getting Started, tools, and client guidance unchanged.
- Preserve source-owned behavior in `docs/mcp-api.md` and
  `docs/system-architecture.md`.
- Never imply executor network access, Docker access, or credential access.
- Keep the static page dependency-free and usable without JavaScript.

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Map diagram facts and motion](./phase-01-map-diagram-facts-and-motion.md) | Completed |
| 2 | [Build semantic animated diagrams](./phase-02-build-semantic-animated-diagrams.md) | Completed |
| 3 | [Validate visual and accessibility behavior](./phase-03-validate-visual-and-accessibility-behavior.md) | Completed |

## Acceptance Criteria

- [x] How it works renders an observable request path from owner through ingress/API and runner into a bounded executor.
- [x] Coding workflow distinguishes local executor work from runner-mediated, credential-isolated remote Git transfer.
- [x] Architecture renders public edge, trusted control, execution, and the Git helper boundary without inventing authority.
- [x] SVGs remain readable at 375px, expose text equivalents, respect reduced motion, and pass Pages checks.

<!-- slug: real-animated-diagrams -->
