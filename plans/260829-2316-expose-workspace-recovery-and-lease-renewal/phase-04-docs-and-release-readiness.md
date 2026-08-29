---
phase: 4
title: "Documentation, Reference Sync & Release Readiness"
status: pending
priority: P1
effort: "1h"
dependencies: [1, 2, 3]
---

# Phase 4: Documentation, Reference Sync & Release Readiness

## Overview
Update public documentation in `docs/mcp-api.md` and `docs-site/`, synchronize generated references (`npm run docs:reference` and `npm run plugin:sync`), and perform the complete project verification suite (`npm run verify`).

## Requirements
- Functional:
  - `docs/mcp-api.md`: document `workspace_recover` modes (`resume`, `status`, `patch`, `export`), `workspace_lease_renew`, `availableActions`, and the `ACTIVE → EXPIRED_RECOVERABLE → CLOSED` lifecycle.
  - `docs-site/reference/tools.md`: ensure generated tools reference documents the updated schemas, defaults, and descriptions.
  - `docs-site/ai-tools/` or relevant guides: update any MCP lifecycle guides.
  - Run `npm run docs:reference` to regenerate reference files.
  - Run `npm run plugin:sync` to ensure plugin skills reflect current tool contracts.
- Non-functional:
  - Clean docs build (`npm run docs:build`).
  - Strict compliance with `npm run verify`.

## Architecture
- Documentation files:
  - `docs/mcp-api.md`
  - `docs/system-architecture.md` (if lifecycle diagrams mention recovery)
  - `docs-site/` documentation and tool references
- Scripts:
  - `scripts/build-docs-reference.mjs`
  - `scripts/sync-cloudharness-plugin-skill.mjs`

## Related Code Files
- Modify: `docs/mcp-api.md`
- Modify: `docs-site/reference/tools.md`
- Modify: `docs-site/ai-tools/claude-code.md` (or other docs-site pages)

## Implementation Steps
1. Update `docs/mcp-api.md` with explicit details on:
   - `workspace_recover`: `resume` (default), `status`, `patch`, `export`.
   - `workspace_lease_renew`: extending active and recoverable workspace leases.
   - `availableActions` metadata in `workspace_status` and `publicRecord`.
   - Detailed lifecycle flow: `ACTIVE` → `EXPIRED_RECOVERABLE` (grace period) → `CLOSED`.
2. Run `npm run docs:reference` to update generated tool documentation.
3. Run `npm run plugin:sync` to sync plugin skills.
4. Run `npm run verify` to ensure lint, typecheck, tests, and builds all pass.

## Success Criteria
- [ ] `docs/mcp-api.md` accurately documents the recovery and lease renewal lifecycle.
- [ ] Generated references in `docs-site/` match tool contracts.
- [ ] `npm run verify` completes with 0 errors.

## Risk Assessment
- Risk: Reference sync scripts might fail if tool contracts have formatting discrepancies.
- Mitigation: Verify tool schema types and run `npm run docs:reference` and `npm run plugin:check` locally.
