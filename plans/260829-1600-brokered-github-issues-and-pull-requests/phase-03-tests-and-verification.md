# Phase 3: Tests and Verification

## Requirements
- Add comprehensive unit tests in `apps/runner/test/brokered-github-operations.test.ts` or `ux-improvements.test.ts` covering:
  1. `pr_create` with draft flag and labels.
  2. `pr_update` updating title, body, base, and closing/reopening PR.
  3. `pr_comment` adding comment and verifying idempotency key behavior.
  4. `issue_create` with labels and assignees.
  5. Permission scopes (`pull_requests: write`, `issues: write`).
  6. Idempotency key conflict / mismatch detection.
  7. Ephemeral helper invocation and zero-token leakage guarantees.

## Files to modify/create
- `apps/runner/test/brokered-github-operations.test.ts`
- `packages/contracts/test/contracts.test.ts`

## Validation
- `npm run test:unit`
- `npm run test:integration`
