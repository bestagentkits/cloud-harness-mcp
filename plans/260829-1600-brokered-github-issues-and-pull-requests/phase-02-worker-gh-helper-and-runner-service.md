# Phase 2: Worker Helper and Runner Service

## Requirements
- Update `worker/gh-helper.sh`:
  1. `pr_create`: handle draft flag (`--draft`) and optional labels (`--label`).
  2. `pr_update`: implement `gh pr edit "$pr_number"` (title, body, base) and `gh pr close` / `gh pr reopen` when state changes.
  3. `pr_comment`: implement `gh pr comment "$pr_number" --body "$body"`.
  4. `issue_create`: support optional `--label` and `--assignee`.
- Update `apps/runner/src/workspace-service.ts`:
  1. Add argument translation for `pr_create`, `pr_update`, `pr_comment`.
  2. Register `pr_update` and `pr_comment` in `isWrite` and permission scope resolver (`action.startsWith('pr_') ? 'pull_requests' : 'issues'`).
  3. Support comment idempotency caching for `pr_comment`.
  4. Ensure destructive/write operations audit decision and maintain zero-leakage token passing.

## Files to modify
- `worker/gh-helper.sh`
- `apps/runner/src/workspace-service.ts`

## Validation
- `npm run typecheck -w @cloud-harness/runner`
- `npm run test:unit`
