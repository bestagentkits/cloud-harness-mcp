# Phase 6: Verification Docs and Ship

## Context Links
- `.agents/skills/cloudharness/SKILL.md`
- `.agents/skills/cloudharness/references/`
- `docs/`
- `docs-site/`

## Requirements
1. Sync Cloud Harness Skill & Plugin:
   - Update `.agents/skills/cloudharness/SKILL.md` with new `knowledge_*` tools guidance.
   - Run `npm run plugin:sync` to ensure byte-identity across plugins and agent skills.
   - Verify `packages/contracts/test/cloudharness-skill-contract.test.ts`.
2. Documentation:
   - Update `docs/mcp-api.md`, `docs/system-architecture.md`.
   - Update `docs-site/` guides for Memories & Journals.
3. Full Verification:
   - Run `npm run test:unit`, `npm run lint`, `npm run typecheck`.
   - Run code review and ship via conventional commits.

## Validation
- `npm run test:unit`
- `npm run lint`
- `npm run typecheck`
