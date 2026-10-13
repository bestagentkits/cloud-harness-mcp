# Build and validate the mission-control hero

**Status:** Completed

## Context

- [Plan](./plan.md)
- `site/index.html`: semantic hero structure and locked SVG geometry.
- `site/styles.css`: tokens, hero composition, button states, responsive rules,
  keyframes, and reduced-motion behavior.
- `test/site-diagram-geometry.test.ts`: executable oracle for diagram anchors,
  paths, metadata, packet timing, and paint order.

## Requirements

- Keep four hero text elements only: overline, headline, lede, and CTA group.
- Use the existing token scales. Add a token only when the design cannot be
  expressed by an existing spacing, color, easing, or typography token.
- Make the live trace feel integrated into the mission-control stage through
  composition and hairline framing, not decorative effects.
- Use CSS animation only for the CTA arrow nudge and existing SVG packet.
  Content stays visible without animation or JavaScript.

## Files

### Modify

- `site/index.html`: add only the minimal hero hooks needed for composition or
  CTA arrow targeting; do not modify visible copy or SVG internals.
- `site/styles.css`: hero grid, trace presentation, CTA states, breakpoint
  behavior, and reduced-motion overrides.

### Do not modify

- `test/site-diagram-geometry.test.ts`: it remains the unchanged regression
  contract for the repaired paths and paint order.
- Runtime, deployment, documentation, and all non-hero page content.

## Implementation

1. Record the current hero bounds, H1 line count, CTA target sizes, trace bounds,
   and document scroll width at 375, 768, 900, 901, and 1440px.
2. Refactor only the outer hero composition into the 5/7 desktop stage with a
   48px tokenized gap. Let the trace occupy the larger fraction without scaling
   or rewriting its inner SVG coordinate system.
3. Treat the repository corridor as the memorable element: strengthen its
   framing and spatial prominence using existing ink surfaces, line colors,
   lime request, and copper return roles. Keep all corners sharp and use
   hairlines as the sole depth strategy.
4. Tune headline width and fluid type only as needed to keep it within two to
   three lines. Preserve the exact copy and existing font pair.
5. Give each CTA a targeted arrow wrapper. Nudge the arrow on hover/focus,
   preserve the current button lift/press behavior, use token easings, and
   avoid `transition: all`.
6. Keep the hero wire visually static. Preserve the existing packet animation
   as the only continuous focal motion. Disable CTA arrow movement and the
   packet under `prefers-reduced-motion: reduce`.
7. Set the responsive transition from columns to stack from measured fit, then
   verify both sides of the 900px boundary. On the stacked mobile composition,
   use 32px spacing and ensure the figure width is constrained to its container.

## Validation

### Visual and interaction matrix

| Viewport | Verify |
|---|---|
| 1440px | 5/7 proportions, 48px gap, balanced first viewport, one focal element |
| 901px | Last 5/7 layout fits without compression or clipping |
| 900px | Compact tablet columns retain deliberate rhythm and control fit |
| 768px | Headline, CTAs, and trace stay readable and proportional |
| 751px | Last compact two-column layout keeps both CTAs on one row |
| 750px | First stacked layout has deliberate rhythm and no empty seam |
| 375px | H1 at most three lines, 44px targets, 32px stack rhythm, no overflow |

- Inspect hover, `:focus-visible`, and active states for both CTAs with keyboard
  and pointer input.
- Emulate reduced motion: packets and CTA arrow movement stop while all copy,
  paths, labels, and controls remain visible.
- Confirm `document.documentElement.scrollWidth === window.innerWidth` at each
  viewport and inspect browser console errors/warnings.
- Run `npm run pages:check`, `npm run pages:links`, the focused diagram geometry
  test, `git diff --check`, and `npm run verify` using Node 24 or newer.
- Run the frontend-design self-review mechanically: kicker count, banned copy,
  tokenized spacing/color/type values, interaction states, motion safety,
  contrast, 375px composition, squint test, delete test, and context-fit veto.

## Risks and mitigation

- **SVG regression:** outer sizing can look correct while inner paths distort.
  Keep the viewBox and SVG internals untouched; run the geometry test and inspect
  node shapes at every viewport.
- **Tablet compression:** a 5/7 grid can starve the copy before the breakpoint.
  Use measured minimum content widths and test 901px/900px explicitly.
- **Competing motion:** CTA and dashed-wire animation can distract from the
  packet. Keep wire dash static and CTA motion interaction-only.
- **Hero overflow:** a dominant trace can widen the page on mobile. Preserve
  `min-width: 0`, constrain the figure, and measure document width.

## Rollback

Revert the focused hero HTML/CSS commit. No data, dependencies, SVG topology,
runtime behavior, or deployment configuration changes.

## Open questions

- None.
