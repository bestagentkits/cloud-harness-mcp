---
title: Fix SVG diagram edge endpoints
date: 2026-08-17
summary: "Re-anchored 16 connectors, corrected SVG marker and packet timing, and added geometry regression coverage."
---

# Fix SVG diagram edge endpoints

## What happened
Mobile screenshots showed connector lines passing through node centers or ending away from the declared node boundary. Source inspection confirmed authored SVG coordinates, marker reference offsets, and packet paint order were the cause; responsive horizontal scrolling only exposed the defects.

## Decision
Keep continuous request/result traces through declared via nodes, but require every source and target endpoint to sit on the declared node side. Move packets behind node groups, align marker `refX` with polygon tips, and keep delayed packets hidden until their motion begins.

## Verification
A focused regression failed on the pre-fix hero route, then passed for 16 arrowed connectors plus the blocked-egress stub. Pages checks, diff check, and full verify passed with 17 files and 40 tests. Browser checks passed at 375px and 390px, including exact Home/End pan, no document overflow, reduced motion, packet timing, and clean console.

## Next steps
Reconcile the three newer `origin/main` commits and rerun gates before any commit, PR, merge, or deployment. AgentWiki publish skipped.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
