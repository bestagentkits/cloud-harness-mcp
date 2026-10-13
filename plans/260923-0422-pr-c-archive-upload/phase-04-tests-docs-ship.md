---
phase: 4
title: "Security tests, docs and ship"
status: pending
priority: P1
effort: "3-4h"
dependencies: [3]
---

# Phase 04 — Tests, docs and ship

## Deliverable

The dedicated security tests, the documentation updates, and a shipped PR.

## Steps

1. Security tests that prove each guard fails closed, and that they are enforced on the decompressed
   stream rather than on declared sizes:
   - an entry whose path escapes the extraction root (including `..` segments and an absolute path);
   - an archive with more entries than the cap;
   - an entry larger than the per-entry cap;
   - many entries whose combined decompressed size exceeds the total cap while each entry stays under
     the per-entry cap, which is the zip-bomb case the total cap exists for.
2. A test that a rejected archive creates nothing, so a failure cannot leave a partially created
   library.
3. Documentation, updated together as the repository requires:
   - `docs-site/dashboard/skills.md` — the upload, its caps, and how per-item results read;
   - `docs/design-guidelines.md` — the control and its interaction rules;
   - `docs/security-model.md` if the caps or the traversal guard belong to the documented boundary.
4. `.agents/skills/cloudharness/` only if this changes the public MCP tool surface or its guidance.
   This plan expects it not to, since the surface is an internal API-to-runner contract plus a
   dashboard route; confirm by checking the public tool list rather than assuming, then run
   `npm run plugin:sync` and confirm the two skill copies stay byte-identical.
5. Gate: focused suites first, then `npm run verify`, `npm run verify:compose`, and the docs gates
   (`docs:reference`, `docs:check`, `docs:build`).
6. Ship: push, open the PR, verify CI by querying the run rather than `gh pr checks --watch`, squash
   merge, then confirm the deploy run succeeds and the promoted release on the host with
   `release-current` advanced, `readyz` 200, and a healthy runner.

## Acceptance

- Every cap and the traversal guard has a test that fails closed.
- A rejected archive creates no skill.
- The full gate exits 0.
- The deploy is promoted and the host is healthy.
