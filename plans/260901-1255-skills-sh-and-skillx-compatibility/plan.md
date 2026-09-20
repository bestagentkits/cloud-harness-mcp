---
title: "skills-sh-and-skillx-compatibility"
description: "Implementation plan for CloudHarness MCP compatibility with skills.sh and skillx.sh, including offline CLI launchers, 4-tier resolution, CAS caching, and a unified Dashboard Skills management page"
status: pending
priority: P1
effort: "135h"
branch: mrgoonie/skills-compatiple
tags: ["skills", "skillx", "toolkits", "dashboard", "frontend", "air-gap", "security"]
created: 2026-09-01
---

# skills-sh-and-skillx-compatibility

## Overview

Deliver comprehensive compatibility with https://skills.sh/ and https://skillx.sh/ in CloudHarness MCP. This enables owners to discover, author, import, version, and organize skills into Skill Sets on the Dashboard, launch workspaces with multi-set combinations, and execute familiar `skills` and `skillx` CLI commands inside air-gapped (`networkMode: 'none'`) executors without violating single-owner isolation, 4-tier precedence, or digest pinning guarantees. Phases 8 and 9 add a TypeSafe/Jev suggestion that names at most one relevant skill per user prompt.

**Effort unit:** the hours below are execution time for an AI coding agent working with this repository's tooling, not human man-hours. A human developer would need substantially longer, so do not read them as staffing estimates. After phase 1 completes, re-estimate the remaining phases against the real time phase 1 took.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Extend contracts and SQLite schema with composite owner/source foreign keys, immutable revisions, and workspace locks | P1 |
| 2 | Build runner adapters for skills.sh (Git commit pinning) and SkillX (instructions snapshotting and verified bundles) with CAS caching | P1 |
| 3 | Implement deterministic 4-tier precedence (`built-in > owner > workspace > repository`), same-tier collision detection, and minimal projection | P1 |
| 4 | Build TOCTOU-safe execution container snapshots and in-executor CLI compatibility layer (`skills`, `skillx`, narrow `npx` dispatcher) | P1 |
| 5 | Implement authenticated control-plane REST API for Skill CRUD, federated search, and generation-fenced Skill Sets | P1 |
| 6 | Deliver one unified Dashboard Skills page (Library, Discover, Skill Sets, Registry) with custom-skill editing, import job progress, revision history with diff/restore/fork, usage and lock visibility, bulk operations, and multi-set Open Workspace selection with live collision preview | P1 |
| 7 | Validate end-to-end air-gapped execution, adversarial security suites, and sync documentation across `docs/`, `docs-site/`, and agent skills | P1 |
| 8 | Suggest at most one relevant skill per user prompt with TypeSafe's Jev model over the workspace's resolved roster, with redaction, caching, and fail-open degradation | P1 |

## Phases

| # | Phase | Status | Priority | Effort | Dependencies |
|---|-------|--------|----------|--------|--------------|
| 1 | [Contracts, Schemas & SQLite Database Migrations (TDD)](./phase-01-contracts-and-sqlite-schema.md) | Pending | P1 | 9h | [] |
| 2 | [Runner Adapters, Normalization & Content-Addressed Storage (TDD)](./phase-02-runner-adapters-and-cas-normalization.md) | Pending | P1 | 14h | [1] |
| 3 | [4-Tier Resolution, Precedence, Conflict Engine & Projection (TDD)](./phase-03-resolution-precedence-and-projection.md) | Pending | P1 | 8h | [1, 2] |
| 4 | [TOCTOU-Safe Helper Execution & Executor CLI Compatibility Layer (TDD)](./phase-04-toctou-execution-and-cli-layer.md) | Pending | P1 | 16h | [2, 3] |
| 5 | [Control-Plane REST API & Internal Runner Operations (TDD)](./phase-05-control-plane-rest-api.md) | Pending | P1 | 16h | [1, 3] |
| 6 | [Dashboard Skills Management UI & Workspace Launch Integration (TDD/E2E)](./phase-06-dashboard-ui-and-workspace-launch.md) | Pending | P1 | 30h | [5] |
| 7 | [End-to-End Verification, Security Adversarial Suite & Docs Sync](./phase-07-e2e-verification-and-docs-sync.md) | Pending | P1 | 10h | [4, 6] |
| 8 | [TypeSafe/Jev Skill Suggestion Engine (TDD)](./phase-08-typesafe-skill-suggestion-engine.md) | Pending | P1 | 14h | [5] |
| 9 | [Prompt-Submit Surfaces, Dashboard Configuration & Live Verification (TDD/E2E)](./phase-09-prompt-submit-surfaces-and-verification.md) | Pending | P1 | 18h | [6, 8] |

## Success Criteria

- [ ] All database migrations pass with strict foreign keys enabled (`PRAGMA foreign_keys = ON;`), preventing cross-owner and same-owner cross-source revision references.
- [ ] In `networkMode: 'none'` workspaces, `skills add`, `npx skills add`, `skillx use`, and `npx skillx-sh use` execute 100% offline from local projection without DNS or network attempts.
- [ ] Uncached CLI invocations in air-gapped workspaces fail closed with `CACHE_MISS` and explicit import guidance instead of opening background network channels.
- [ ] 4-tier precedence (`built-in > owner > workspace > repository`) resolves deterministically; same-tier collisions block launch unless explicitly resolved by `skillOverrides[name]`.
- [ ] `skills_run` executes verified scripts from an immutable root-owned snapshot in a helper container as UID 10001, eliminating TOCTOU script swapping.
- [ ] Dashboard exposes one unified Skills page that covers the full lifecycle: library browse and filters, custom-instruction editing that creates new revisions, import with durable job progress, revision diff/restore/fork, usage and lock visibility, and per-item bulk results for locked skills.
- [ ] The Registry tab shows cache state, pinned commit, skill count, and lock state for every toolkit, and renders presets and remote catalogue entries as installable suggestions rather than as already-available skills.
- [ ] Dashboard supports federated search across Local + skills.sh + SkillX, Skill Set grouping with generation CAS, and multi-set selection at workspace launch.
- [ ] Submitting a prompt injects a `<skill_relevance>` block naming at most one skill from the workspace's resolved roster, or the explicit no-match sentence, and never blocks the turn when TypeSafe is unavailable.
- [ ] The TypeSafe key is configured only from the dashboard, stays encrypted at rest and control-plane only, and prompt content is redacted and bounded before it leaves to `api.typesafe.ai`.
- [ ] All unit, integration, contract, and e2e suites pass (`npm run verify`).

## Validation Log

### Verification Results
- Claims checked: 26 across 7 phases
- Verified: 19 | Failed: 6 | Unverified: 1
- Tier: Full (7 phases)
- Roles exercised: Fact Checker, Contract Verifier (read/grep against the working tree)
- Failures found and corrected:
  - `GET /api/v1/toolkits` returns only `listCatalogPresets()`, so the Registry tab could not show cache state or pinned commits — phase 5 now states the enrichment explicitly (`apps/runner/src/workspace-service.ts`, `executeInternal`).
  - `toolkits_preview` returns only `requestFingerprint` and `toolkitsCount`, not a real resolution preview — the launch preview is therefore bound to `POST /api/v1/skill-sets/preview` in phase 6.
  - `#toolkits-selection-grid` in `apps/api/dashboard/index.html` is a dead placeholder: no dashboard JS reads it and no test covers it — phase 6 removes it instead of extending it.
  - No durable operations table exists in `apps/runner/src/state-store.ts`, so the phase 5 promise of "durable operation status" had no owner — phase 1 adds `skill_import_jobs`.
  - `mapDashboardData` in `apps/api/src/dashboard-response.ts` drops fields outside an explicit key allowlist while still typechecking — phase 5 now requires an enum entry, a mapping branch, and a mapper test per new operation.
  - Effort drift: phase estimates summed to 48h while `plan.md` said `5d` and `plan.html` said `40h` — reconciled to 62h in that round, then to 84h after phases 8 and 9 were added.
- Unverified: whether Playwright-free `FakeElement` tests can exercise drag-and-drop member ordering — phase 6 specifies keyboard up/down buttons as the tested path and leaves pointer dragging as a progressive enhancement.
- Tooling limitation (not a plan defect): `ak plan check` fails on this Windows host with `planfile writer: read "...": Incorrect function`. Evidence that it is environmental rather than caused by this plan: the same command fails identically on the unrelated tracked directory `plans/2026-08-30-global-secrets-management`. `ak plan status` also errors without detail, while `ak plan validate` and `ak plan list` work.

### Verification Results (TypeSafe round) — 2026-09-20
- Claims checked: 11 for the TypeSafe addition
- Verified: 9 | Failed: 0 | Unverified: 2
- Roles exercised: Fact Checker, Contract Verifier
- Verified facts that shaped phase 8 and phase 9:
  - TypeSafe's API is `POST https://api.typesafe.ai/v1/systemone` with `Authorization: Bearer <API_KEY>`, body `{state, model, questions}`, three question types (`choice`, `score`, `noul`), and `confidence` plus `probabilities` on choice and score answers. Errors are `401`, `422`, `429`, and `529`.
  - The published skill-suggestion cookbook is a two-call design (rank every skill plus gate nouls, then rerank the top three with `fits::` nouls) with 0.30 thresholds, measured at 16.8% to 7.3% wrong loads and 9.8% to 4.0% needless loads over 488 requests, and it also reports 37 fixed against 7 broken requests.
  - Claude Code plugin hooks live in `hooks/hooks.json`, `UserPromptSubmit` fires before the model sees the prompt, has no matcher, and lowers the command, HTTP, and MCP-tool hook timeout default to 30 seconds; for `UserPromptSubmit` and `SessionStart` hook stdout is added to the context.
  - The plugin manifest currently declares only `skills`, so a hook plus an MCP server declaration is new plugin surface that must be documented.
  - `skillEntries()` in `worker/harness-worker.mjs` already resolves the 4-tier roster with `name`, `source`, `root`, `contentSha256`, and a shadowed list, but it parses no `description`, so the roster builder in phase 8 must add bounded frontmatter parsing.
  - `ModelProviderKindSchema` is a closed five-value LLM enum that feeds model-gateway sync, so the TypeSafe key must not be added there; a dedicated integration credential reusing the keyring pattern is the correct home.
  - `preferred_workspaces(owner_id, workspace_id)` exists in `state-store.ts`, so the MCP tool can resolve a workspace when the caller omits `workspaceId`.
  - Redaction primitives already exist as `SecretSnapshotRedactor` and `StreamRedactor` in `apps/runner/src/output-redactor.ts`, so the prompt-redaction step reuses them instead of adding a new mechanism.
  - `scripts/sync-cloudharness-plugin-skill.mjs` copies only `.agents/skills/cloudharness` into `plugins/cloud-harness/skills`, so adding `hooks/` and `.mcp.json` does not disturb the skills sync.
- Unverified, deferred to implementation:
  - The exact structured form of injecting context from a `UserPromptSubmit` handler (`hookSpecificOutput.additionalContext`) versus plain stdout. The plan specifies the documented stdout path and leaves the structured variant to be confirmed against the running version.
  - Whether the model id returned for `jev-latest` resolves to `jev-1.13` or a later alias, which only a live call can settle.
- Operator-provided key: `TYPESAFE_API_KEY` exists in the external file `D:/www/oss/cloud-harness-mcp/.env` and is non-empty. Presence and length were checked; the value was never read into the session, printed, or stored. Phase 9 defines a non-echoing load path and a fingerprint-only report.

### Verification Results (independent review round) — 2026-09-20
- Trigger: the operator asked for an independent review process, so a fresh-context `reviewer` subagent ran against this plan directory with no inherited conversation and read-only tools (run `0a281b91-dd4d-4b42-bd4c-bf396cf9fd00`).
- Reviewer verdict: ready with fixes, not ready to cook. Findings: 3 BLOCKER, 5 MAJOR, 12 MINOR, 3 NOTE, with roughly 35 repository claims checked.
- Independently re-verified here before acceptance, because a reviewer's claims are not evidence:
  - Confirmed: `worker/Dockerfile` does not exist and the executor image is built from `docker/executor.Dockerfile`, which copies from `worker/` into `/opt/harness/` with `chmod 0555`.
  - Confirmed: the executor base is `node:24.11.0-bookworm-slim` and the image installs into `/usr/local/bin`, so `/usr/bin/npx` is the wrong delegation target and a dispatcher at `/usr/local/bin/npx` would wrap itself.
  - Confirmed, and worse than first described: `compose.yaml:10` and `:72` give both `api` and `runner` the same `env_file`, while the boundary gate at `scripts/verify-compose-boundaries.mjs:79-81` checks only a fixed name list that `compose.yaml:11-21` zeroes by hand. A new secret name would therefore reach the API container with no gate catching it, which is exactly what the plan's own `.env.example` instruction would have created.
  - Confirmed: `DashboardResponseOperation` is a type-only union, `InternalRunnerOperationSchema` includes `workspace_close_fenced` with no mapper branch, and the runtime-iterable enum is `MetadataRunnerOperationSchema`.
  - Confirmed: `skills_run` executes through a local `command()` child process, not a helper container.
  - Confirmed: `PUT /api/v1/preferences` accepts only `{ theme }` under a strict schema.
  - Confirmed: `getRedactor(workspaceId)` reads only workspace secret snapshots, so provider credentials had no redaction owner.
  - Confirmed: the unique index `workspaces_owner_id_id` already exists, and the migration ladder ends at `schema_meta` version 9 in `apps/runner/src/principal-store.ts`.
  - Correction to the review: the reviewer described the boundary gate as directly asserting `SECRET_KEYRING`; the mechanism is a fixed name list plus manual zeroing. The substance of the finding holds and the implication is stronger, so the phase text now states the mechanism precisely.
- Reviewer items treated as unverifiable inside this repository and left marked as such: the TypeSafe API contract and cookbook measurements, whether `jev-latest` resolves to a specific build, Claude Code `UserPromptSubmit` semantics and hook schema, the skills.sh and SkillX CLI surfaces, and whether `docs:links` enforces navigation registration.

### Verification Results (post-rebase re-verification) — 2026-09-20
- **Trigger:** the `--advice` checkpoint subagent found the branch was built on a 77-commit-stale base. The controller verified this directly with git and then rebased, because a subagent's claim is not evidence.
- Confirmed by git against `origin/main`: `HEAD` was `2506618` (v0.38.1, 2026-08-31) while `origin/main` is `cbb18d1` (v0.48.0, 2026-09-16) — 77 commits behind, 247 files changed, `+27,805 -800`. `origin/dev` heads 2026-08-18 and is 228 commits behind `HEAD`, so the ship target is `main`.
- Confirmed, and the decisive finding: `apps/runner/src/principal-store.ts` on `origin/main` already sets `UPDATE schema_meta SET version = 10` at line 756, guards `if (version !== 10)` at line 760, exposes `downgradeStateSchemaToV9` at line 763, and `apps/runner/test/state-schema-v10.test.ts` already exists. The knowledge plane took version 10, so phase 1's target is **version 11 with a paired `downgradeStateSchemaToV10`**, not version 10.
- Confirmed on the rebased tree: `WorkspaceOpenParamsSchema` is still absent and `schemas.workspace_open` is still the real owner; `ToolkitSelectionSchema` still gains a third arm; `scripts/verify-compose-boundaries.mjs:80` still checks only the fixed name list, so the phase 9 secret-boundary finding still holds with shifted line numbers; `.env.example` and `compose.yaml` contain no `TYPESAFE` reference, so the dashboard-only key decision is intact.
- Changed on main and therefore needing per-phase re-verification before those phases start: `internal-runner-api.ts` gained `settings_get` and `settings_update` (MCP gateway work), `apps/api/dashboard/` gained the `/dashboard/knowledge` surface, `workspace-service.ts` grew by 409 lines, `tool-schemas.ts` by 134, and roughly 31 of the plan's named paths moved.
- Rebase outcome: both commits (`2da5a0e` plan, `b43372c` contracts) replayed onto `cbb18d1` with **no conflicts**. `packages/contracts` tests pass 109/109 and `npm run typecheck` is green across every workspace after the replay.

### Session 4 — 2026-09-20 (implementation start)
**Trigger:** operator invoked the vibe pipeline with `--ship` plus advisory supervision to implement the plan.

- Gate substitution: `ak plan red-team` does not exist in `ak` 2.17.0-beta.6 (confirmed from `ak plan --help`), so the gate is satisfied by the independent review round plus this post-rebase re-verification, and the substitution is recorded rather than silently skipped.
- Advisory outcome: the checkpoint returned **no-go on the single 135h run** and recommended dependency-ordered increments with one reviewed PR each, cut so that phase 1 ships alone because the plan itself schedules a re-estimate after phase 1 and phase 1 owns the only expensive-to-change decision (the migration plus composite foreign keys).
- Work completed and verified: the phase 1 contract layer is implemented and green (registry toolkit arm, bounded `skillSets`/`skillOverrides` on `workspace_open`, skill identifiers, duplicate-set guard; 16 new tests). This is the only code written, and it was re-verified after the rebase rather than carried forward unexamined.
- Corrections found during implementation: three in phase 1 (`WorkspaceOpenParamsSchema` absent, the third union arm, and the DDL belonging to the ladder), plus the version 11 supersession above.
- Not yet done: the remaining phase 1 work (skill table DDL at version 11, the paired downgrade, the seeded migration test, the `StateStore` CRUD helpers, and the internal-runner-api operations), and the per-phase re-verification delta for phases 2-9.

### Session 1 — 2026-09-20
**Trigger:** Operator asked to supplement the existing plan with a skills management UI in the dashboard.
**Questions asked:** 7 (3 scope, 4 design)

#### Questions & Answers

1. **[Scope]** Is this request a plan update or immediate implementation?
   - Options: Plan only | Plan plus UI code | Split into a new phase
   - **Answer:** Plan only.
   - **Rationale:** Phases 1-5 are unimplemented, so `/api/v1/skills` and `/api/v1/skill-sets` do not exist and UI code would have to run on mock data.

2. **[Scope]** Which management areas must the UI cover?
   - Options: Library CRUD and SKILL.md editor | Import wizard and job progress | Revision history with diff and rollback | Usage, lock, and bulk operations (multi-select)
   - **Answer:** All four.
   - **Rationale:** Each area maps to a distinct API surface, so all four must be specified together to keep phase 5 and phase 6 aligned.

3. **[Architecture]** Should the running agent toolkits be folded into the same Skills page?
   - Options: One unified Skills page | Read-only toolkit view | Keep them separate
   - **Answer:** One unified Skills page; the Open Workspace dialog then only selects sets.
   - **Rationale:** The launch dialog keeps direct `toolkits` selection for MCP and REST callers, but the dashboard gets a single management surface with a Registry tab.

4. **[Risks]** May owner-authored custom skills execute scripts through `skills_run`?
   - Options: Per-skill opt-in flag | Custom always instructions-only | Custom executes freely
   - **Answer:** Custom executes freely.
   - **Rationale:** This widens the execution surface, so the plan records that digest verification plus the UID 10001 sandbox are the controls, and phase 7 now asserts digest mismatch rejection for custom scripts too. The per-skill `allowExecution` flag is dropped.

5. **[Assumptions]** How do `disabled` and `archived` skills affect resolution and launch?
   - Options: Excluded from resolution while existing snapshots are retained | Archive also detaches from every set | Still resolve with a flag
   - **Answer:** Excluded from resolution with existing snapshots retained.
   - **Rationale:** Phase 3 now reports `disabled` entries with a reason in the preview, and phase 1 keeps `ON DELETE RESTRICT` so live snapshots stay GC roots.

6. **[Risks]** How should bulk archive or disable behave when an item is locked?
   - Options: Per-item partial success | All-or-nothing 409
   - **Answer:** Per-item partial success.
   - **Rationale:** `POST /api/v1/skills/bulk` returns one result per item, and phase 6 keeps locked rows selected with their blockers.

7. **[Scope]** What may the operator do with the `mattpocock/skills` and `obra/superpowers` presets?
   - Options: Read-only content with enable/disable/pin | Disable only | Fully read-only
   - **Answer:** Custom input, not an option.
   - **Custom input:** "đây chỉ là những bộ skills được đề xuất, không phải built-in skills, ai muốn cài thì chủ động cài tuỳ ý user"
   - **Rationale:** Presets are suggestions, not built-ins, so they must not occupy the `built-in` precedence rank. Phase 3 now states that they enter resolution only after being imported into the `owner` tier, and phase 6 renders them as `suggestion` rather than `installed`.

#### Confirmed Decisions
- Deliverable is a plan update only: choice of plan-only — no code is written in this session.
- Unified Skills page with four tabs and a reduced Open Workspace dialog: one management surface — because the toolkit grid is an unimplemented placeholder.
- Custom skills execute freely: free execution — controls are digest verification and the sandbox, documented in phase 2, phase 7, and the security model.
- Skill state semantics: `disabled` and `archived` leave resolution, existing snapshots are retained — because `ON DELETE RESTRICT` already makes snapshots GC roots.
- Bulk semantics: per-item partial success — because a single locked skill must not block an operator's whole batch.
- Preset tier: suggestions imported into the `owner` tier — because the operator states they are not built-ins.

#### Action Items
- [x] Extend phase 1 with skill state, tags, revision provenance, import jobs, and the internal operation enum.
- [x] Align phase 2 executable-asset semantics with free custom execution.
- [x] Extend phase 3 with disabled/archived resolution rules and preset-versus-built-in vocabulary.
- [x] Extend phase 5 with revision, diff, restore, fork, usage, bulk, import-job, and toolkit-registry endpoints plus the dashboard response allowlist rule.
- [x] Rewrite phase 6 as the unified management UI plus launch integration.
- [x] Extend phase 7 with the management lifecycle suite and the documentation targets.
- [x] Reconcile effort to 62h across `plan.md`, all phase files, and `plan.html` (superseded by 84h in Session 2).

#### Impact on Phases
- Phase 1: adds `skill_sources.state`/`tags`/`generation`, revision provenance columns, and the `skill_import_jobs` table.
- Phase 2: replaces the provenance execution gate with executable-asset accounting.
- Phase 3: adds disabled/archived exclusion and removes the preset-equals-built-in ambiguity.
- Phase 5: adds twelve skill endpoints, three toolkit-registry endpoints, and the operation allowlist requirement.
- Phase 6: rewritten around a unified management page; the dead toolkit grid is removed and the shell route allowlist is extended.
- Phase 7: adds the management lifecycle suite and the docs-site dashboard skills page.

### Session 2 — 2026-09-20
**Trigger:** Operator asked to apply TypeSafe (Jev) to auto-invoke a skill after every user prompt submit, with the API key configurable in the dashboard and a provided key available for implementation-time testing.
**Questions asked:** 4

#### Questions & Answers

1. **[Scope]** Where should the TypeSafe work live?
   - Options: A new standalone plan | Add phases to the existing skills plan | A new plan that must wait for the skills plan
   - **Answer:** Add phases to the existing skills plan.
   - **Rationale:** The workspace roster already exists through the worker's 4-tier index, so the feature does not have to wait for the registry work, while the dashboard and API patterns it reuses are already specified in this plan.

2. **[Architecture]** What mechanism triggers the suggestion after each prompt?
   - Options: MCP tool plus plugin hook | MCP tool only | Plugin hook only
   - **Answer:** MCP tool plus plugin hook.
   - **Rationale:** The MCP tool is host-agnostic, and only a hook actually fires after a prompt; Claude Code plugins support a `UserPromptSubmit` event whose output is added to the turn's context.

3. **[Risks]** The user's prompt leaves to a third-party service. How should egress be gated?
   - Options: Per-workspace opt-in | Global opt-in | Always on with redaction
   - **Answer:** Always on with redaction.
   - **Rationale:** Accepted with explicit controls: redaction of known secrets and credential shapes before egress, a 4096-byte egress payload bound (never above 8192), a redaction path that fails closed, a per-owner egress rate ceiling, an audit record per suggestion that never stores the prompt, a visible egress state with a one-time acknowledgement, a kill switch plus `TYPESAFE_EGRESS=off`, and a documented security-model update that names the trust-boundary expansion. The executor network mode is untouched because the call originates in the runner process.

4. **[Scope]** Which roster should TypeSafe rank?
   - Options: The workspace's resolved skills | The owner's whole library | A union of both
   - **Answer:** The workspace's resolved skills.
   - **Rationale:** This matches the roster the agent can actually see, matches the published cookbook, and works today through `skillEntries()`; registry-sourced skills join naturally once phase 3 lands.

#### Confirmed Decisions
- TypeSafe work is phases 8 and 9 of this plan: additive phases — because the roster already exists and the dashboard patterns are specified here.
- Trigger is an MCP tool plus a Claude Code plugin `UserPromptSubmit` hook: both surfaces — because only the hook is automatic and only the tool is host-agnostic.
- Egress is always-on with redaction: accepted third-party egress — controls are redaction, bounding, auditing, and a kill switch.
- Roster is the workspace's resolved skills: resolved roster — because it is what the agent sees and it works before the registry phases land.
- Suggestion stays advisory by default with `mode: 'suggest'`: measured design — because the cookbook's own data shows 37 improved against 7 regressed requests, so a suggested pointer that the agent may ignore beats an automatic load.

#### Action Items
- [x] Create `phase-08-typesafe-skill-suggestion-engine.md` (credential, roster, engine, redaction, cache, audit).
- [x] Create `phase-09-prompt-submit-surfaces-and-verification.md` (MCP tool, plugin hook, dashboard panel, docs, live harness).
- [x] Add the phases, goals, and success criteria to `plan.md` and `plan.html`, and reconcile effort to 84h.
- [x] Record that the operator-authorized key stays outside the repository and is only ever loaded non-echoingly.

#### Impact on Phases
- Phase 8: new phase, depends on phase 5 for internal-operation and response-allowlist patterns.
- Phase 9: new phase, depends on phase 6 for dashboard conventions and phase 8 for the engine.
- Phase 5: unchanged; its rule that every new internal operation needs an enum entry, a mapping branch, and a mapper test already covers the TypeSafe operations.
- Phase 7: unchanged; its documentation scope remains the skills registry work.
- Phases 1-6: unchanged apart from the plan-level totals and the goal list.

### Session 3 — 2026-09-20
**Trigger:** The operator asked for an independent review process, the `reviewer` subagent returned 3 BLOCKER, 5 MAJOR, 12 MINOR, and 3 NOTE findings, and the operator then decided how to apply them.
**Questions asked:** 3

#### Questions & Answers

1. **[Scope]** How far should the review findings be applied to the plan?
   - Options: Fix blockers, major, minor, and notes | Fix blockers and major only | Fix blockers only | Record findings without editing phases
   - **Answer:** Fix blockers, major, minor, and notes.
   - **Rationale:** All 20 findings are now resolved in the phase files, because every one of them was either a wrong path, a missing decision owner, an unbuildable test, or an internal contradiction.

2. **[Scope]** The reviewer re-estimated total effort at 135-160h against the plan's 84h. How should that be handled?
   - Options: Recalibrate to the reviewer's range | Recalibrate conservatively to the lower bound | Keep 84h with a risk note
   - **Answer:** Recalibrate to the reviewer's range, with the operator adding that the estimates are for AI agents, not human man-hours.
   - **Rationale:** Adopted the lower bound of that range, 135h, to avoid inflating agent execution time with a human-calibrated figure. The plan now states explicitly that the hours are AI-agent execution time, that human man-hours would be substantially higher, and that the remaining phases should be re-estimated against real phase 1 duration.

3. **[Risks]** The plan put the TypeSafe key in `.env.example` while promising it was dashboard-only and never in a container environment. Which resolution?
   - Options: Dashboard only, drop it from `.env` | Allow `.env` for development and tighten the boundary gate
   - **Answer:** Dashboard only.
   - **Rationale:** The key is documented nowhere as an environment variable, `.env.example` gains only the non-secret `TYPESAFE_ENDPOINT` and `TYPESAFE_EGRESS`, local testing loads the key into the test process from the operator's external file, and phase 9 now also runs `npm run verify:compose`.

#### Confirmed Decisions
- Apply all 20 review findings: full fix pass — because each one was a concrete defect or a missing decision owner.
- Effort becomes 135h, the reviewer's lower bound: recalibrated unit — because the reviewer's range is human-calibrated while the plan's unit is AI-agent execution time, and the plan now says so.
- TypeSafe key is dashboard-only: boundary fix — because both services share one `env_file` and the boundary gate cannot see a new secret name.

#### Action Items
- [x] Fix phase 1 (existing index reuse, migration owner, version 10) and phase 2 (network policy, proxy allowlist, `verify:compose`).
- [x] Fix phase 3 (repository sub-rank, Docker-bound mount criterion) and phase 4 (image path, `npx` dispatcher resolution, execution ownership, test lanes).
- [x] Fix phase 5 (totality test against the runtime enum, `requireWorkspace` ordering) and phase 6 (preferences schema, `FakeElement` extraction, exact route, registry status region).
- [x] Fix phase 7 (navigation owner, host qualification, phase-7 scope label).
- [x] Fix phase 8 (provider-credential redaction owner, audit surface owner) and phase 9 (key location, name allowlist and escaping, workspace liveness check, exact route, latency trade-off).
- [x] Recalibrate effort to 135h across nine phase frontmatters, `plan.md`, and the `plan.html` badges, and state the effort unit.

#### Impact on Phases
- Phase 1: reuses `workspaces_owner_id_id`, owns the version 10 bump in `principal-store.ts`.
- Phase 2: owns `TOOLKIT_NETWORK_POLICY=runner-fetch` and the provisioning proxy allowlist, and adds `npm run verify:compose`.
- Phase 3: preserves the repository sub-rank ahead of the conflict engine and binds the mount-inspect criterion to a Docker test.
- Phase 4: targets `docker/executor.Dockerfile`, installs the `npx` dispatcher at `/opt/harness/bin/npx`, states execution ownership and the approval-grant behaviour, and splits container tests into the Docker lane.
- Phase 5: scopes the totality test to `MetadataRunnerOperationSchema.options` and places new non-workspace operations above the `requireWorkspace` fall-through.
- Phase 6: drops the filters/tab persistence claim, extracts the test DOM helper, and names the exact `/skills` route plus the registry status region.
- Phase 7: names `docs-site/.vitepress/config.ts`, adds the host caveat, and is labelled the gate for phases 1-6 only.
- Phase 8: names the provider-credential redaction owner with a fixture test and the audit surface that owns suggestion records.
- Phase 9: removes the key from `.env`, adds the name allowlist plus XML escaping, checks workspace liveness, fixes the route string, and adds `npm run verify:compose`.

### Whole-Plan Consistency Sweep
- Renamed phase 6 title in `plan.md` and phase 6 frontmatter; the file name stays `phase-06-dashboard-ui-and-workspace-launch.md` so existing links keep working.
- Effort reconciled: phase 5 `6h -> 8h`, phase 6 `8h -> 20h`, phases 8 and 9 added at `10h` and `12h` in the earlier rounds, then the whole plan recalibrated in the independent-review round to `9/14/8/16/16/30/10/14/18h`, total `135h`, in `plan.md`, the nine phase frontmatters, and the `plan.html` badges. The unit is stated in the Overview as AI-agent execution time.
- Gates that `npm run verify` does not run are now named where they matter: `npm run verify:compose` in phases 2 and 9, and `npm run test:docker` in phases 3, 4, and 7.
- Cross-round totals: the 48h drift was corrected to 62h, then 84h, and now 135h; only the current figure appears in the phase table and the badges.
- Terminology unified: `preset` is a suggestion; `built-in` is reserved for executor-image skills; `skill_import_jobs` is the single durable import owner; `has_executable_assets` is the only execution-shape flag.
- Searched all plan files for the superseded terms `allowExecution`, `instructions-only (blocking execution`, and `durable operation status`; each was replaced by the accepted wording.
- No unresolved contradiction remains between `plan.md`, the nine phase files, and `plan.html`.

### Advisor Review — 2026-09-20
- Reviewed with `ask_advisor` after the edits were written. The advisor sized from a summary of phase 6 rather than the phase text, so its hour estimates are indicative rather than measured.
- Accepted: enforce the `mapDashboardData` guard as a totality test instead of a prose rule. Phase 5 now requires a test that fails when an internal runner operation has no mapper branch, because the silent-drop failure mode still passes typecheck.
- Accepted: the 12h phase 6 estimate was roughly 40% optimistic. Raised to 20h and split into four ordered milestones with exit criteria (M1 shell/library/registry 8h, M2 editor/revisions 6h, M3 import wizard 3h, M4 bulk/launch 3h) so an overrun surfaces at a milestone boundary.
- Deferred: the advisor recommended splitting phase 6 into two phases (management surface versus import/launch). The operator explicitly chose a plan-only update over adding a phase, so phase 6 stays one phase and instead names M1-M2 as an internal split point, with instructions to stop and report before M3 if M1 or M2 overruns.

### Advisor Review (TypeSafe round) — 2026-09-20
- Reviewed with `ask_advisor` after phase 8 and phase 9 were written. The advisor worked from a summary, so its judgement is on the described design rather than the phase text.
- Accepted, blocking: the injected `<skill_relevance>` block is a standing injection channel into every turn's context because it is produced by a remote model over attacker-influenceable skill descriptions. Phase 9 now requires a fixed template whose only variable part is a skill identifier validated against the current `rosterDigest`, bounded lengths, stripped control characters, no model prose, the explicit "may be ignored" wording, and no block at all when validation fails. Phase 8 already discards any Choice answer outside the roster.
- Accepted: reduce the egress payload instead of only cleaning it. The payload is now bounded to 4096 bytes by default (never above 8192) as an exposure control, with the truncation quality trade-off recorded, and the engine short-circuits locally with zero calls for the kill switch, an empty roster, a too-short prompt, or a bare slash command.
- Accepted: separate the two failure policies. Redaction now fails **closed** (no egress, `reason: 'redaction_failed'`) while the suggestion path still fails open, because a suggestion outage should not break a turn but an unredacted payload must not leave.
- Accepted: make always-on egress visible and reversible. Phase 9 adds `TYPESAFE_EGRESS=off` as a hard switch independent of key presence, a one-time acknowledgement when egress is first enabled, and a per-session count of suggestions and outbound calls.
- Accepted: name the trust-boundary expansion honestly in both security-model documents rather than presenting redaction as a barrier, and name the asymmetry with the executor's default `networkMode: none`.
- Accepted: the bundled plugin MCP entry must be a thin client to the existing control-plane endpoint with no second credential path, and the `skill_suggest` classification must be confirmed against the existing classification test because the tool writes audit rows and causes egress.
- Noted, not accepted as a change: the advisor repeated that the plan directory should be committed. That remains the operator's call and is an open question below.

### Open Questions
1. ~~The plan directory is untracked.~~ Resolved: the plan and its journals are committed in `2da5a0e` and pushed to `origin/mrgoonie/skills-compatiple`.
2. Should phase 6 become two phases if the first milestone overruns? Both the advisor and the independent reviewer named phase 6 as the most likely to overrun; the current choice is one phase with M1-M2 as an internal split point. Revisit after M1.
3. Should the one-time egress acknowledgement be blocking (suggestions stay off until the operator acknowledges in the dashboard) or informational? The plan currently makes it informational with a visible counter, because the operator chose always-on egress.
4. Re-estimate the remaining phases after phase 1 finishes rather than trusting the 135h total; the total is the reviewer's conservative lower bound and its unit is AI-agent execution time.
5. **Delivery shape (operator decision).** The advisory checkpoint recommended shipping in dependency-ordered increments with one reviewed PR each, because a single 135h run cannot honour the plan's own re-estimate-after-phase-1 checkpoint or the phase 6 M1 stop point, and because one large merge to `main` leaves no bisect granularity and no cheap revert. The operator's original instruction was a single run with `--ship`.
6. **Is inert-but-merged code acceptable on `main`?** Phases 1-3 land schema, adapters, and resolution with no user-visible surface until phase 6. If it is not acceptable, those increments need a long-lived integration branch with one final promotion instead of merging to `main` directly.

<!-- slug: skills-sh-and-skillx-compatibility -->
