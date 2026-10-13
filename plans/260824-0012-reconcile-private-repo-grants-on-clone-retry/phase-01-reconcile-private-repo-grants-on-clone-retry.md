# Phase 01: Reconcile Private Repo Grants On Clone Retry

## Context & Requirements

- In Cloudflare Access mode, anonymous clone is attempted when `repositoryToken()` yields `undefined`.
- For private repositories with an existing bound GitHub App installation on the principal, grant reconciliation refreshes the installation state from GitHub API and mints a repository-scoped token.
- Retry is executed once with the token; if it fails or if no installation exists, the failure is surfaced cleanly.

## Modified & Created Files

- `apps/runner/src/index.ts`: Pass `githubBinding` service into `WorkspaceService`.
- `apps/runner/src/workspace-service.ts`: Implement `refreshRepositoryToken` and single-retry flow with partial cleanup.
- `apps/runner/test/private-repo-clone-reconcile.test.ts`: TDD test suite validating the reconciliation retry and isolation invariants.

## Implementation Details

1. **Service Constructor Injection**: Inject optional `githubBinding: GitHubBindingService` into `WorkspaceService`.
2. **Reconciliation & Token Refresh**:
   - Verify `authMode === 'cloudflare-access'`.
   - Verify `githubInstallations`, `githubBinding`, and `config.githubApp` are configured.
   - Verify target repo host is `github.com`.
   - Find active installation matching repo owner for the principal `ownerId`.
   - Call `githubBinding.reconcile(ownerId, undefined, installation.installationId)`.
   - Mint token via `mintPrincipalRepositoryToken({ config, principalId, repositoryUrl, installations, requiredPermission: 'read' })`.
3. **Bounded Clone Retry**:
   - Run initial anonymous clone.
   - If exit code is non-zero and no token was provided, attempt `refreshRepositoryToken`.
   - If token is obtained, safely remove partial `/job/repo` directory and retry `runClone(repositoryToken)`.
   - If retry fails or no token obtained, throw sanitized `HarnessError('UNAVAILABLE', ...)`.

## Verification & Quality Gates

- `npm run build -w @cloud-harness/contracts`
- `npx vitest run apps/runner/test/private-repo-clone-reconcile.test.ts`
- `npx vitest run apps/runner/test --exclude '**/*.docker.test.ts'`
- `npm run typecheck`
- `npm run lint`
