# Phase 4: API, Dashboard, Cloud Harness Skill & Documentation

## Context Links
- `apps/api/src/dashboard-response.ts`
- `apps/api/dashboard/dashboard-render.js`
- `apps/api/src/local/local-workspace-backend.ts`
- `.agents/skills/cloudharness/SKILL.md`
- `docs/security-model.md`
- `docs/configuration.md`
- `docs/mcp-api.md`
- `docs-site/`

## Requirements
1. **API & Dashboard Sanitization:**
   - Update `dashboard-response.ts` to expose `networkProfile` instead of `networkMode`.
   - Update `dashboard-render.js` to render network badges: `No network` vs `Dependency access (public DNS/HTTP/HTTPS)`.
   - Display prominent warning badge when `dependency-access` is active.
2. **Local Stdio Backend:**
   - Update `local-workspace-backend.ts` to report `networkProfile: 'local-host'` for local capability transparency.
3. **Skill & Docs Updates:**
   - Update `.agents/skills/cloudharness/SKILL.md` and reference docs.
   - Run `npm run plugin:sync` to ensure byte-identical synchronization.
   - Update `docs/security-model.md`, `docs/configuration.md`, `docs/mcp-api.md`.
   - Update `docs-site/` guides and reference tables.

## Verification
- `npm run verify:docs` / `npm test packages/contracts/test/cloudharness-skill-contract.test.ts`
