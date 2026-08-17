---
title: "Phase 2: Implement static landing"
status: todo
---

# Phase 2: Implement static landing

## Overview

Build the static landing page and its responsive, accessible visual system.

## Requirements

- [x] Create semantic HTML with a memorable MCP-to-executor “operation lane” visual.
- [x] Use design tokens, a two-family font system, responsive layouts, keyboard focus states, and reduced-motion support.
- [x] Link to real repository documentation and preserve the single-owner warning.
- [x] Use absolute GitHub URLs for documentation links because the Pages artifact deploys independently.
- [x] Include a skip link, landmarks, ordered heading hierarchy, keyboard-visible focus, text alternatives, verified contrast, and a static reduced-motion path.
- [x] State that arbitrary repository code runs in an executor, the service is not a hostile multi-tenant sandbox, egress is off by default, and executor Git push is unavailable.

## Implementation Steps

1. Add the static site artifact under `site/` and a minimal Pages configuration.
2. Implement the hero, capability inventory, architecture lane, owner-boundary message, and getting-started call to action.
3. Verify visual composition at desktop and 375px mobile widths, then run manual accessibility checks for keyboard navigation, focus, landmarks, contrast, and reduced motion.

## Todo

- [x] Write page content grounded in current project docs.
- [x] Implement responsive CSS, interactions, focus states, and reduced-motion behavior.
- [x] Run a local static-server smoke test, static HTML validation, and inspect the rendered page.

## Success Criteria

The static surface renders without JavaScript dependencies, is readable at 375px, has no horizontal overflow, supports keyboard and reduced-motion users, and accurately presents the product limitations.
