---
phase: 2
title: "Build Animated Information Sections"
status: completed
priority: P1
effort: "3h"
dependencies: [1]
---

# Phase 2: Build Animated Information Sections

## Overview

Add the requested three named sections as visual, scannable explanations of
the harness. The diagrams enhance—not replace—the documented security model.

## Requirements

- Functional: add distinct "How it works", "Coding workflow", and
  "Architecture" anchors, narrative copy, diagrams, and meaningful source links.
- Non-functional: CSS animations are progressive, performant, and disabled for
  reduced-motion users; layout works without horizontal overflow on mobile.

## Architecture

1. **How it works**: an owner request flows through authenticated MCP, the
   runner's policy/lifecycle, and an isolated TTL-bound executor.
2. **Coding workflow**: a finite, labelled sequence—open with a credential-free
   HTTPS URL and idempotency key; inspect/edit/test; optionally use constrained
   origin-only Git transfer; close/TTL-clean up.
3. **Architecture**: a trust-boundary map separating ingress/API, runner with
   Docker authority, executor, and optional ephemeral Git helper; it never
   depicts the executor holding an owner or GitHub App credential.

Use CSS custom properties/keyframes for a restrained connector sweep, staged
node activation, and/or boundary pulse. Represent every state in DOM text and
static color/shape before motion runs.

## Related Code Files

- Modify: `site/index.html`
- Modify: `site/styles.css`
- Read-only authority: `docs/mcp-api.md`, `docs/security-model.md`

## Implementation Steps

1. Replace/expand the current single operation lane with three separately
   navigable sections while preserving the hero, boundary warning, footer, and
   skip-link path.
2. Add semantic diagram markup using ordered steps, labelled groups, and
   decorative elements marked `aria-hidden` only when adjacent text already
   conveys their meaning.
3. Extend CSS with responsive grids/scroll-safe fallbacks and visible focus
   states for any new links or disclosure controls.
4. Apply modest compositor-friendly transform/opacity animations with staggered
   delays only; avoid continuous expensive paint/layout properties.
5. Extend the existing `prefers-reduced-motion` block so animated connectors,
   pulses, and state changes become static without obscuring data.

## Todo

- [x] How it works, Coding workflow, and Architecture are independently
  navigable and readable at desktop and phone widths.
- [x] Diagrams correctly state default no-network execution, bounded lifecycle,
  credential-free repository URLs, and optional controlled Git transfer.
- [x] Motion is decorative/progressive and a reduced-motion view is complete.

## Risk Assessment

The main risk is a diagram that looks authoritative while omitting the
single-owner limitation. Signal: a reviewer could infer shared-tenancy or
executor-held credentials from it. Response: retain the existing boundary
section directly after the visual story and link architecture labels to the
security model/MCP semantics.
