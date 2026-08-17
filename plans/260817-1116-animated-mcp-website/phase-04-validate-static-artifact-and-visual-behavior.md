---
phase: 4
title: "Validate Static Artifact And Visual Behavior"
status: completed
priority: P1
effort: "1h"
dependencies: [2, 3]
---

# Phase 4: Validate Static Artifact And Visual Behavior

## Overview

Verify that the public artifact is safe to upload, externally linked, readable
in a browser, and faithful to the accessibility/motion contract before it is
handed to the existing Pages CI deployment workflow.

## Requirements

- Functional: run the repository Pages artifact and outbound-link checks.
- Functional: confirm the carried Pages workflow and runbook are present so
  the reviewed artifact has a post-merge deployment route.
- Non-functional: visually inspect desktop/mobile layouts and a reduced-motion
  rendering; do not publish or call deploy during this feature implementation.

## Architecture

Existing scripts own artifact safety (`scripts/verify-pages-artifact.mjs`) and
outbound HTTPS link validation (`scripts/verify-pages-links.mjs`). Browser
inspection is a separate quality gate because static parsing cannot prove
diagram legibility, responsive stacking, or motion reduction.

## Related Code Files

- Read-only verification owners: `scripts/verify-pages-artifact.mjs`,
  `scripts/verify-pages-links.mjs`, `docs/cloudflare-pages.md`, `package.json`
- Carry-forward delivery files: `.github/workflows/deploy-pages.yml`,
  `docs/cloudflare-pages.md`
- Modify only if a failure exposes a page defect: `site/index.html`,
  `site/styles.css`

## Implementation Steps

1. Confirm the carried `.github/workflows/deploy-pages.yml` deploys the static
   `site/` artifact only for trusted pushes to `main` and consumes only GitHub
   secrets by name; confirm the runbook documents that behavior.
2. Run `npm run pages:check` to confirm no forbidden credential marker,
   environment file, oversize asset, or unintended artifact entered `site/`.
3. Run `npm run pages:links` and fix only site-owned bad URLs/anchors.
4. Serve `site/` with a tracked local static server or Pages preview, inspect
   at desktop and narrow mobile widths, then stop the server when done.
5. Inspect keyboard path (skip link, navigation, disclosures, visible focus),
   heading/landmark order, external links, and each diagram's static reading
   order.
6. Emulate `prefers-reduced-motion: reduce`; confirm all animated cues stop or
   minimize while all labels/connections remain clear.
7. Re-run checks after any correction and record that deployment is left to the
   `deploy-pages.yml` workflow after merge to `main`.

## Todo

- [x] `npm run pages:check` passes.
- [x] `npm run pages:links` passes.
- [x] Browser validation passes for desktop, mobile, keyboard, and
  reduced-motion modes with no clipped diagram or hidden guide content.
- [x] The prior Pages CI/runbook changes are on the branch and can deploy the
  merged static artifact without exposing a value in source.
- [x] No deployment or secrets are added as part of verification.

## Risk Assessment

External vendor pages may be transiently unavailable. Signal: link validation
fails with a network/HTTP response for a documented vendor URL. Response:
distinguish an external availability failure from a broken local link, retry
once, then report the external blocker rather than weakening the checker.
