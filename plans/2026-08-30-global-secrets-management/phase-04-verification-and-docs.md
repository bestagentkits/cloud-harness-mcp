# Phase 4: Comprehensive Verification, Regression Tests & Docs Sync

## Context & Objectives
- Validate all tests across `@cloud-harness/contracts`, `@cloud-harness/runner`, `@cloud-harness/api`, and docs-site.
- Ensure skill contract compliance (`cloudharness-skill-contract.test.ts`) and plugin sync.
- Run `npm run verify` to guarantee zero regressions.

## Requirements
1. **Tests:**
   - `packages/contracts/test/contracts.test.ts`
   - `apps/runner/test/metadata-store.test.ts` (global secrets CRUD, re-encryption)
   - `apps/runner/test/workspace-secrets-redaction.test.ts` (global secrets merge & redaction)
   - `apps/api/test/dashboard-ui-contract.test.ts`
   - `apps/api/test/dashboard-ui-behavior.test.ts`
2. **Docs & Plugin Sync:**
   - Run `npm run plugin:sync`
   - Run `npm run docs:reference`
   - Run `npm run verify`
