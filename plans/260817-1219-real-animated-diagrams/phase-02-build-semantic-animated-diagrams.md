---
title: "Build Semantic Animated Diagrams"
status: completed
---

# Build Semantic Animated Diagrams

## Files

- Modify `site/index.html`.
- Modify `site/styles.css`.
- Do not modify README, contracts, runtime code, or client guidance.

## Requirements

- [x] Replace the three card rails with inline SVGs that contain text labels,
  directional markers, grouped regions, and a brief text fallback or
  accessible name.
- [x] Use SVG groups and paths to make security domains visually explicit.
- [x] Reuse current CSS tokens and the industrial visual language; do not add
  a graphics library or JavaScript animation runtime.
- [x] Preserve all existing anchors, headings, supporting links, and main
  page content.

## Implementation Steps

1. Replace `.signal-flow` with a wide, responsive request-and-result diagram:
   solid request lane moves owner to runner; a separate return lane moves a
   structured result back; executor startup is a bounded terminal branch.
2. Replace `.coding-rail` with a lifecycle diagram that makes Open, Work,
   optional origin-only transfer, and Close visually distinct. Render the
   transfer helper outside the executor boundary and add an explicit
   "credentials never enter executor" annotation.
3. Replace `.architecture-map` with nested trust zones and connectors for
   public ingress/API, runner/state/Docker authority, executor, and optional
   Git helper. Use a blocked or absent executor-to-network route rather than a
   moving line that could imply access.
4. Add component-scoped CSS for SVG typography, node states, directional
   markers, and path animation. Use CSS custom properties for timing and
   easing. Keep diagrams exposed and legible when animation is unavailable.
5. At narrow widths, retain the semantic sequence with a vertical or
   horizontally scrollable SVG viewport, while preserving readable labels and
   avoiding clipped focus targets.

## Motion Rules

- Request and result packets use a finite cycle with a visible pause, not a
  perpetual decorative sweep.
- Git helper movement is isolated to its own branch and never crosses the
  executor trust boundary.
- Motion uses `stroke-dashoffset`, `transform`, and `opacity`; no layout
  properties or `transition: all`.
- `prefers-reduced-motion` removes packet movement and keeps final paths,
  labels, and boundary markers fully visible.

## Success Criteria

The landing page communicates topology and privileges through the diagrams,
while the text remains equivalent for assistive technology and static readers.
