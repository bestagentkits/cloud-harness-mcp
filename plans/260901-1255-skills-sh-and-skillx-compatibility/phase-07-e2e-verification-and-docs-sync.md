---
phase: 7
title: "End-to-End Verification, Security Adversarial Suite & Docs Sync"
status: pending
priority: P1
effort: "10h"
dependencies: [4, 6]
---

# Phase 7: End-to-End Verification, Security Adversarial Suite & Docs Sync

## Overview
Perform comprehensive end-to-end integration testing of the entire workflow (from Dashboard import to air-gapped workspace launch and CLI/MCP execution). Execute adversarial security suites verifying secret isolation, TOCTOU defense, and air-gap integrity. Synchronize agent skill definitions and public documentation across `docs/` and `docs-site/`.

Scope note: this phase is the quality gate for phases 1-6, which is the skills registry and dashboard work. Phases 8 and 9 add the TypeSafe suggestion engine, the MCP tool, the plugin hook, and further documentation, so the full `npm run verify` gate is re-run in phase 9 after those land. Do not read this phase's gate result as a gate over the whole plan.

## Requirements
- **Functional:**
  - End-to-End Test Suite:
    - Test full execution lifecycle: import a skill from skills.sh/SkillX via API -> create a Skill Set -> launch a `networkMode: 'none'` workspace with the set -> run `skills add` and `skillx use` inside the container -> run `skills_list` and `skills_read` via MCP -> execute a script via `skills_run` -> verify clean workspace teardown.
    - Test the operator management lifecycle against a real runner store through `dashboard-skills-router.ts`: create a custom skill, edit its instructions into a second revision, diff the two revisions, restore the first, fork it into a second skill, then bulk-archive a batch where one skill is pinned by a live workspace and assert per-item results (`2` successes plus `1` conflict with blockers).
    - Test that a `disabled` skill disappears from a launch preview and that an `archived` skill is refused for a new launch while an already-created workspace snapshot keeps resolving.
    - Test the import-job path end to end: start an import, poll it to a terminal state through the API, and confirm the produced revisions are visible in the Library.
  - Security & Adversarial Suite:
    - Verify zero secret/credential leakage into executor environment, volumes, or CLI output.
    - Verify executor cannot make outbound connections in `networkMode: 'none'`.
    - Verify attempt to execute modified or swapped script in `skills_run` fails immediately with digest mismatch, including for owner-authored custom skills, whose only execution control is this digest verification plus the sandbox.
    - Verify cross-principal data isolation across all database operations, including the new revision, usage, bulk, and import-job endpoints.
  - Documentation & Skill Synchronization:
    - Update `.agents/skills/cloudharness/SKILL.md` and reference files with skills.sh, SkillX, and Skill Set usage instructions.
    - Run `npm run plugin:sync` to ensure `.agents/skills/cloudharness/` and `plugins/cloud-harness/skills/cloudharness/` are byte-identical.
    - Update public documentation in `docs/system-architecture.md`, `docs/mcp-api.md`, `docs/security-model.md`, and `docs-site/` guides.
    - Create `docs-site/dashboard/skills.md`, register it in the docs site navigation owned by `docs-site/.vitepress/config.ts` (the only configuration file under `docs-site`), and cross-link it from `docs-site/dashboard/index.md` and `docs-site/dashboard/workspaces.md`, because the Open Workspace dialog no longer exposes toolkit checkboxes. `npm run docs:links` verifies links, not navigation registration, so registering the page is a manual step that must not be skipped.
- **Non-functional:**
  - Maintain 100% pass rate across unit, integration, and contract test suites (`npm run verify`).

## Architecture
```text
Full Lifecycle E2E Verification
┌────────────────────────────────────────────────────────────────────────┐
│ 1. Import Git/SkillX Skill  -> 2. Create Skill Set                     │
│ 3. Launch Air-Gapped WS     -> 4. Run `skills add` / `skillx use` CLI  │
│ 5. Call `skills_list/read`  -> 6. Call `skills_run` with digest check  │
│ 7. Verify Zero Leaks        -> 8. Reconcile & Teardown Workspace       │
└────────────────────────────────────────────────────────────────────────┘
```

## Related Code Files
- Create: `test/integration/skills-compatibility.docker.test.ts`
- Create: `test/integration/skills-management-lifecycle.test.ts`
- Create: `docs-site/dashboard/skills.md`
- Modify: `.agents/skills/cloudharness/SKILL.md`
- Modify: `.agents/skills/cloudharness/references/repository-automation.md`
- Modify: `.agents/skills/cloudharness/references/tool-reference.md`
- Modify: `docs/system-architecture.md`
- Modify: `docs/mcp-api.md`
- Modify: `docs/security-model.md`
- Modify: `docs/design-guidelines.md`
- Modify: `docs-site/agent-toolkits.md`
- Modify: `docs-site/dashboard/index.md`
- Modify: `docs-site/dashboard/workspaces.md`
- Modify: `docs-site/security-model.md`
- Modify: `docs-site/reference/tools.md`

## Implementation Steps
1. **Implement E2E Integration Suites:**
   - Create `test/integration/skills-compatibility.docker.test.ts`:
     - Test the complete workflow against real Docker containers with air-gap verification.
     - Test running both direct and `npx` commands in the executor container.
     - Test digest verification and execution in helper containers.
   - Create `test/integration/skills-management-lifecycle.test.ts` for the operator management lifecycle through `dashboard-skills-router.ts` (custom creation, instruction edit into a new revision, diff, restore, fork, per-item bulk conflict, import-job polling, disabled and archived launch behavior).
2. **Execute Full Verification Gate:**
   - Run unit suites: `npm run test:unit`.
   - Run integration suites: `npm run test:integration`.
   - Run Docker sandbox suites: `npm run test:docker`.
   - Run linter and typecheck: `npm run lint && npm run typecheck`.
   - Host caveat: `AGENTS.md` requires Windows and other non-POSIX hosts to use the targeted suites as the local baseline, because shell fixture tests in `test/deploy-release-runtime.test.ts` and `test/upgrade-nginx-routes.test.ts` need a POSIX host. The Docker and shell gates are authoritative in Linux CI (`.github/workflows/ci.yml`), so record the host used and treat an unavailable Docker or POSIX prerequisite as a reported prerequisite, not a pass.
3. **Synchronize Agent Skill & Plugins:**
   - Update `.agents/skills/cloudharness/SKILL.md` with new `skillSets` and registry toolkit options.
   - Update `.agents/skills/cloudharness/references/repository-automation.md`.
   - Run `npm run plugin:sync` and verify compliance with `npm test packages/contracts/test/cloudharness-skill-contract.test.ts`.
4. **Update Official Documentation:**
   - Update `docs/system-architecture.md` with the 4-tier precedence, CAS, Skill Set architecture, and the `dashboard-skills-router.ts` plus `dashboard-response.ts` allowlist boundary.
   - Update `docs/mcp-api.md` with updated `workspace_open` parameters and provenance structures.
   - Update `docs/security-model.md` with the updated threat model, the TOCTOU defense rules, and the explicit statement that owner-authored custom skills are executable content whose controls are digest verification plus the sandbox rather than provenance gating.
   - Update `docs/design-guidelines.md` with the new Skills surfaces as named components.
   - Create `docs-site/dashboard/skills.md`, register it in `docs-site/.vitepress/config.ts`, and cross-link it from `docs-site/dashboard/index.md` and `docs-site/dashboard/workspaces.md`; update `docs-site/agent-toolkits.md` to present presets as installable suggestions and to document the Registry tab; update `docs-site/security-model.md` to match the internal threat-model wording; then run `npm run docs:reference`.

## Success Criteria
- [ ] E2E integration tests pass covering the full import -> set -> workspace -> CLI -> run lifecycle and the operator management lifecycle (custom create, edit, diff, restore, fork, per-item bulk conflict, import progress).
- [ ] Adversarial checks confirm 0 secrets leaked, 0 air-gap bypasses, and 100% TOCTOU protection, including custom skill scripts.
- [ ] `npm run plugin:sync` passes with zero drift between `.agents/skills/` and `plugins/`.
- [ ] `npm test packages/contracts/test/cloudharness-skill-contract.test.ts` passes.
- [ ] `docs-site/dashboard/skills.md` exists, is reachable from the site navigation, and `npm run docs:links` passes.
- [ ] All repository quality gates pass for the phases 1-6 scope (`npm run verify`), and phase 9 re-runs that same gate after the TypeSafe work lands.

## Risk Assessment
- **Risk:** Documentation drift between internal docs and public docs site.
- **Mitigation:** Run automated contract tests and documentation reference generators (`npm run docs:reference` and `npm run plugin:sync`) as part of the phase completion checklist.
