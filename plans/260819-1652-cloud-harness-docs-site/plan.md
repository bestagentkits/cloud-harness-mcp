---
title: "Cloud Harness docs site"
description: "Public VitePress documentation site at docs.harness.agentkit.best, self-hosted on Cloudflare Pages, brand-matched to the marketing site, with reference pages generated from source."
status: pending
priority: P1
effort: "2-3d"
tags: [docs, cloudflare-pages, vitepress]
created: 2026-08-19
---

# Cloud Harness docs site

## Overview

Build a public documentation site served at **`docs.harness.agentkit.best`** using
**VitePress**, deployed on **Cloudflare Pages** through the same CI-gated flow the
marketing site uses (`deploy-pages.yml`). Content is authored in Markdown, themed to
match the existing marketing site (`site/styles.css`, OKLCH, no gradients, native
fonts). The **Tools reference** and **Environment variables** pages are **generated
from their source of truth** (`@cloud-harness/contracts` `TOOL_SPECS`;
`.env.example` + `config.ts`) so they cannot drift.

This is a new, isolated surface. It does not modify the marketing `site/`, the MCP
service, the dashboard, the runner, or the internal `docs/*.md` contributor docs
(those remain the WHY/WHERE authority; the public site *derives* from them for a
different audience).

Locked in brainstorm: `plans/` has no overlapping/blocking plan (prior landing-page,
getting-started, and dashboard plans are shipped and independent).

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Public docs at `docs.harness.agentkit.best` covering the full requested section set + accepted additions | P1 |
| 2 | Brand-consistent with the marketing site (OKLCH tokens, dark/light, responsive, reduced-motion) | P1 |
| 3 | Tools reference + Env vars generated from source, with a drift-failing check | P1 |
| 4 | CI-gated Cloudflare Pages deploy mirroring the existing pattern; no secrets in artifact | P1 |
| 5 | AI-crawler Markdown: every page also served as `text/markdown` at its `.md` URL, plus `llms.txt`/`llms-full.txt` | P1 |
| 6 | Isolated from the API/runner build graph; `npm run verify` stays green | P2 |

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Phase 1: Scaffold VitePress workspace](./phase-01-start.md) | Pending |
| 2 | [Phase 2: Brand theme layer](./phase-02-brand-theme-layer.md) | Pending |
| 3 | [Phase 3: Authored content](./phase-03-authored-content.md) | Pending |
| 4 | [Phase 4: Generated reference + AI-crawler markdown](./phase-04-generated-reference-pages.md) | Pending |
| 5 | [Phase 5: Deploy and verify](./phase-05-deploy-and-verify.md) | Pending |

Dependency order: 1 → (2, 3, 4 in parallel) → 5.

## Constraints (from AGENTS.md + brainstorm)

- **Drift resistance:** never hand-copy the tool inventory or env vars; generate from
  the machine owner and fail the build on drift.
- **No secrets** anywhere in the docs artifact; extend the `pages:*` verifier pattern.
- **Public, read-only:** no auth, no runtime config, no MCP/runner/GitHub-App credentials.
- **Self-hosted on Cloudflare Pages**, separate project (`cloud-harness-docs`); a
  Pages custom domain maps to a project root, so the subdomain needs its own project.
- **Isolation:** `docs-site/` is its own workspace; root `build`/`typecheck` (explicit
  `-w @cloud-harness/*`) never build docs; keep `verify` green.

## Success Criteria

- [ ] `docs.harness.agentkit.best` serves every requested section + accepted additions with working nav, local search, and syntax-highlighted code.
- [ ] Merge to `main` → CI builds docs (dead-link + drift checks) → Pages deploy publishes it; artifact/link/smoke checks pass.
- [ ] Adding a new tool or env var and rebuilding updates the reference page with zero hand edits; a stale hand-edit fails the drift check.
- [ ] Fetching any page URL with a `.md` suffix returns clean Markdown as `text/markdown`; `llms.txt`/`llms-full.txt` are served at the site root.
- [ ] Light/dark and 375px verified in a browser; brand matches the marketing site.
- [ ] `npm run verify` remains green; docs build is not coupled into the API/runner graph.

## Owner action (live-op, not code)

Create the `cloud-harness-docs` Cloudflare Pages project and bind
`docs.harness.agentkit.best` as its custom domain (reuse existing
`CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` Actions secrets). Flagged in Phase 5.

## Open questions

- None blocking. Defaults chosen: VitePress built-in local search (no Algolia);
  one connect page per AI client mirroring the README matrix.

<!-- slug: cloud-harness-docs-site -->
