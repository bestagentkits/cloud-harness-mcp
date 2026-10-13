---
phase: 2
title: "Dashboard UI Form Updates"
status: completed
priority: P1
effort: "1h"
dependencies: [1]
---

# Phase 02: Dashboard UI Form Updates

## Overview
Update the frontend dashboard creation form and client-side validation in `dashboard.js` and `dashboard-render.js` to allow creating up to 3,650-day (~10-year) API keys.

## Requirements
- Functional:
  - `apps/api/dashboard/dashboard.js`: Update `apiKeyCreateInput` validation to allow `expiresInDays` from 1 to 3650. Update error message to `Enter a key name and an expiry from 1 to 3650 whole days.`.
  - `apps/api/dashboard/dashboard-render.js`: Update form input attribute `max="3650"` for `expiryDays`.
- Non-functional:
  - CSRF protection: Security invariants and token verification remain strictly preserved.
  - No secret leakage: Keys remain write-only and revealed once.

## Related Code Files
- Modify: `apps/api/dashboard/dashboard.js`
- Modify: `apps/api/dashboard/dashboard-render.js`
- Modify: `apps/api/test/dashboard-ui-behavior.test.ts`
- Modify: `apps/api/test/dashboard-ui-contract.test.ts`

## Success Criteria
- [x] UI allows entering 3650 days for API key creation and passes client-side validation.
- [x] Invalid numbers (< 1, > 3650, non-integer) are rejected by client-side validation.
- [x] Rendered form specifies `max="3650"`.
