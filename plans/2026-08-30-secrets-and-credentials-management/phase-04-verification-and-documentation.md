# Phase 4: Test Suite, Quality Gates & Documentation Sync

## Context & Objectives
- Run comprehensive unit, integration, and UI contract tests across all packages.
- Sync `.agents/skills/cloudharness/` and `plugins/cloud-harness/skills/cloudharness/` with new `secrets_list` tool documentation and marked examples.
- Update docs-site and generated tool references (`scripts/build-docs-reference.mjs`).
- Pass `npm run verify` completely.

## Requirements
1. **Skill & Tool Reference Sync:**
   - Add marked tool comment and example for `secrets_list` in `.agents/skills/cloudharness/references/` (e.g. `workspace-lifecycle-and-results.md` or `tool-reference.md`).
   - Run `npm run plugin:sync` to ensure byte-identical plugin packaging.
   - Verify with `npm test packages/contracts/test/cloudharness-skill-contract.test.ts`.
2. **Docs Site Sync:**
   - Update `docs-site/ai-tools/` and `docs-site/reference/` to include `secrets_list` and environment injection guidance.
   - Run `npm run docs:reference` to regenerate reference files.
3. **End-to-End Verification:**
   - Run `npm run verify` (`plugin:check`, `lint`, `typecheck`, `test`, `build`).
   - Ensure all unit and integration tests pass with zero regressions.

## Files to Modify
- `.agents/skills/cloudharness/references/tool-reference.md` (and lifecycle/automation reference)
- `plugins/cloud-harness/skills/cloudharness/` (synced)
- `docs-site/` (if tool references generated)
