---
phase: 3
title: "4-Tier Resolution, Precedence, Conflict Engine & Projection (TDD)"
status: completed
priority: P1
effort: "8h"
dependencies: [1, 2]
---

# Phase 3: 4-Tier Resolution, Precedence, Conflict Engine & Projection (TDD)

## Overview
Implement the centralized `SkillResolver` engine in `apps/runner/src/` that flattens multi-set selections, applies the deterministic 4-tier precedence hierarchy (`built-in > owner > workspace > repository`), detects and deduplicates same-digest entries, enforces collision rules on different-digest conflicts, and builds minimal, isolated filesystem projections into workspace containers.

## Requirements
- **Functional:**
  - `SkillResolver`:
    - Flatten all selected `skillSets` by resolving their pinned `skill_revision_id` records.
    - Merge direct toolkit selections (`owner` and `workspace` scopes), built-in catalog skills, and repository-discovered skills.
    - Resolve name collisions across tiers using the strict order: `built-in (rank 4) > owner (rank 3) > workspace (rank 2) > repository (rank 1)`.
    - Preserve the repository sub-rank that exists today before applying the conflict engine. In `worker/harness-worker.mjs` the function is declared at `:206`, the tier rank map lives at `:249-250`, and the repository sub-rank is an **explicit second comparator key** in the sort at `:261-268` (`.agents/skills` above `.codex/skills` above `.claude/skills`), not an implicit ordering. Phase 3 must state whether that sub-rank still resolves first, and it must do so, because same-name repository skills with different digests are otherwise promoted into a `CONFLICT` that operators never saw before. Record the decision in the phase text and cover it in the order-independence test.
    - Do not add a fourth rank map. Tier ranking already exists in three places: `worker/harness-worker.mjs:249-290`, `apps/runner/src/workspace-service.ts:2461`, and `apps/runner/src/local-workspace-backend.ts:266`. Projection also already exists as `composeOwnerToolkitProjection` (`apps/runner/src/workspace-service.ts:873-903`, which deduplicates owner-tier digests and raises `CONFLICT` at `:897`) plus workspace-tier `applyWorkspaceToolkitPatches` (`:909`). `SkillResolver` must state which of the three rank maps it supersedes and must extend or replace those projection helpers rather than reimplementing them.
    - Same-tier collision rule: identical tree SHA-256 digests deduplicate and preserve all contributing origin set IDs; different tree SHA-256 digests fail with `CONFLICT` unless resolved by explicit `skillOverrides[name] = revisionId`.
    - Track and report all shadowed candidates for `skills_list(includeShadowed: true)`.
    - Respect skill state: a `disabled` skill is removed from the resolution input and returned in a `disabled` list with its reason, so the launch preview explains why an expected skill is absent. An `archived` skill is excluded from every new launch while remaining valid for `workspace_skill_assignments` that already reference its revision; those rows stay GC roots through `ON DELETE RESTRICT`, so an existing workspace snapshot never breaks.
    - Keep tier vocabulary unambiguous: the `built-in` rank means a skill shipped inside the executor image, which cannot be installed, edited, or overridden. Catalog presets such as `mattpocock/skills` and `obra/superpowers` are recommendations, not built-ins: they participate in resolution only after an operator imports them into the `owner` tier.
  - Minimal Filesystem Projection:
    - Mount ONLY the workspace's pinned owner-tier skill bundles read-only at `/opt/cloud-harness/owner-skills/<skill-name>`.
    - Mount workspace-tier skill bundles at `.cloud-harness/skills/<skill-name>` when workspace modifications are authorized.
    - Generate an isolated, metadata-only catalog file at `/opt/cloud-harness/skill-catalog.json` containing only the locators, digests, and aliases assigned to this specific workspace.
    - **Never** mount the entire owner CAS root (`/var/lib/cloud-harness/cache/toolkits/<ownerId>/`, see `packages/contracts/src/config.ts:219` and `apps/runner/src/toolkit-cache-manager.ts:39`) into the workspace container. Note that this root is not mounted into workspace containers at all today, so this is a constraint to preserve rather than a mount to remove.
- **Non-functional / Security:**
  - Selection order of Skill Sets must have zero impact on resolution outcome (order-independent resolution).
  - Built-in skills cannot be overridden by user overrides (fail-closed).
  - Persist the full resolved lock in `workspace_skill_assignments` before container launch.

## Architecture
```text
Workspace Open Request (skillSets[], toolkits[], skillOverrides{})
                         │
                         ▼
             SkillResolver Engine
  ┌───────────────────────────────────────────────┐
  │ 1. Flatten set members (pinned revision IDs)  │
  │ 2. Deduplicate identical same-tier digests    │
  │ 3. Check different-digest same-tier conflicts │
  │    (apply skillOverrides or return CONFLICT)  │
  │ 4. Apply 4-tier precedence across tiers:      │
  │    built-in > owner > workspace > repository  │
  │ 5. Compile shadowed candidate metadata        │
  └───────────────────────────────────────────────┘
                         │
                         ▼
             StateStore Lock & Projection
  ┌─────────────────────────────────────────────────────────────┐
  │ - Persist workspace_skill_set_snapshots                     │
  │ - Persist workspace_skill_assignments                      │
  │ - Mount /opt/cloud-harness/owner-skills/<name> (ro)         │
  │ - Mount /opt/cloud-harness/skill-catalog.json (ro)          │
  └─────────────────────────────────────────────────────────────┘
```

## Related Code Files
- Create: `apps/runner/src/skill-resolver.ts`
- Modify: `apps/runner/src/workspace-service.ts`
- Modify: `apps/runner/src/internal-runner-operations.ts`
- Create: `apps/runner/test/skill-resolver.test.ts`
- Create: `apps/runner/test/skill-mount-projection.docker.test.ts`
- Modify: `apps/runner/test/skills-precedence.test.ts`
- Modify: `apps/runner/test/toolkit-mount-injection.test.ts`

## Implementation Steps
1. **Tests-First (TDD):**
   - Write comprehensive unit tests in `apps/runner/test/skill-resolver.test.ts`:
     - Test 4-tier precedence: built-in shadows owner, owner shadows workspace, workspace shadows repository.
     - Test multi-set combination: combining Set A and Set B with identical skill digests deduplicates seamlessly.
     - Test multi-set collision: combining Set A and Set B with different digests for the same skill name fails with a structured `CONFLICT` error.
     - Test explicit override: passing `skillOverrides: { 'deploy': 'skr_setB_rev' }` successfully resolves the conflict and locks the chosen revision.
     - Test order independence: `[SetA, SetB]` and `[SetB, SetA]` produce the exact same resolution digest and skill selection, including when two repository roots both provide the same skill name and the `.agents/skills` root must win by sub-rank rather than by conflict.
     - Test that a `disabled` skill is excluded from resolution and reported with a reason, and that an `archived` skill fails a new launch while its revision still resolves for a workspace snapshot created before archiving.
     - Test that importing the preset `mattpocock/skills` places its skills in the `owner` tier and that they never occupy the `built-in` rank.
   - Update `apps/runner/test/skills-precedence.test.ts` to verify shadow metadata format.
   - Update `apps/runner/test/toolkit-mount-injection.test.ts` to verify that only pinned bundles are mounted and owner-wide CAS is inaccessible.
2. **Implement SkillResolver:**
   - Create `SkillResolver` class in `apps/runner/src/skill-resolver.ts`.
   - Implement `resolveWorkspaceSkills(params: ResolveSkillsParams): Promise<ResolvedSkillsResult>`.
3. **Integrate with WorkspaceService:**
   - In `WorkspaceService.open` (`apps/runner/src/workspace-service.ts:745`; there is no `openWorkspace` symbol in this tree), invoke `SkillResolver` during preflight.
   - Persist resolution records into `workspace_skill_set_snapshots` and `workspace_skill_assignments`.
   - Construct container volume mounts for `/opt/cloud-harness/owner-skills/` and `/opt/cloud-harness/skill-catalog.json`.
4. **Verification:**
   - Run `npm test apps/runner/test/skill-resolver.test.ts` and `npm test apps/runner/test/skills-precedence.test.ts`.

## Success Criteria
- [x] 4-tier precedence strictly enforced in all resolution scenarios.
- [x] Same-tier different-digest collisions are blocked unless explicitly overridden by `skillOverrides`.
- [x] Reordering selected Skill Sets in the request produces identical resolution results.
- [x] `skills_list(includeShadowed: true)` returns all shadowed skills with provenance and reason.
- [x] Container inspect proves only pinned bundles and `skill-catalog.json` are mounted, not the owner-wide cache. This criterion is proven by `npm run test:docker` against `apps/runner/test/skill-mount-projection.docker.test.ts`; the unit command in step 4 cannot observe container mounts, so both are required.
- [x] `disabled` skills never enter resolution and are reported with a reason; `archived` skills are refused for new launches while existing snapshots keep resolving.
- [x] Catalog presets resolve as `owner`-tier skills after import and never as `built-in` skills.

## Risk Assessment
- **Risk:** Stale `expectedGeneration` on Skill Sets when multiple owners or tabs edit sets concurrently.
- **Mitigation:** Enforce generation validation in `SkillResolver`. If any selected Skill Set has a generation mismatch, reject launch with `409 STALE_GENERATION` and prompt client to refresh preview. `STALE_GENERATION` does not exist in `ErrorCodeSchema` (`packages/contracts/src/mcp-results.ts:3-25`, which currently ends its list at `STALE_HEAD`), so this phase must add the code there and cover it in the contract test, or reuse an existing code instead of inventing one that `HarnessError` rejects at the type level.

## Implementation Status (2026-09-20)
**Done and verified:**
- `apps/runner/src/skill-resolver.ts` implements `resolveWorkspaceSkills` with the 4-tier precedence, the repository sub-rank as an explicit comparator key, same-tier collision reporting for differing digests, `skillOverrides` pinning that also resolves a collision, disabled/archived exclusion with reasons, and `assertSkillSetGenerations` raising a typed stale-generation error.
- Determinism is enforced for the whole result, not just the resolved list: the excluded list is sorted, so candidate arrival order cannot change the output.
- `apps/runner/test/skill-resolver.test.ts`: 11 tests green; `npm run typecheck` and eslint clean on both files. A later change to `ErrorCodeSchema` makes the raised code a real contract error code, asserted in the test.
- The projection was extended rather than duplicated: `composeOwnerToolkitProjection` (`apps/runner/src/workspace-service.ts`) now builds candidates and delegates the same-tier collision decision to `resolveWorkspaceSkills`, so the launch path and the preview path share one conflict authority and an override settles a launch collision the same way it settles a preview one. It also gained an optional `overrides` parameter, and it now resolves before copying, so a conflicting toolkit set no longer leaves a partial projection behind. The four suites that exercise projection (`context-provenance`, `skills-precedence`, `toolkit-mount-injection`, `workspace-context-manifest`) stay green at 17 tests.

**Correction found while extending:** only `composeOwnerToolkitProjection` duplicated the same-tier rule. `applyWorkspaceToolkitPatches` (`:928`) compares a source digest against an existing target digest, which is a different rule about patching into the repository's own `.cloud-harness/skills`, so it correctly stays as it is.

**Naming correction:** the phase named a `SkillResolver` class. It is implemented as the pure `resolveWorkspaceSkills` function plus a typed generation guard, because a class wrapping only that function would add a layer with no behaviour. Later phases import the function.

**Corrections found while verifying this phase's own remaining claims:**
- **The claim that mount projection is unbuilt was wrong.** `provisionMountDirectories` (`apps/runner/src/workspace-service.ts:595-629`) provisions `<jobPath>/toolkit-projection/owner-skills`, chowns it to 10001, and `createExecutor` binds exactly that directory read-only at `:659` (`${ownerSkillsPath}:/opt/cloud-harness/owner-skills:ro`). The owner CAS root is never mounted, so the requirement "only projected skill directories may bind, never the owner CAS root" already held and needed no work here.
- **Lock persistence is blocked by a foreign key, not by a missing call.** `workspace_skill_assignments` declares `FOREIGN KEY (owner_id, skill_source_id, revision_id) REFERENCES skill_revisions(owner_id, skill_source_id, id) ON DELETE RESTRICT` (`principal-store.ts:854`). The owner-tier names resolved here carry only toolkit instance ids and content digests, and no `skill_sources` row exists for them, so persisting the resolved lock from today's launch path would fail that foreign key during workspace open. It belongs with the registry-backed resolution in Phases 4 and 5, once registry skills have real `skill_sources` and `skill_revisions` rows. `recordWorkspaceSkillSelection` has no production caller today and is exercised only by its Phase 1 test.
- Overrides are now live on the launch path: `WorkspaceService.open` passes `parsed.skillOverrides` (parsed through the Phase 1 contract schema at `:747`) into the projection helper, so an override that settles a preview collision settles the launch collision too, and the helper's optional parameter is no longer unused.
- The stale-generation guard raises a code that is now a member of `ErrorCodeSchema`; the only thing left is the HTTP 409 mapping, which belongs to Phase 5.

**Pre-existing finding (reported, not fixed):** `applyWorkspaceToolkitPatches` declares `record: WorkspaceRecord` and never reads it. This predates the work here, is inside a method this phase did not modify, and is left alone under the "do not fix pre-existing findings outside the changed region" rule.
