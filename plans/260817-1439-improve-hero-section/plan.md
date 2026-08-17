---
title: Improve hero section
description: Make the landing hero more memorable without changing its copy, diagram topology, or industrial-dark brand system.
status: completed
priority: P1
effort: 3h
branch: codex/fix-diagram-edge-endpoints
tags: [landing-page, hero, responsive-design, accessibility]
created: 2026-08-17
---

# Improve hero section

## Outcome

Turn the current balanced two-column hero into an asymmetric mission-control
stage. The copy remains the entry point, while the existing Owner to Runner to
Workspace trace becomes a larger live repository corridor that makes the
single-owner, bounded-execution promise visible at first glance.

## Design contract

- **Design read:** brand landing page for developer/operators, using a
  retro-futuristic control-room language grounded in the existing industrial
  dark visual system.
- **Seeded direction:** retro-futuristic/terminal blended with the existing
  industrial/utilitarian language; use an asymmetric 5/7 hero, a framed live
  trace, and directional CTA micro-motion.
- **Aesthetic thesis:** control-room precision for trusted operators: tinted
  ink, lime and copper, condensed authority, a 5/7 mission stage, and one live
  repository corridor derived from the product's bounded request path.
- **Escalated dimension:** layout only. Typography, palette, depth, density,
  copy, and motion stay disciplined.

## Constraints

- Preserve Barlow Condensed, Source Sans 3, exact visible hero copy, sharp
  corners, hairline depth, current OKLCH palette, and dependency-free HTML/CSS.
- Preserve every inner hero SVG path, marker, node, metadata attribute, motion
  path, and paint-order relationship. The packet remains the sole focal motion;
  the hero request/result wire dash is static.
- Desktop uses a 5/7 grid and 48px gap. Keep columns near tablet only while
  measured content fits; mobile stacks with 32px rhythm and no page-level or
  hero-level horizontal scrolling.
- CTA interactions include arrow nudge, hover, visible focus, active feedback,
  44px minimum targets, and reduced-motion alternatives.

## Non-goals

- No copy rewrite, new metrics, badges, status furniture, imagery, neon glow,
  decorative grid, glass effect, rounded card system, JavaScript, or dependency.
- No change to downstream sections, MCP behavior, security claims, deployment,
  client guidance, or diagram topology.

## Phase

| # | Phase | Status |
|---|---|---|
| 1 | [Build and validate the mission-control hero](./phase-01-build-and-validate-mission-control-hero.md) | Completed |

## Acceptance criteria

- [x] At 1440px the hero reads as an intentional 5/7 stage with 48px separation,
      an immediate text focal point, and a dominant but subordinate live trace.
- [x] At 901px and 900px the grid shifts from 5/7 to compact tablet columns
      without clipped text, squeezed controls, or an abrupt empty region.
- [x] At 751px and 750px the measured stack breakpoint changes composition
      cleanly; 768px remains a usable two-column stage.
- [x] At 375px the hero stacks at 32px rhythm, keeps the H1 within three lines,
      fits the first viewport, and creates no horizontal scroll.
- [x] CTA states are complete, keyboard-visible, and motion-safe; the packet is
      the only continuous hero motion and disappears under reduced motion.
- [x] All diagram geometry/metadata tests remain unchanged and pass, together
      with Pages checks, link checks, and the repository verification gate.

## Dependencies

- Use the edge-endpoint branch as SVG authority; reconcile newer `origin/main`
  changes and rerun gates before shipping.
