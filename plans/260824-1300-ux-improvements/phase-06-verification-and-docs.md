# Phase 6: Verification, Test Suites & Documentation

## Context & Objectives
Comprehensive verification and documentation update across internal docs and public docs-site:
- Verify all unit and integration tests across contracts, runner, api, and worker.
- Add new end-to-end and contract tests for all 7 issues.
- Update internal docs (`docs/mcp-api.md`, `docs/security-model.md`, `docs/system-architecture.md`).
- Update docs-site reference pages (`npm run docs:reference` and `npm run plugin:sync` if needed).

## Affected Files
- `test/`
- `packages/contracts/test/`
- `apps/runner/test/`
- `apps/api/test/`
- `docs/`
- `docs-site/`

## Implementation Steps
1. Run `npm test` across all workspaces.
2. Run `npm run build` and `npm run lint` / typecheck.
3. Update `docs/mcp-api.md` with new tool specifications, parameters, and examples.
4. Update `docs-site/` documentation and run `npm run docs:reference`.
