---
title: Repairing landing-diagram connectors and strengthening the hero
date: 2026-08-17
summary: "Recorded the connector repair and mission-control hero work prepared for issue #30; this journal is history, not evergreen authority."
---

# Repairing landing-diagram connectors and strengthening the hero

## Scope

Issue #30 tracks the landing-site repair: connect SVG diagram edges to their intended endpoints and strengthen the hero without changing the harness security or public MCP contracts.

## Chronology

- Reproduced the mobile diagram defects: connector endpoints and labels could appear detached after viewport scaling and horizontal panning.
- Repaired the static SVG edge geometry and added `test/site-diagram-geometry.test.ts` to lock the path endpoints, metadata, and paint order against regressions.
- Built the mission-control hero treatment around the existing Owner -> Runner -> Workspace topology: asymmetric composition, static boundary wires, a single moving packet, clearer CTA affordances, and restrained copper/lime framing.
- Tuned the layout at desktop, tablet, and narrow mobile breakpoints. Added reduced-motion behavior so the packet motion stops while the diagram remains legible.
- Corrected the mobile header collision with the wordmark; narrow navigation now preserves readable header and hero content.
- Fast-forwarded this worktree to `origin/main` at `73d0d65` (`v0.5.0`) before shipping preparation. Resolved one CSS conflict manually, retaining the incoming policy styles and the local landing-site changes.

## Evidence at dispatch

- Related issue: [#30](https://github.com/bestagentkits/cloud-harness-mcp/issues/30).
- Earlier focused geometry and Pages checks passed; the final branch test/review run is owned by the active ship pipeline and was pending when this entry was written.

## Decision record

The geometry test protects the diagram's authored routes rather than making the visualization responsive through JavaScript. The hero keeps the established dark, condensed control-room visual language and uses motion only to explain request flow.

## Follow-up

The ship pipeline will commit, push, create the PR, and wait for exact-head CI before any merge or deployment claim.

## Authority note

This is a chronological work record only. Current repository code, tests, issue state, PR checks, and the documents under `docs/` remain authoritative.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
