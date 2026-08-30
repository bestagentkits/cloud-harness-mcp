# Phase 3: Skill Precedence, Resolution Engine & Digest-Pinned Execution

## Context Links
- Plan: `plans/260830-0700-15-provenance-aware-workspace-context-skills-memories-hooks/plan.md`
- Code: `apps/runner/src/workspace-service.ts`, `worker/harness-worker.mjs`

## Requirements
- Define Physical Skill Source Roots & Logical Mapping:
  - `built-in`: release-packaged built-in catalog (e.g. `/opt/cloud-harness/skills` or runner packaged catalog)
  - `owner`: runner-managed principal catalog mounted read-only into automation helpers
  - `workspace`: workspace-managed tools overlay (`.cloud-harness/skills`)
  - `repository`: standard repo roots (`.agents/skills`, `.codex/skills`, `.claude/skills`)
- 4-Tier Precedence Resolver:
  - `built-in > owner > workspace > repository`
  - Within repository: `.agents/skills > .codex/skills > .claude/skills`
  - Exact duplicates at the same precedence rank yield `AMBIGUOUS_SOURCE` rather than arbitrary selection
- Digest Pinning & TOCTOU Protection:
  - `skills_list` returns effective selected skill and full array of `shadowed[]` candidate descriptors with source, root, and shadow reason
  - `skills_read` returns bounded markdown instructions with provenance
  - `skills_run` requires `expectedContentSha256` matching the approved script/entrypoint SHA-256
  - Worker re-hashes the exact script bytes immediately before execution and aborts with `CONFLICT` if mismatch occurs
- Sandbox Execution:
  - All skill scripts run inside executor container as UID 10001 with read-only root, dropped capabilities, no broker credentials, and `networkMode: none` by default

## Files to Modify/Create
- `apps/runner/src/workspace-service.ts`
- `worker/harness-worker.mjs`
- `apps/runner/test/skills-precedence.test.ts` (new test file)

## Implementation Steps
1. Implement `resolveSkillCandidates(workspaceRecord, skillName)` in `WorkspaceService`.
2. Update `skills_list`, `skills_read`, and `skills_run` in `workspace-service.ts` and `harness-worker.mjs`.
3. Add digest verification guard in `skills_run` before process launch.
4. Add comprehensive unit tests verifying 4-tier precedence, collision handling, and digest mismatch rejection.

## Tests & Validation
- `npm test apps/runner/test/skills-precedence.test.ts`
- Verify 4 same-name skill candidates resolve strictly to built-in > owner > workspace > repository.
