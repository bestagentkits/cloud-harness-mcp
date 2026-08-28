---
phase: 4
title: "Test Suite & Gate Verification"
status: completed
priority: P1
effort: "1h"
dependencies: [1, 2, 3]
---

# Phase 04: Test Suite & Gate Verification

## Overview
Update existing tests and add new tests covering the extended API key lifetimes (1–3,650 days), and run the entire repository verification suite (`npm run verify`, `npm run test`, `npm run plugin:check`).

## Requirements
- Update `packages/contracts/test/api-key-api.test.ts`:
  - Test valid creation with `expiresInDays: 3650`.
  - Test rejection of `expiresInDays: 3651`.
- Update `apps/api/test/dashboard-router.test.ts`:
  - Test API key creation endpoint accepts `expiresInDays: 3650` and forwards exact payload to runner.
  - Test rejection of `expiresInDays: 3651` without calling runner.
- Update `apps/api/test/dashboard-ui-behavior.test.ts`:
  - Verify form validation and rendering reflect new `max="3650"` bounds.
- Run full verification gates:
  - `npm run verify`
  - `npm run verify:compose`
  - `npm run docs:build && npm run docs:links`
  - `npm run plugin:check`

## Related Code Files
- Modify: `packages/contracts/test/api-key-api.test.ts`
- Modify: `apps/runner/test/api-key-store.test.ts`
- Modify: `apps/api/test/dashboard-router.test.ts`
- Modify: `apps/api/test/dashboard-ui-behavior.test.ts`

## Implementation Steps
1. Run `npm test packages/contracts` to confirm test updates pass.
2. Run `npm test apps/api` to confirm API tests pass.
3. Run `npm run plugin:sync && npm run plugin:check` to ensure skills/plugins remain synchronized.
4. Run full `npm run verify` to ensure typecheck, lint, and all test suites pass with 100% green status.

## Success Criteria
- [x] All tests pass cleanly without regressions.
- [x] `npm run verify` succeeds with 0 errors.
- [x] No unformatted or unverified code remains.

## Risk Assessment
- Risk: CI failures on PR or merge.
  - Mitigation: Run all repository gate commands locally before opening PR and before merge.
