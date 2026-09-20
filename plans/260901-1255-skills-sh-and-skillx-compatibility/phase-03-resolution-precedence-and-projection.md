---
phase: 3
title: "4-Tier Resolution, Precedence, Conflict Engine & Projection (TDD)"
status: pending
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
    - Preserve the repository sub-rank that exists today before applying the conflict engine: `skillEntries()` in `worker/harness-worker.mjs:258-268` silently ranks `.agents/skills` (3) above `.codex/skills` (2) above `.claude/skills` (1). Phase 3 must state whether that sub-rank still resolves first, and it must do so, because same-name repository skills with different digests are otherwise promoted into a `CONFLICT` that operators never saw before. Record the decision in the phase text and cover it in the order-independence test.
    - Same-tier collision rule: identical tree SHA-256 digests deduplicate and preserve all contributing origin set IDs; different tree SHA-256 digests fail with `CONFLICT` unless resolved by explicit `skillOverrides[name] = revisionId`.
    - Track and report all shadowed candidates for `skills_list(includeShadowed: true)`.
    - Respect skill state: a `disabled` skill is removed from the resolution input and returned in a `disabled` list with its reason, so the launch preview explains why an expected skill is absent. An `archived` skill is excluded from every new launch while remaining valid for `workspace_skill_assignments` that already reference its revision; those rows stay GC roots through `ON DELETE RESTRICT`, so an existing workspace snapshot never breaks.
    - Keep tier vocabulary unambiguous: the `built-in` rank means a skill shipped inside the executor image, which cannot be installed, edited, or overridden. Catalog presets such as `mattpocock/skills` and `obra/superpowers` are recommendations, not built-ins: they participate in resolution only after an operator imports them into the `owner` tier.
  - Minimal Filesystem Projection:
    - Mount ONLY the workspace's pinned owner-tier skill bundles read-only at `/opt/cloud-harness/owner-skills/<skill-name>`.
    - Mount workspace-tier skill bundles at `.cloud-harness/skills/<skill-name>` when workspace modifications are authorized.
    - Generate an isolated, metadata-only catalog file at `/opt/cloud-harness/skill-catalog.json` containing only the locators, digests, and aliases assigned to this specific workspace.
    - **Never** mount the entire owner CAS root `/opt/cloud-harness/cache/<owner>/` into the workspace container.
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
   - In `WorkspaceService.openWorkspace`, invoke `SkillResolver` during preflight.
   - Persist resolution records into `workspace_skill_set_snapshots` and `workspace_skill_assignments`.
   - Construct container volume mounts for `/opt/cloud-harness/owner-skills/` and `/opt/cloud-harness/skill-catalog.json`.
4. **Verification:**
   - Run `npm test apps/runner/test/skill-resolver.test.ts` and `npm test apps/runner/test/skills-precedence.test.ts`.

## Success Criteria
- [ ] 4-tier precedence strictly enforced in all resolution scenarios.
- [ ] Same-tier different-digest collisions are blocked unless explicitly overridden by `skillOverrides`.
- [ ] Reordering selected Skill Sets in the request produces identical resolution results.
- [ ] `skills_list(includeShadowed: true)` returns all shadowed skills with provenance and reason.
- [ ] Container inspect proves only pinned bundles and `skill-catalog.json` are mounted, not the owner-wide cache. This criterion is proven by `npm run test:docker` against `apps/runner/test/skill-mount-projection.docker.test.ts`; the unit command in step 4 cannot observe container mounts, so both are required.
- [ ] `disabled` skills never enter resolution and are reported with a reason; `archived` skills are refused for new launches while existing snapshots keep resolving.
- [ ] Catalog presets resolve as `owner`-tier skills after import and never as `built-in` skills.

## Risk Assessment
- **Risk:** Stale `expectedGeneration` on Skill Sets when multiple owners or tabs edit sets concurrently.
- **Mitigation:** Enforce generation validation in `SkillResolver`. If any selected Skill Set has a generation mismatch, reject launch with `409 STALE_GENERATION` and prompt client to refresh preview.
