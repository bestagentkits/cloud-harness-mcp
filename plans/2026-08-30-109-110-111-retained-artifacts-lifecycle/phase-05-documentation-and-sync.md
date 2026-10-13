# Phase 5: Documentation and Sync

## Context Links
- [`docs/mcp-api.md`](../../docs/mcp-api.md)
- [`docs/system-architecture.md`](../../docs/system-architecture.md)
- [`docs/security-model.md`](../../docs/security-model.md)
- [`scripts/build-docs-reference.mjs`](../../scripts/build-docs-reference.mjs)
- [`docs-site/`](../../docs-site/)
- [`.agents/skills/cloudharness/`](../../.agents/skills/cloudharness/)
- [`plugins/cloud-harness/skills/cloudharness/`](../../plugins/cloud-harness/skills/cloudharness/)

## Requirements
1. **Internal Architecture & Security Docs:**
   - Update `docs/mcp-api.md` to document the 5 public artifact MCP tools, their lifecycle, bounded range reads, workspace restore semantics, and distinguish Git vs Workspaces vs Memories vs Artifacts.
   - Update `docs/system-architecture.md` and `docs/security-model.md` to reflect the public artifact lifecycle and restore path confinement.
2. **Docs Site & Reference Generator:**
   - Update `scripts/build-docs-reference.mjs` to add the 'Retained Artifacts' category with the 5 tools.
   - Run `npm run docs:reference` to regenerate `docs-site/reference/tools.md` and public schemas.
   - Update `docs-site/` guides (e.g. `docs-site/dashboard/artifacts.md`, `docs-site/ai-tools/`).
   - Run `npm run docs:check` and `npm run docs:build`.
3. **Cloud Harness Skill & Packaging:**
   - Update `.agents/skills/cloudharness/SKILL.md` and `.agents/skills/cloudharness/references/` with guidance on artifact snapshot, list, read, restore, and delete for cross-session agent handoffs.
   - Run `npm run plugin:sync` to synchronize to `plugins/cloud-harness/skills/cloudharness/`.
   - Run `npm run plugin:check` to verify skill integrity.

## Validation
- `npm run docs:check`
- `npm run docs:build`
- `npm run plugin:check`
