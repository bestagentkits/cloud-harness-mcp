---
title: "Phase 2: Brand theme layer"
status: todo
phase: 2
priority: P1
effort: "4h"
dependencies: [1]
---

# Phase 2: Brand theme layer

## Overview

Make the docs visually continuous with the marketing site by overriding VitePress
theme CSS variables with the marketing OKLCH palette, type scale, and shape/motion
rules, honoring the same hard constraints as the dashboard design system.

## Requirements

- Functional: docs adopt the marketing brand in both light and dark, with a working
  theme toggle (VitePress default appearance switch).
- Non-functional: WCAG AA contrast; reduced-motion off-ramp; readable at 375px; no
  gradients; native font stack (no web fonts).

## Architecture

- Custom theme entry `docs-site/.vitepress/theme/index.ts` extending
  `vitepress/theme` (default) + `./custom.css`.
- `custom.css` maps VitePress design tokens to the marketing brand:
  - Source the palette/type from `site/styles.css` (OKLCH neutral ramp + safety-amber
    accent; semantic hues separated) and `docs/design-guidelines.md` (voice,
    uppercase+letter-spacing headers, monospace for data, radius/motion rules).
  - Override `--vp-c-brand-*`, `--vp-c-bg*`, `--vp-c-text-*`, `--vp-c-border`,
    code-block and search tokens for both `:root` and `.dark`.
  - No gradients; hairline borders; restrained accent (<~10% of surface).
  - `@media (prefers-reduced-motion: reduce)` disables non-essential transitions.
- Keep the palette values DRY: reference the marketing tokens rather than inventing a
  third palette. (VitePress can't import `site/styles.css` at build for tokens, so copy
  the *token values* into `custom.css` with a comment pointing to `site/styles.css` as
  the owner; this is design tokens, not behavior, so a pointer + copied values is
  acceptable and low-drift.)

## Related Code Files

- Create: `docs-site/.vitepress/theme/index.ts`
- Create: `docs-site/.vitepress/theme/custom.css`
- Reference (read-only owners): `site/styles.css`, `docs/design-guidelines.md`

## Implementation Steps

1. Add the custom theme entry importing the default theme + `custom.css`.
2. Extract the marketing OKLCH tokens/type scale; map them onto VitePress variables for `:root` and `.dark`.
3. Style headers (uppercase+letter-spacing), data/code (monospace, tabular-nums), links (ink + amber underline), buttons (amber fill), and the local-search box.
4. Add reduced-motion handling and verify 375px layout.

## Success Criteria

- [x] Home + a sample content page match the marketing look in light and dark.
- [x] Contrast passes AA for body, muted, links, and buttons in both themes.
- [x] No gradients; no web-font requests; reduced-motion respected.
- [x] 375px renders without horizontal scroll.

## Risk Assessment

- **Risk:** VitePress default theme markup limits how close the brand match gets.
  *Signal:* key surfaces (nav, sidebar, search) resist token overrides. *Response:*
  target those components' documented CSS vars/slots; accept "same language, not
  pixel-identical" — the acceptance bar is brand consistency, not a clone.
- **Risk:** token values drift from `site/styles.css` over time. *Signal:* marketing
  palette changes and docs look off. *Response:* the copied block cites `site/styles.css`
  as owner; a future palette change updates both. Optionally add a tiny build step that
  reads tokens from `site/styles.css` if drift becomes real (deferred; YAGNI now).
