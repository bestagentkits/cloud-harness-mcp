# Phase 2: Runner and Local Capability Resolution & Authorization Errors

## Objectives
1. Implement `computeWorkspaceCapabilities` helper in `apps/runner/src/workspace-service.ts`:
   - Accepts `record: WorkspaceRecord` and optional principal identity.
   - Parses repository URL (if GitHub: extracts `owner/repository`).
   - Checks `authMode` (`owner-bearer` vs `cloudflare-access`).
   - For `cloudflare-access`: queries `githubInstallations.getRepositoryGrant(ownerId, owner, repository)` and corresponding installation status and appId match.
   - For `owner-bearer`: checks `config.githubApp.installationId`.
   - Computes:
     - `capabilities.repository`: `{ read, push, issuesRead, issuesWrite, pullRequestsRead, pullRequestsWrite }`
     - `capabilities.workspace`: `{ shell: true, tasks: true, sessions: true, deployments: true, privileged: boolean, networkMode }`
     - `permissions`: `{ contents: { read, write }, issues: { read, write }, pullRequests: { read, write } }`
     - `operations`: `{ gitFetch, gitPull, gitPush, issueList, issueView, issueCreate, issueComment, issueUpdate, issuePublish, labelCreate, pullRequestList, pullRequestView, pullRequestCreate, execRun, privilegedExec, deploymentsRun }`
2. Implement `workspace_capabilities` handler in `WorkspaceService.execute`.
3. Enrich responses of `workspace_open`, `workspace_status`, and `workspace_context` with `capabilities`, `permissions`, and `operations`.
4. Update `remotePush` and `runBrokeredGitHubAction` in `apps/runner/src/workspace-service.ts`:
   - In `remotePush`: if token cannot be minted or push is not authorized, throw `HarnessError` with:
     - `code: 'REPOSITORY_OPERATION_NOT_AUTHORIZED'` (or `'FORBIDDEN'` with details)
     - `operation: 'git_push'`
     - `repository: '${owner}/${repository}'`
     - `requiredCapability: 'repository.push'`
   - In `runBrokeredGitHubAction`: if token cannot be minted, return/throw structured error with:
     - `operation: action`
     - `repository: '${owner}/${repository}'`
     - `requiredCapability: permissionScope === 'pull_requests' ? (isWrite ? 'repository.pullRequestsWrite' : 'repository.pullRequestsRead') : (isWrite ? 'repository.issuesWrite' : 'repository.issuesRead')`
5. Implement `workspace_capabilities` in `apps/api/src/local/local-workspace-backend.ts`:
   - Returns local capability matrix reflecting `options.gitPush` and `options.gitNetwork`.
   - Returns structured error with `requiredCapability: 'repository.push'` when `git_push` is attempted without `--git-push`.
   - Updates `workspace_status` to include the standard `capabilities`, `permissions`, and `operations` schema.
6. Update `apps/api/src/mcp-response-text.ts`:
   - If `error.requiredCapability` is present, format `(required capability: ${error.requiredCapability})` in human-readable text.

## Verification
- Unit and integration tests for runner and local capabilities.
