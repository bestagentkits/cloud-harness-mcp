---
phase: 1
title: "Define Content And Interaction Contract"
status: completed
priority: P1
effort: "1h"
dependencies: []
---

# Phase 1: Define Content And Interaction Contract

## Overview

Translate the README and security/API documents into a concise content matrix
before editing the public site. This prevents polished visual treatment from
inventing support or weakening the service's trust boundary.

## Requirements

- Functional: map each requested section and client to its source-of-truth
  claim, action, verification step, and safe fallback/link.
- Functional: carry the already-reviewed Pages CI workflow and Pages runbook
  changes into this branch before feature implementation.
- Non-functional: retain the existing visual vocabulary, semantic landmark
  structure, external-link hygiene, and static-only delivery model.

## Architecture

The landing page is a public explanatory layer. `site/index.html` holds the
meaningful reading order, link targets, expandable instructions, and accessible
diagram labels; `site/styles.css` supplies layout, transitions, keyframes, and
the reduced-motion override. The page does not contact the MCP endpoint.

## Related Code Files

- Modify: `site/index.html`
- Modify: `site/styles.css`
- Carry forward: `.github/workflows/deploy-pages.yml`, `docs/cloudflare-pages.md`
- Read-only authority: `README.md`, `docs/mcp-api.md`, `docs/security-model.md`,
  `docs/cloudflare-pages.md`

## Implementation Steps

1. Bring the reviewed `.github/workflows/deploy-pages.yml` and
   `docs/cloudflare-pages.md` diff into this branch. Confirm it contains no
   credentials, exposes no Pages secret, and deploys only after trusted pushes
   to `main`; do not redesign the CI mechanism.
2. Build a compact source matrix for the three diagrams and all eight clients.
3. Decide a page order that places How it works, Coding workflow, Architecture,
   connection guide, then the existing prominent security boundary.
4. Use inline semantic elements (`ol`, `article`, `details`, `summary`, labels)
   so all diagram and guide information survives CSS and animation being off.
5. Reserve CSS-only motion for non-essential directional emphasis and define a
   shared reduced-motion rule before applying keyframes.

## Success Criteria

- [x] Every public claim can be traced to the stated source files.
- [x] The reviewed Pages CI workflow and runbook are present on this branch
  before static-site code starts, with no changed secret contract.
- [x] The planned information architecture exposes no bearer token or local
  configuration with a literal token value.
- [x] ChatGPT/Claude Desktop/Grok distinctions are explicit rather than buried
  in a generic "connect" CTA.

## Risk Assessment

README client instructions can drift from vendor UIs. Signal: the required
external documentation link changes or fails existing link validation.
Response: link to the canonical README section and vendor source rather than
making unsupported UI promises in the landing page.
