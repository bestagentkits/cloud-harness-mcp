---
phase: 3
title: "Dashboard BFF and Public Contracts"
status: completed
priority: P1
effort: "1.5h"
dependencies: [1, 2]
---

# Phase 3: Dashboard BFF and Public Contracts

## Overview
Extend the metadata operations and dashboard BFF to handle multiple GitHub App installations per principal. Update `DashboardControlService` on the runner, `MetadataRunnerOperationSchema` / `MetadataRunnerRequestSchema` in contracts, `mapDashboardData` and `githubStatus` in API response mapping, and `dashboard-control-router.ts`.

## Requirements
- Functional:
  - Contracts (`packages/contracts/src/internal-runner-api.ts`):
    - Support `github_status` returning `installations: [...]` and `repositories: [...]`.
    - Support `github_reconcile` (optionally accepting `installationId`).
    - Add `github_disconnect` operation with `installationId: string`.
  - Runner (`apps/runner/src/dashboard-control-service.ts`):
    - `githubStatus` returns:
      ```ts
      {
        configured: boolean;
        installations: GitHubInstallationRecord[];
        repositories: GitHubRepositoryGrantRecord[];
      }
      ```
    - Handle `github_disconnect` operation: removes the installation and its repository grants, recording audit event `github.disconnected`.
    - `github_setup_complete` and `github_reconcile` return updated `githubStatus`.
  - API BFF (`apps/api/src/dashboard-response.ts`):
    - Update `githubStatus` mapper to sanitize and pick fields for each item in `data.installations` as well as `data.repositories`.
    - Maintain backwards compatibility for `data.installation` (e.g. `installations[0] ?? null`) if needed, while primary array is `installations`.
    - Map `github_disconnect` operation responses.
  - API Control Router (`apps/api/src/dashboard-control-router.ts`):
    - `GET /api/v1/github` -> `github_status`
    - `POST /api/v1/github/setup` -> `github_setup_begin`
    - `POST /api/v1/github/complete` -> `github_setup_complete`
    - `POST /api/v1/github/reconcile` -> `github_reconcile` (with optional `installationId` in body)
    - `DELETE /api/v1/github/installations/:installationId` or `POST /api/v1/github/disconnect` -> `github_disconnect`
- Non-functional:
  - Input validation with Zod schemas.
  - Consistent error responses and audit logging.

## Related Code Files
- Modify: `packages/contracts/src/internal-runner-api.ts`
- Modify: `packages/contracts/test/internal-runner-api.test.ts`
- Modify: `apps/runner/src/dashboard-control-service.ts`
- Modify: `apps/runner/test/dashboard-control-service.test.ts`
- Modify: `apps/api/src/dashboard-response.ts`
- Modify: `apps/api/src/dashboard-control-router.ts`
- Modify: `apps/api/test/dashboard-router.test.ts`

## Implementation Steps (TDD)
1. **Tests First:**
   - In `packages/contracts/test/internal-runner-api.test.ts`: test schema parsing for `github_disconnect` and `github_reconcile`.
   - In `apps/runner/test/dashboard-control-service.test.ts`: test `github_status` returns all installations; test `github_disconnect` removes specific installation and emits audit log; test `github_reconcile` iterates installations.
   - In `apps/api/test/dashboard-router.test.ts`: test `/api/v1/github` response mapping; test disconnect route.
2. **Implement Contracts:**
   - Update `internal-runner-api.ts`.
   - Run `npm run build -w @cloud-harness/contracts`.
3. **Implement Runner Dashboard Control Service:**
   - Update `apps/runner/src/dashboard-control-service.ts`.
4. **Implement API Response Mapping & Routes:**
   - Update `apps/api/src/dashboard-response.ts` and `apps/api/src/dashboard-control-router.ts`.
5. **Run and Verify Tests:**
   - `npx vitest run packages/contracts/test/internal-runner-api.test.ts apps/runner/test/dashboard-control-service.test.ts apps/api/test/dashboard-router.test.ts`

## Success Criteria
- [x] Contract schemas validate multi-installation status and disconnect operations.
- [x] Runner control service returns full array of installations and handles disconnect.
- [x] API routes map and sanitize response payloads properly.
- [x] All tests in contracts, runner, and API pass.

## Risk Assessment
- *Risk:* Breaking API schema expectations if existing frontend code expects `installation` object instead of `installations` array.
  *Signal:* Dashboard UI error or test assertion failure on `response.data.installation`.
  *Mitigation:* Include both `installations` (canonical array) and `installation` (first item or null for backward compatibility) in the mapped response.
