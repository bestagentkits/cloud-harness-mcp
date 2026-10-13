---
title: "Validate Visual And Accessibility Behavior"
status: completed
---

# Validate Visual And Accessibility Behavior

## Requirements

- [x] Verify all diagram labels and paths against `docs/system-architecture.md`
  and `docs/mcp-api.md`.
- [x] Verify diagrams without JavaScript and with reduced motion enabled.
- [x] Verify desktop and 375px rendering has no horizontal page overflow,
  clipped labels, or unreadable paths.

## Validation Steps

1. Run `npm run pages:check` and `npm run pages:links`.
2. Run `git diff --check`, banned-copy checks, and a targeted source scan for
   unsupported credential or executor-network claims.
3. Serve `site/` locally, inspect the three diagrams at desktop and 375px,
   then inspect `prefers-reduced-motion: reduce`.
4. Confirm keyboard navigation bypasses SVG decorations and reaches the
   existing links; inspect accessible names and text alternatives in the
   browser accessibility tree.
5. Run `npm run verify` after the static-site checks and have a reviewer
   compare the animated claims with the architecture sources.

## Success Criteria

The exact branch has passing static and repository checks, and visual QA
demonstrates accurate, responsive, motion-safe diagrams.
