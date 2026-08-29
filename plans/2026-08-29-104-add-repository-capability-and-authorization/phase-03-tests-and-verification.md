# Phase 3: Tests and Verification

## Objectives
1. Contract tests in `packages/contracts/test/contracts.test.ts`:
   - Validate `workspace_capabilities` schema accepts `{ workspaceId?: string }`.
   - Validate `ErrorCodeSchema` accepts `'REPOSITORY_OPERATION_NOT_AUTHORIZED'`.
   - Validate `ToolResultSchema` parses `error` with `operation`, `repository`, and `requiredCapability`.
2. Unit tests in `apps/runner/test/workspace-capabilities.test.ts`:
   - Test capability resolution in `owner-bearer` mode with GitHub App installation (push=true, PRs/issues=true).
   - Test capability resolution in `owner-bearer` mode without GitHub App installation (push=false, PRs/issues=false).
   - Test capability resolution in `cloudflare-access` mode with `write` grant (push=true, PRs/issues=true).
   - Test capability resolution in `cloudflare-access` mode with `read` grant (push=false, PRs/issues=false).
   - Test capability resolution in `cloudflare-access` mode with no grant (push=false, PRs/issues=false).
   - Test `workspace_open`, `workspace_status`, and `workspace_context` response data contain capabilities.
   - Test structured error when `git_push` is executed without write authorization (contains `code: 'REPOSITORY_OPERATION_NOT_AUTHORIZED'`, `operation: 'git_push'`, `requiredCapability: 'repository.push'`).
   - Test structured error when `github_action` is executed without grant.
3. Unit tests in `apps/api/test/local/local-capabilities.test.ts`:
   - Test `workspace_capabilities` with `--git-push` enabled vs disabled.
   - Test `workspace_capabilities` with `--git-network` enabled vs disabled.
   - Test `git_push` unauthorized error returns structured error with `requiredCapability: 'repository.push'`.
4. Run complete unit and integration tests (`npm test`).

## Verification
- `npm test` passing with 100% green tests across all suites.
