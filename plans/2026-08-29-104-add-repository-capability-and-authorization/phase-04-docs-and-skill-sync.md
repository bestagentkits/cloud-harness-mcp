# Phase 4: Documentation, Skill Sync, and Docs Reference

## Objectives
1. Update `docs/mcp-api.md`:
   - Document `workspace_capabilities` tool in the tool inventory and lifecycle semantics.
   - Document capability introspection in `workspace_open`, `workspace_status`, and `workspace_context`.
   - Document structured authorization error format with `REPOSITORY_OPERATION_NOT_AUTHORIZED` and `requiredCapability`.
2. Update `docs/security-model.md`:
   - Document repository capability and preflight authorization model.
3. Update `scripts/build-docs-reference.mjs`:
   - Add `workspace_capabilities` to the `Workspace Lifecycle` category.
4. Run `npm run docs:reference` to regenerate `docs-site/reference/tools.md` and `docs-site/public/llms.txt`.
5. Update `.agents/skills/cloudharness/references/workspace-lifecycle-and-results.md`:
   - Add `workspace_capabilities` tool documentation and example.
6. Run `npm run plugin:sync` to synchronize `plugins/cloud-harness/skills/cloudharness`.
7. Run `npm run verify` (checks plugin sync, lint, typecheck, tests, and build).

## Verification
- `npm run plugin:check`
- `npm run docs:check` (if applicable)
- `npm run verify`
