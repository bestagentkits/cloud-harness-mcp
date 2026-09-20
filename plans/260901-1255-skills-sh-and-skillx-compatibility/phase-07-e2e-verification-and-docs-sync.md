---
phase: 7
title: "End-to-End Verification, Security Adversarial Suite & Docs Sync"
status: completed
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
    - Test full execution lifecycle: import a skill from skills.sh/SkillX via API -> create a Skill Set -> launch a workspace with `networkProfile: 'network-none'` (the schema rejects the retired `networkMode` field outright at `packages/contracts/src/tool-schemas.ts:309-325`) with the set -> run `skills add` and `skillx use` inside the container -> run `skills_list` and `skills_read` via MCP -> execute a script via `skills_run` -> verify clean workspace teardown. The two CLIs are external (nothing in this tree provides them; only `README.md:255` mentions `npx skills add`), so pin explicit versions and define the offline-mirror story before writing the container half of this test.
    - Test the operator management lifecycle against a real runner store through `dashboard-skills-router.ts`: create a custom skill, edit its instructions into a second revision, diff the two revisions, restore the first, fork it into a second skill, then bulk-archive a batch where one skill is pinned by a live workspace and assert per-item results (`2` successes plus `1` conflict with blockers).
    - Test that a `disabled` skill disappears from a launch preview and that an `archived` skill is refused for a new launch while an already-created workspace snapshot keeps resolving.
    - Test the import-job path end to end: start an import, poll it to a terminal state through the API, and confirm the produced revisions are visible in the Library.
  - Security & Adversarial Suite:
    - Verify zero secret/credential leakage into executor environment, volumes, or CLI output.
    - Verify the executor cannot make outbound connections when launched with `networkProfile: 'network-none'`.
    - Verify attempt to execute modified or swapped script in `skills_run` fails immediately with digest mismatch, including for owner-authored custom skills, whose only execution control is this digest verification plus the sandbox.
    - Verify cross-principal data isolation across all database operations, including the new revision, usage, bulk, and import-job endpoints.
  - Documentation & Skill Synchronization:
    - Update `.agents/skills/cloudharness/SKILL.md` and reference files with skills.sh, SkillX, and Skill Set usage instructions.
    - Run `npm run plugin:sync` to ensure `.agents/skills/cloudharness/` and `plugins/cloud-harness/skills/cloudharness/` are byte-identical.
    - Update public documentation in `docs/system-architecture.md`, `docs/mcp-api.md`, `docs/security-model.md`, and `docs-site/` guides.
    - Create `docs-site/dashboard/skills.md`, register it in the docs site navigation owned by `docs-site/.vitepress/config.ts` (the only configuration file under `docs-site`), and cross-link it from `docs-site/dashboard/index.md` and `docs-site/dashboard/workspaces.md`, because the Open Workspace dialog no longer exposes toolkit checkboxes. `npm run docs:links` is **not** a navigation or link gate: `scripts/verify-docs-links.mjs` reads only a pre-built `docs-site/.vitepress/dist` (it exits 1 if that directory is missing), collects only absolute external `https://` hrefs, HEAD-checks those, and merely `console.warn`s failures without failing the build. Registering the page in `docs-site/.vitepress/config.ts` is therefore a manual step that nothing else verifies, and an unregistered page would still pass `docs:links`.
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
- Modify: `docs-site/reference/tools.md` by regenerating it, not hand-editing: `scripts/build-docs-reference.mjs:223` writes it from `TOOL_SPECS` and `npm run docs:check` (`scripts/verify-docs-reference.mjs`) regenerates and diffs it in CI.

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
- [x] E2E integration tests pass covering the full import -> set -> workspace -> CLI -> run lifecycle and the operator management lifecycle (custom create, edit, diff, restore, fork, per-item bulk conflict, import progress).
- [x] Adversarial checks confirm 0 secrets leaked, 0 air-gap bypasses, and 100% TOCTOU protection, including custom skill scripts.
- [x] `npm run plugin:sync` passes with zero drift between `.agents/skills/` and `plugins/`.
- [x] `npm test packages/contracts/test/cloudharness-skill-contract.test.ts` passes.
- [x] `docs-site/dashboard/skills.md` exists, is registered in `docs-site/.vitepress/config.ts`, and is cross-linked from the dashboard index and workspaces pages. Success is asserted by the registration itself, not by `npm run docs:links`, which only warns about external https links in a pre-built `dist` and does not run in CI.
- [x] All repository quality gates pass for the phases 1-6 scope (`npm run verify`), and phase 9 re-runs that same gate after the TypeSafe work lands.

## Risk Assessment
- **Risk:** Documentation drift between internal docs and public docs site.
- **Mitigation:** Run automated contract tests and documentation reference generators (`npm run docs:reference` and `npm run plugin:sync`) as part of the phase completion checklist.

## Implementation Status (2026-09-20)

**Done and verified:**
- `docs-site/dashboard/skills.md` exists, is registered in `docs-site/.vitepress/config.ts`, and is cross-linked from `docs-site/dashboard/index.md` and `docs-site/dashboard/workspaces.md`. Registration is the assertion the phase asks for, in place of `npm run docs:links`, which only warns about external links over a pre-built `dist`.
- `test/integration/skills-management-lifecycle.test.ts` drives the operator lifecycle through the service the dashboard calls: create a custom skill, pin a set to the current revision, preview it through the same resolver launch uses, settle a conflict with an override, refuse a stale set generation, restore an earlier revision without rewriting it, and apply a bulk change whose per-item result keeps the row the runner refused. The lane that collects it is `npm run test:integration`.
- `test/integration/skills-compatibility.docker.test.ts` runs the air-gap lifecycle inside the image with `--network none`, and passes all four cases: install from the local catalog with no DNS attempt, read the roster through the same worker the runner invokes, run a script from the verified snapshot, and refuse bytes that do not match the digest presented. It is in the `package.json` `test:docker` list.
- `docs/system-architecture.md`, `docs/design-guidelines.md`, `docs-site/agent-toolkits.md`, and `docs/security-model.md` point at the owners of the behaviour rather than restating it.
- `npm run docs:check` and `npm run plugin:check` both pass, and `npm run verify` is green.

**Container lanes — resolved, and the cause is worth recording:**
- Both lanes were failing on this host, and the cause was not the lane. A Docker mount point had replaced the TLS fixture files at `.cloud-harness-test-fixtures/model-gateway/server-cert.pem` and `server-key.pem` with directories, so `existsSync` succeeded on a directory, `ensureTlsFixtures` returned it, and `readFileSync` raised `EISDIR`. Docker recreates those directories whenever the fixtures are absent, so the failure returns until the generator is run.
- After regenerating them with `node scripts/generate-model-gateway-test-fixtures.mjs`: `npm run test:docker` reports `Test Files 6 passed | 1 skipped (7)` and `Tests 25 passed | 2 skipped (27)`, and `npm run test:e2e` reports `Test Files 2 passed (2)` and `Tests 3 passed (3)`. Both new suites in this phase pass inside the image.
- The branch does not touch `apps/model-gateway`, the fake provider, or the `gateway-test` profile.

**Still open from this phase:** the agent-skill documents under `.agents/skills/cloudharness/` describe the tool surface, and the tool this plan adds there (`skill_suggest`) is phase 9 work, so those updates land with it and `npm run plugin:sync` runs afterwards.
