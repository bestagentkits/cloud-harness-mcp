---
title: "Animated MCP Website"
description: "Expand the static landing page with animated product diagrams and an accurate client connection guide."
status: completed
priority: P1
effort: "1d"
branch: feat/animated-mcp-website
tags: [landing-page, static-site, mcp, accessibility]
created: 2026-08-17
---

# Animated MCP Website

## Overview

Extend the public Cloudflare Pages artifact so a prospective trusted owner can
understand the harness, its safe operating flow, and the supported way to
connect each requested AI client. It first carries the already-reviewed Pages
CI workflow and runbook from the prior delivery into this feature branch; the
feature itself remains static with no runtime configuration, JavaScript,
secrets, or service changes.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Add distinct, visually polished "How it works", "Coding workflow", and "Architecture" sections. | P1 |
| 2 | Add a complete, scannable guide for ChatGPT, Codex, Claude Desktop app, Claude Code, Gemini CLI, Cursor, Google Antigravity, and Grok. | P1 |
| 3 | Preserve the private single-owner and bearer/OAuth security boundaries while remaining responsive and motion-accessible. | P1 |
| 4 | Ensure the merged feature reaches the existing Cloudflare Pages CI deployment path. | P1 |

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Define content and interaction contract](./phase-01-start.md) | Completed |
| 2 | [Build animated information sections](./phase-02-build-animated-information-sections.md) | Completed |
| 3 | [Add client connection guide](./phase-03-add-client-connection-guide.md) | Completed |
| 4 | [Validate static artifact and visual behavior](./phase-04-validate-static-artifact-and-visual-behavior.md) | Completed |

## Success Criteria

- [x] The three requested concepts each have a named section and an animated, readable CSS/SVG-or-HTML diagram that conveys only verified architecture and lifecycle facts.
- [x] All eight requested clients appear in the connection guide with setup, verification, and the correct bearer-token or OAuth-gateway limitation sourced from `README.md`.
- [x] The site remains keyboard usable, responsive at phone and desktop widths, and honors `prefers-reduced-motion` without hiding essential information.
- [x] `npm run pages:check` and `npm run pages:links` pass; browser inspection verifies hierarchy, links, diagram legibility, expanded guide states, and reduced-motion behavior.
- [x] The branch contains the reviewed `.github/workflows/deploy-pages.yml` and `docs/cloudflare-pages.md` changes before this feature is shipped, so a merge to `main` can trigger Pages deployment.

## Scope and design direction

- **Delivery prerequisite:** carry the already-reviewed `.github/workflows/deploy-pages.yml`
  and `docs/cloudflare-pages.md` changes into this branch unchanged in intent;
  inspect their diff and preserve their secret-safe, push-to-`main` behavior.
- **Feature implementation files:** `site/index.html`, `site/styles.css`. Do
  not add a framework, runtime API, generated asset, or token-bearing configuration.
- **Visual system:** extend the existing high-contrast operator-console language:
  ink panels, lime/copper state accents, condensed headings, ruled lanes, and
  explicit labels. Use semantic HTML diagram primitives and CSS keyframes for
  progressive movement (flowing connectors, staged nodes, and bounded pulses),
  never canvas or an opaque animation library.
- **Source authority:** `README.md` owns client setup and auth limitations;
  `docs/mcp-api.md` owns lifecycle/network/Git semantics; `docs/security-model.md`
  owns the single-owner and bearer-token threat model.
- **No doc change:** the README already owns the canonical full connection
  instructions; the landing page will link back to it rather than duplicating
  secrets or claiming unsupported direct integrations.

## Non-goals

- Designing or changing MCP, Docker, runner, authentication, VPS, Cloudflare
  Pages, or CI behavior beyond carrying the previously reviewed Pages CI/runbook
  changes required for delivery.
- Adding OAuth, a gateway, client-specific secrets, or sample real credentials.
- Claiming that ChatGPT web or Claude Desktop directly supports this static-bearer deployment.
- Claiming multi-tenant isolation, default executor egress, persistent workspace files, or executor access to GitHub/deployment credentials.

## Red-team review

- **Auth confusion:** Client cards must make the split explicit: ChatGPT and
  Claude Desktop need an OAuth-capable gateway; Grok web may need OAuth while
  xAI Responses API can pass `authorization`; the remaining local integrations
  must use a local environment variable/header, never a hard-coded token.
- **Animation as inaccessible content:** diagrams retain their complete meaning
  in static labels/order; `prefers-reduced-motion` disables or nearly eliminates
  movement; no auto-advancing carousel, hover-only guidance, or time-critical
  status is introduced.
- **Security marketing drift:** every flow terminates at a TTL-bound executor
  and keeps the owner, ingress/API, runner, transfer helper, and credentials in
  their documented trust boundaries. Copy links readers to the security model.
- **Static deploy regression:** additions remain beneath `site/`, use only
  checked outbound HTTPS links, and must pass the existing artifact/link checks.
- **Undeployable branch:** because this branch starts at `main` before the
  prior Pages-CI work, the website can be correct locally but never deploy.
  Carry the reviewed workflow/runbook first, verify its diff contains no secret
  value, and keep the workflow gated to trusted `main` pushes.

## Whole-plan consistency sweep

- No overlapping unfinished plan owns `site/index.html` or `site/styles.css`;
  `260817-0848-2-cloud-harness-next-steps` is broader but does not block this
  self-contained public-site enhancement. The prior completed Pages-CI delivery
  is a required carry-forward dependency, not a competing implementation plan.
- Every requested tool, visual, motion boundary, static-artifact constraint,
  delivery dependency, and validation gate has an owning phase below. No
  unresolved contradiction.

<!-- slug: animated-mcp-website -->
