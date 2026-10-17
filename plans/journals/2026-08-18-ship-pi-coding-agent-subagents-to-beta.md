---
title: Ship Pi coding-agent subagents to beta
date: 2026-08-18
summary: "Six bounded Pi-backed agent MCP tools with durable lifecycle, isolation, budgets, and restart-safe cleanup."
---

# Ship Pi coding-agent subagents to beta

## What happened

Implemented issue #19: six bounded `agent_*` MCP tools backed by a pinned Pi SDK worker and loopback model gateway. Added durable idempotent lifecycle state, parent-child lineage, token/cost/output budgets, strict proxy-tool policy, cancellation, TTL cleanup, restart reconciliation, and Docker isolation.

Local review found and corrected launch ordering, retained-state compaction, compacted status lookup, cleanup independence, and a restart drain ordering test. Docker CI now builds and requires every test image, so missing prerequisites fail rather than skip.

## Decision

Ship this backward-compatible public capability as beta version `0.4.0-beta.1`. Keep API ingress credential-free from Docker authority and keep provider credentials confined to the model gateway.

## Evidence

- `npm run verify`: 25 files, 94 tests passed.
- Required Docker gate: 3 files, 6 tests passed, zero skips.
- Pi E2E gate: 2 files, 3 tests passed, zero skips.
- Compose boundaries, changed Docker image builds, focused lifecycle tests, and local code review passed.

## Next steps

Open the beta PR against `dev`, require exact-head CI and review to pass, merge through GitHub, then watch post-merge target CI to green.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
