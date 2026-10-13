# Phase 4: Brokered GitHub Actions Expansion

## Context & Objectives
Extend `github_action` to support comprehensive issue-driven workflows without leaking tokens:
- Add issue comment creation (`issue_comment`) and update (`issue_comment_update`).
- Add label creation (`label_create`) and issue label addition/removal (`issue_labels_add`, `issue_labels_remove`).
- Add issue viewing (`issue_view`), updating (`issue_update`), and listing (`issue_list`).
- Prevent duplicate comments/label operations through idempotency keys.
- Return stable canonical URLs and normalized structures.

## Affected Files
- `worker/gh-helper.sh`
- `apps/runner/src/github-app-broker.ts`
- `apps/runner/src/workspace-service.ts`
- `apps/runner/test/github-app-broker.test.ts`
- `test/integration/gh-helper.docker.test.ts`

## Implementation Steps
1. In `worker/gh-helper.sh`:
   - Add cases for `issue_comment`, `issue_comment_update`, `label_create`, `issue_labels_add`, `issue_labels_remove`, `issue_update`.
2. In `apps/runner/src/github-app-broker.ts`:
   - Mint scoped tokens with appropriate issue permissions (`issues: write`, `pull_requests: write`).
3. In `apps/runner/src/workspace-service.ts`:
   - Map each `github_action` variant to `runBrokeredGitHubAction`.
   - Add in-memory / state idempotency cache for comments.
4. Add unit and integration tests.
