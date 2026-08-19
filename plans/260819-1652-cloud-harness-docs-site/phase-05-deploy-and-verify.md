---
title: "Phase 5: Deploy and verify"
status: todo
phase: 5
priority: P1
effort: "5h"
dependencies: [2, 3, 4]
---

# Phase 5: Deploy and verify

## Overview

Deploy the built docs to a new Cloudflare Pages project on merge to `main`, mirroring
the existing marketing-site flow, with artifact/link/smoke verification and a CI job
that builds docs (dead links + reference drift) so a broken build blocks deploy.

## Requirements

- Functional: merge to `main` → CI builds docs → Pages deploy publishes to
  `docs.harness.agentkit.best`.
- Non-functional: no secrets in the artifact; PRs do not receive Cloudflare
  credentials; deploys of docs and marketing site do not interfere.

## Architecture

### CI (gate before deploy)

- Add a `docs` job (or step) to `.github/workflows/ci.yml`:
  `npm run docs:reference && npm run docs:check && npm run docs:build`.
  `docs:check` catches reference drift; `docs:build` catches dead internal links.

### Deploy workflow (mirror `deploy-pages.yml`)

- New `.github/workflows/deploy-docs-pages.yml`, `workflow_run` after `CI` success on
  `main`, checkout the tested SHA, `npm ci`, then `npm run docs:deploy`.
- Separate `concurrency` group from the marketing pages deploy.
- Reuse existing `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` Actions secrets.

### Scripts (root `package.json`)

- `"docs:artifact": "node scripts/verify-docs-artifact.mjs"` — scan
  `docs-site/.vitepress/dist` for env files, credential markers, and oversized files
  (mirror `scripts/verify-pages-artifact.mjs`).
- `"docs:links": "node scripts/verify-docs-links.mjs"` — external-link HEAD check over
  built dist (mirror `scripts/verify-pages-links.mjs`, but walk all dist HTML).
- `"docs:smoke": "node scripts/verify-docs-url.mjs"` — verify
  `https://docs.harness.agentkit.best` after upload (mirror `verify-pages-url.mjs`),
  AND fetch a sample `<page>.md` twin asserting `200` + `Content-Type: text/markdown`,
  plus `llms.txt` at the root.
- `"docs:deploy": "npm run docs:reference && npm run docs:build && npm run docs:artifact && npm run docs:links && wrangler pages deploy docs-site/.vitepress/dist --project-name cloud-harness-docs --branch main && npm run docs:smoke"`.

### Owner live-op (flagged — not code, requires authorization)

- Create the `cloud-harness-docs` Pages project
  (`wrangler pages project create cloud-harness-docs --production-branch main`) and bind
  the `docs.harness.agentkit.best` custom domain in the Cloudflare dashboard. Until the
  project + domain exist, the deploy step cannot succeed.

## Related Code Files

- Create: `.github/workflows/deploy-docs-pages.yml`
- Create: `scripts/verify-docs-artifact.mjs`, `scripts/verify-docs-links.mjs`, `scripts/verify-docs-url.mjs`
- Modify: `.github/workflows/ci.yml` (add docs build/check job/step),
  root `package.json` (`docs:artifact`, `docs:links`, `docs:smoke`, `docs:deploy`)
- Reference (patterns to mirror): `scripts/verify-pages-*.mjs`,
  `.github/workflows/deploy-pages.yml`, `docs/cloudflare-pages.md`

## Implementation Steps

1. Add the three `verify-docs-*.mjs` scripts mirroring the `verify-pages-*` ones.
2. Add `docs:artifact`/`docs:links`/`docs:smoke`/`docs:deploy` root scripts.
3. Add the `docs` CI job/step (reference + check + build) to `ci.yml`.
4. Add `deploy-docs-pages.yml` (workflow_run after CI on main; separate concurrency).
5. Extend `docs/cloudflare-pages.md` (or add a short docs section) documenting the docs
   project, domain, and deploy/rollback — mirroring the existing Pages runbook.
6. Owner: create the Pages project + custom domain; then verify a live deploy.

## Success Criteria

- [x] CI `docs` job fails on reference drift or a dead internal link.
- [x] Merge to `main` deploys the docs to Pages; `docs:smoke` confirms the live URL.
- [x] Live `<page>.md` twin returns `200` + `Content-Type: text/markdown`; `llms.txt` reachable at root.
- [x] `docs:artifact` blocks any secret/oversized file from upload.
- [x] Marketing-site deploy still works; the two projects/domains are independent.
- [x] Rollback path documented (Cloudflare dashboard, per existing runbook).

## Risk Assessment

- **Risk:** the Pages project / custom domain does not exist yet. *Signal:* deploy step
  errors "project not found" or domain 404. *Response:* this is the flagged owner
  live-op; do not auto-create from a code task — block on owner action, then verify.
- **Risk:** `workflow_run` fan-out races the marketing deploy. *Signal:* one deploy
  cancels/supersedes the other. *Response:* distinct `concurrency.group` per workflow
  (planned); they target different projects.
- **Risk:** external-link check flakes on rate-limited hosts. *Signal:* intermittent
  non-200 from third-party links. *Response:* mirror the existing script's HEAD→GET
  fallback; treat 429/405 leniently as the marketing checker does.
- **Risk:** docs CI step slows the pipeline. *Signal:* CI runtime jumps. *Response:*
  docs job runs in parallel with existing jobs; cache npm; it only builds static docs.
