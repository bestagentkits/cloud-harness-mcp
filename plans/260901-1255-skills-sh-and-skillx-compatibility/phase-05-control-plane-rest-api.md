---
phase: 5
title: "Control-Plane REST API & Internal Runner Operations (TDD)"
status: pending
priority: P1
effort: "16h"
dependencies: [1, 3]
---

# Phase 5: Control-Plane REST API & Internal Runner Operations (TDD)

## Overview
Implement authenticated REST endpoints in `apps/api/src/` and corresponding internal runner operations in `apps/runner/src/internal-runner-operations.ts` for Skill CRUD, upstream import/refresh, federated search across local and remote registries, and Skill Set management with optimistic generation fencing.

## Requirements
- **Functional:**
  - Skill Library Operations:
    - `GET /api/v1/skills`: List installed, custom, and imported skills with pagination (`cursor`, `limit`) and filters for search query `q`, provider, state, and tag.
    - `GET /api/v1/skills/:skillId`: Return detailed metadata, markdown instructions, file manifests, source provenance, and the current generation.
    - `POST /api/v1/skills/import`: Start an asynchronous runner import job from `skills.sh` (`owner/repo`), `skillx.sh` (`slug`), or an HTTPS Git URL, returning the durable `skill_import_jobs` id.
    - `GET /api/v1/skills/imports/:jobId`: Report import state, per-skill progress, produced revision ids, and a bounded error code for the import wizard.
    - `POST /api/v1/skills/imports/:jobId/cancel`: Cancel a queued or running import without deleting revisions it already produced.
    - `POST /api/v1/skills/custom`: Create an owner-authored skill from markdown `SKILL.md` and optional bounded assets.
    - `PATCH /api/v1/skills/:skillId`: Update display metadata, tags, or state, or replace custom-skill instructions, with an `expectedGeneration` CAS check. Any instruction change creates a new immutable revision with `origin: 'edit'`.
    - `GET /api/v1/skills/:skillId/revisions`: List revisions with id, short digest, origin, parent revision, source commit, created time, and the number of live workspace snapshots pinning them.
    - `GET /api/v1/skills/:skillId/revisions/:revisionId`: Return one revision's content and file manifest.
    - `GET /api/v1/skills/:skillId/revisions/:revisionId/diff?against=current|<revisionId>`: Return a unified diff with bounded line and byte counts for the revision comparison view.
    - `POST /api/v1/skills/:skillId/restore`: Create a new revision from an existing revision's content (`origin: 'restore'`) with an `expectedGeneration` check.
    - `POST /api/v1/skills/:skillId/fork`: Create an owner-tier custom skill from an existing revision (`origin: 'fork'`).
    - `GET /api/v1/skills/:skillId/usage`: Return the skill sets and live workspace snapshots referencing the skill, so the UI can explain a lock before offering archive.
    - `POST /api/v1/skills/:skillId/refresh`: Check the upstream provider and create a new immutable revision if changes exist.
    - `DELETE /api/v1/skills/:skillId`: Archive the skill; return 409 listing the referencing sets and workspaces when a live snapshot pins it.
    - `POST /api/v1/skills/bulk`: Apply `enable`, `disable`, `archive`, or `tag` to at most 50 skills and return one result per item. A locked item returns a conflict with its blockers while the remaining items still apply; a batch never fails as a whole.
  - Federated Catalog Search:
    - `GET /api/v1/skills/search?q=...&providers=installed,catalog,skills-sh,skillx`: Query local SQLite and external providers concurrently; return aggregated results with per-provider status and latency warnings.
    - Distinguish `suggestion` (an installable preset or remote catalogue entry) from `installed`, so the UI never presents `mattpocock/skills` or an external hit as an already-available skill.
  - Skill Sets Operations:
    - `GET /api/v1/skill-sets`: List all Skill Sets for the authenticated principal.
    - `POST /api/v1/skill-sets`: Create a new Skill Set with name, description, and initial members.
    - `GET /api/v1/skill-sets/:setId`: Return Skill Set details and ordered members.
    - `PATCH /api/v1/skill-sets/:setId`: Atomically replace name, description, or member list with `expectedGeneration` check.
    - `DELETE /api/v1/skill-sets/:setId`: Delete a Skill Set with `expectedGeneration` check.
    - `POST /api/v1/skill-sets/preview`: Run preflight resolution on a set of `skillSetIds` and `skillOverrides`, returning effective skills, shadows, disabled entries, and conflicts.
  - Toolkit Registry Operations:
    - `GET /api/v1/toolkits`: Extend the existing operation, which currently returns only `listCatalogPresets()`, so each entry carries `enabled`, `pinnedRef`, `pinnedOid`, `cacheState` (`cached`, `missing`, `quarantined`), `skillCount`, `sizeBytes`, `lockedBy`, and `kind` (`preset`, `git`).
    - `PATCH /api/v1/toolkits/:instanceId`: Enable or disable a toolkit and pin a ref or revision, with `expectedGeneration`.
    - `POST /api/v1/toolkits/:instanceId/refresh`: Re-acquire the toolkit from upstream and report the resulting commit and digest.
- **Non-functional / Security:**
  - All endpoints require authentication and enforce strict `owner_id` scoping.
  - Mutations are protected by CSRF validation and optimistic concurrency checks (`expectedGeneration`).
  - Remote search timeouts (3s per provider) degrade gracefully by returning partial results rather than HTTP 500.
  - Every new internal operation is declared in `packages/contracts/src/internal-runner-api.ts`, added to `DashboardResponseOperation`, and given an explicit mapping branch in `mapDashboardData` (`apps/api/src/dashboard-response.ts`). Two facts constrain how that is tested: `DashboardResponseOperation` is a **type-only union** (`dashboard-response.ts:34-53`) and therefore not iterable at runtime, while `MetadataRunnerOperationSchema` (`internal-runner-api.ts:117-125`, which already includes the MCP-gateway additions) is a real `z.enum` whose `.options` can be iterated. The mapper drops unknown keys by design, so an unmapped operation returns an empty object while still passing typecheck; each addition needs a mapper branch and a contract test. One placement rule follows from `packages/contracts/test/internal-runner-api.test.ts:78-84`, which asserts that every metadata operation is absent from `RunnerOperationSchema.options` and `TOOL_SPECS`: an internal operation must not also be published as a public MCP tool, so a tool that needs both surfaces needs one name on each side and an explicit bridge rather than the same name in both enums.
  - Operations that are not workspace-scoped must early-return **above** the `requireWorkspace` fall-through in `apps/runner/src/workspace-service.ts:3439-3459`. Every operation reaching that fall-through resolves a workspace, so a skill or toolkit-registry operation placed after it throws on every call.
  - Bulk responses stay bounded (50 items) and per-item so a partial failure is visible rather than reported as success.

## Architecture
```text
Dashboard Web Client
       │ (authenticated HTTP with CSRF + session)
       ▼
apps/api/src/dashboard-skills-router.ts
       │
       ▼ (RunnerClient internal RPC)
apps/runner/src/internal-runner-operations.ts
  ├── SkillLibraryOperations (CRUD, custom skills, revisions)
  ├── SkillImportOperations (Async import via SkillsSh/SkillX adapters)
  ├── SkillSearchOperations (Federated search with Promise.allSettled)
  └── SkillSetOperations (Set CRUD, member replacement, preview resolution)
       │
       ▼
StateStore (SQLite) + ToolkitCacheManager (CAS)
```

## Related Code Files
- Create: `apps/api/src/dashboard-skills-router.ts`
- Create: `apps/api/test/dashboard-skills-router.test.ts`
- Create: `apps/api/test/dashboard-response-skills.test.ts`
- Create: `apps/runner/test/internal-runner-skills-operations.test.ts`
- Modify: `apps/api/src/dashboard-router.ts`
- Modify: `apps/api/src/dashboard-response.ts`
- Modify: `apps/api/src/runner-client.ts`
- Modify: `packages/contracts/src/internal-runner-api.ts`
- Modify: `apps/runner/src/internal-runner-operations.ts`
- Modify: `apps/runner/src/internal-runner-app.ts`
- Modify: `apps/runner/src/workspace-service.ts`

## Implementation Steps
1. **Tests-First (TDD):**
   - Write unit tests in `apps/runner/test/internal-runner-skills-operations.test.ts`:
     - Test Skill CRUD: create, get, generation-fenced update, archive, and tag updates.
     - Test the import lifecycle: starting a job, polling it to terminal state, cancelling a running job, and resting the job state across a store reopen.
     - Test revision operations: listing revisions, reading one revision, diffing against current, restoring into a new revision, and forking into an owner-tier custom skill.
     - Test usage reporting: a skill pinned by a skill set and a live workspace snapshot returns both references and a lock reason.
     - Test bulk operations: a batch of three where one item is locked returns two successes and one conflict in the same response.
     - Test Skill Set CRUD: creating set, replacing members atomically, rejecting update on stale generation.
     - Test preview resolution: returning effective skills, shadows, disabled entries, and conflicts for selected sets.
     - Test federated search with one failing remote provider: verifying partial results are returned without throwing, and that remote entries are labelled `suggestion`.
     - Test toolkit registry enrichment: cache state, pinned commit, skill count, and lock state for a preset and a Git toolkit.
   - Write API route tests in `apps/api/test/dashboard-skills-router.test.ts`:
     - Test auth verification: unauthenticated requests return 401.
     - Test CSRF protection on POST/PATCH/DELETE routes.
     - Test cross-principal isolation: owner A cannot read or mutate owner B's skills or sets.
   - Write mapper tests in `apps/api/test/dashboard-response-skills.test.ts`:
     - Note that `apps/api/test/dashboard-router.test.ts:97` holds a 13-key allowlist fixture map typed `Record<DashboardResponseOperation, unknown>`, but `apps/api` typechecks only `src/**/*.ts`, so that map is not enforced for tests and does not itself force an edit.
     - Test totality against `MetadataRunnerOperationSchema.options`, not against `DashboardResponseOperation` (a type-only union that cannot be iterated): every metadata operation must have a `mapDashboardData` branch so adding one without a mapper fails CI instead of silently returning an empty object. Explicitly exclude the four workspace and toolkit operations (`workspace_detail`, `workspace_close_fenced`, `toolkits_list`, `toolkits_preview`) with a comment naming why, since `workspace_close_fenced` deliberately has no dashboard branch today.
2. **Implement Runner Operations:**
   - Add skill, revision, import-job, skill-set, and toolkit-registry operation handlers in `apps/runner/src/internal-runner-operations.ts`, including the registry enrichment in `apps/runner/src/workspace-service.ts` where `executeInternal` currently handles `toolkits_list` and `toolkits_preview`. Handle every new non-workspace operation in an early-return branch above the `requireWorkspace` fall-through, otherwise each call fails on workspace resolution.
   - Register the new request schemas in `packages/contracts/src/internal-runner-api.ts` and the routes in `apps/runner/src/internal-runner-app.ts`.
3. **Implement API Router:**
   - Create `dashboard-skills-router.ts` in `apps/api/src/`.
   - Mount router at `/dashboard/api/v1` in `apps/api/src/dashboard-router.ts`.
   - Extend `DashboardResponseOperation` and add one allowlist mapping branch per new operation in `apps/api/src/dashboard-response.ts`.
4. **Verification:**
   - Run `npm test apps/runner/test/internal-runner-skills-operations.test.ts` and `npm test apps/api/test/dashboard-skills-router.test.ts`.

## Success Criteria
- [ ] All Skill and Skill Set CRUD endpoints work with strict `owner_id` isolation.
- [ ] Stale generation updates on skills or sets return `409 Conflict`.
- [ ] Federated search gracefully handles external provider timeouts (3s limit) and returns local results with provider warnings.
- [ ] Import operations execute asynchronously, report progress through `skill_import_jobs`, and survive a runner restart.
- [ ] Deleting a skill referenced by a live set returns 409 explaining retained dependencies.
- [ ] Revision diff, restore, and fork endpoints produce new immutable revisions with `origin` set and never mutate existing revision rows.
- [ ] A bulk request with a locked item returns per-item results instead of failing the whole batch.
- [ ] Every new skills operation has a `dashboard-response.ts` mapping branch covered by test, so no operation reaches the browser as an empty object.
- [ ] A totality test over `MetadataRunnerOperationSchema.options` fails when a metadata operation has no `mapDashboardData` branch, closing the silent-drop failure mode for future operations, and every new non-workspace operation is handled above the `requireWorkspace` fall-through.

## Risk Assessment
- **Risk:** External search flooding the server with outgoing requests during user typing.
- **Mitigation:** Debounce search requests in Dashboard client, cap search concurrency per owner in API, and apply rate limits on provider adapter calls.
- **Risk:** A new internal operation typechecks correctly but reaches the browser as an empty object because `mapDashboardData` uses an explicit key allowlist.
- **Mitigation:** Add the operations enum entry, the mapping branch, and a mapper test in the same change, and fail the phase if any skills operation lacks a mapper test.
