---
title: Shipping the animated MCP landing website
date: 2026-08-17
summary: "Pre-merge record for PR #27: animated diagrams, complete onboarding, secure Pages gate, validation, and final fixes."
---

# Shipping the animated MCP landing website

## What happened

- Built the landing-page guide with three semantic animated diagrams for the MCP process, coding workflow, and trust architecture. The diagrams retain meaning without motion and honor reduced-motion preferences.
- Added Getting Started guidance, the complete 52-tool inventory, and connection guidance for eight AI clients while keeping owner credentials out of repository content.
- Carried the Cloudflare Pages CI security gate: deployment is limited to a successful `main` CI result for the exact tested commit, with Cloudflare credentials scoped to the deploy step.
- Added the richer animated diagrams, then completed the final diagram layout cleanup. The responsive canvases now fit mobile layouts and place keyboard focus and arrow/Home/End scrolling on the actual overflow region.
- Merged `origin/main` into the feature branch to reconcile the latest mainline changes. This was a branch update, not a merge of PR #27.

## Validation and review

- Earlier branch gates included `actionlint`. On the merged mainline state, Pages checks, shell syntax, Compose boundaries, `npm run verify`, and `git diff --check` passed; Vitest reported 16 files and 38 tests passed.
- Desktop and 375px mobile checks covered disclosure behavior, keyboard panning, and reduced motion.
- Independent pre-landing review reported zero critical findings and two non-blocking test-coverage gaps.

## Current state

- Pre-merge: PR #27 remains open against `main`.
- Exact local HEAD: `f61c9e4` (`f61c9e4735bac6a2f7db26d6a958b7786127357b`).
- The remote PR head previously passed CI, but this exact local head has not been pushed. Fresh CI must run after push.
- No merge of PR #27 and no Cloudflare Pages deployment are claimed.

## Next steps

1. Push the updated feature branch.
2. Wait for CI on the exact pushed head and resolve any failure.
3. Merge PR #27 only after required checks and approval; then observe the separate `main` deployment workflow.

AgentWiki publish skipped.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
