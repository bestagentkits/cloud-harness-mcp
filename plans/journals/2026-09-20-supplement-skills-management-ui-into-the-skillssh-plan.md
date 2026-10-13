---
title: Supplement skills management UI into the skills.sh plan
date: 2026-09-20
summary: Update plan 260901-1255 with a unified Dashboard Skills management page; verified 26 plan claims against real code and corrected 6.
---

# Supplement skills management UI into the skills.sh plan

## What happened

Operator asked to supplement the existing plan `plans/260901-1255-skills-sh-and-skillx-compatibility` with a skills management UI in the dashboard. Plan-only update; no product code was written (phases 1-5 are unimplemented, so `/api/v1/skills` and `/api/v1/skill-sets` do not exist yet).

Verified 26 plan claims against the working tree before editing. Six were wrong:

- `GET /api/v1/toolkits` returns only `this.toolkitService.listCatalogPresets()`, not cache state, pinned commit, or skill counts.
- `toolkits_preview` returns only `{ requestFingerprint, toolkitsCount }`, not a real resolution preview.
- `#toolkits-selection-grid` in `apps/api/dashboard/index.html` is a dead placeholder: no dashboard JS reads it, no test covers it.
- `apps/runner/src/state-store.ts` has no durable operations table, so the phase 5 "durable operation status" promise had no owner.
- `mapDashboardData` in `apps/api/src/dashboard-response.ts` drops fields outside an explicit key allowlist while still passing typecheck, so an unmapped new operation silently returns `{}` to the browser.
- Effort drift: phase estimates summed to 48h while `plan.md` said `5d` and `plan.html` said `40h`.

Also confirmed the test conventions this plan depends on: `apps/api/test/dashboard-ui-behavior.test.ts` drives dashboards through a hand-rolled `FakeElement` (no jsdom), `dashboard-ui-contract.test.ts` asserts static strings in `index.html`/`dashboard.css`/the JS, and `apps/api/src/dashboard-assets.ts` serves the shell from an explicit route allowlist that the mount test mirrors.

## Decision

Operator decisions recorded in the plan Validation Log (Session 1, 7 questions):

- Custom (owner-authored) skills execute scripts freely; the controls are execution-time digest verification plus the UID 10001 sandbox, not provenance gating. The proposed per-skill `allowExecution` flag was dropped, and phase 2's "blocking execution without verified source" wording was replaced with structural executable-asset accounting.
- `disabled` and `archived` skills leave resolution; `archived` is refused for new launches while existing workspace snapshots stay valid GC roots through `ON DELETE RESTRICT`. `disabled` entries are surfaced in the launch preview with a reason.
- Bulk `enable`/`disable`/`archive`/`tag` returns per-item results; a locked item returns a conflict with its blockers while the rest still apply.
- `mattpocock/skills` and `obra/superpowers` are operator-provided suggestions, not built-ins: they enter resolution only after being imported into the `owner` tier and never occupy the `built-in` rank, which stays reserved for skills shipped inside the executor image.
- One unified Skills page (Library, Discover, Skill Sets, Registry) replaces the toolkit checkbox grid; the Open Workspace dialog selects Skill Sets only, while MCP/REST callers keep the direct `toolkits` array.

Plan changes: phase 1 gained `skill_sources.state`/`tags`/`generation`, revision provenance columns (`parent_revision_id`, `origin`, `has_executable_assets`), the `skill_import_jobs` table, and the internal operation enum; phase 2 gained executable-asset accounting; phase 3 gained disabled/archived rules and preset-versus-built-in vocabulary; phase 5 grew to 12 skill endpoints, 3 toolkit-registry endpoints, and the response-allowlist requirement; phase 6 was rewritten around the unified management page and the `/skills` shell route; phase 7 gained a management lifecycle suite and documentation targets. Effort reconciled to 54h across all files.

## Next steps

- Execute `/ak:cook plans/260901-1255-skills-sh-and-skillx-compatibility/plan.md` starting at phase 1.
- Already recorded as caveats, not open questions: the plan directory is untracked on `mrgoonie/skills-compatiple`; `ak plan check` fails on this Windows host with `planfile writer: read "...": Incorrect function`, and `ak plan status` errors without detail, while `ak plan validate` and `ak plan list` work.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
