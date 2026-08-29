# Plan: feat: add repository capability and authorization preflight (Issue #104)

## Summary
Add workspace and repository capability introspection and structured authorization preflight errors to Cloud Harness MCP. This enables AI coding agents to determine upfront whether repository write operations (such as `git_push`, pull request creation, and issue management) are authorized before performing expensive modification workflows, and ensures authorization denials provide structured, machine-readable error metadata.

## Context & Architecture
CloudHarness is a private, single-owner remote coding harness supporting both Docker-isolated remote runners (`WorkspaceService`) and local stdio execution (`LocalWorkspaceBackend`). Authorization relies on:
1. Workspace execution policy and network mode (`none` vs `bridge` vs `host`).
2. GitHub App credentials and principal-bound repository grants in `cloudflare-access` mode, or configured installation in `owner-bearer` mode.
3. Local startup authorization flags (`--git-push`, `--git-network`) in local stdio mode.

Prior to this feature, authorization was discovered lazily at operation execution time (e.g. `git_push` failing after changes were already committed). This plan adds:
- `workspace_capabilities` MCP tool and capability introspection on `workspace_open`, `workspace_status`, and `workspace_context`.
- High-level capability objects (`capabilities.repository`, `capabilities.workspace`) matching Issue #104 expected behavior.
- Fine-grained permission and operation matrices (`permissions`, `operations`) matching Issue #104 suggested API.
- Structured authorization error payload (`code: 'REPOSITORY_OPERATION_NOT_AUTHORIZED'`, `operation`, `repository`, `requiredCapability`) on operation denial.

## Phases

### Phase 1: Contracts and Schemas
- Add `'REPOSITORY_OPERATION_NOT_AUTHORIZED'` to `ErrorCodeSchema` in `packages/contracts/src/mcp-results.ts`.
- Extend `ToolResultSchema.error` with optional `operation`, `repository`, `requiredCapability` fields.
- Update `HarnessError` to optionally accept structured error details.
- Add `'workspace_capabilities'` to `RunnerOperationSchema` in `packages/contracts/src/runner-api.ts`.
- Define `workspace_capabilities` input schema in `packages/contracts/src/tool-schemas.ts` (`z.object({ workspaceId: WorkspaceIdSchema.optional() })`).
- Define TypeScript types and Zod schemas for `RepositoryCapabilities`, `WorkspaceCapabilities`, `RepositoryPermissions`, `RepositoryOperations`, and `WorkspaceCapabilityResult`.
- Update `TOOL_SPECS`, titles, descriptions, and tool hints (`readOnly: true`, `idempotent: true`).
- Update `packages/contracts/test/contracts.test.ts`.

### Phase 2: Runner and Local Capability Resolution & Authorization Errors
- Implement `computeWorkspaceCapabilities` helper in runner (`apps/runner/src/workspace-service.ts`):
  - Resolves repository info (`owner/repo`), GitHub App installation status, grant contents permissions (`read` vs `write`), and operational capabilities without network side-effects or token minting.
  - Dispatches `workspace_capabilities` operation in `WorkspaceService.execute` alongside `workspace_status` before `touch()`.
  - Enriches `workspace_open` (including idempotent replay paths), `workspace_status`, and `workspace_context` response data with `capabilities`, `permissions`, and `operations`.
- Update `remotePush` and `runBrokeredGitHubAction` in `apps/runner/src/workspace-service.ts`:
  - When unauthorized or token cannot be minted, return/throw structured `HarnessError` with `code: 'REPOSITORY_OPERATION_NOT_AUTHORIZED'`, `operation: 'git_push'` or `github_action.<action>`, `repository: 'owner/repo'`, and `requiredCapability: 'repository.push'` or `repository.<action>`.
- Update `sendRunnerError` in `apps/runner/src/app.ts`:
  - Propagate `operation`, `repository`, and `requiredCapability` from `HarnessError` into the HTTP JSON error response so runner client receives structured error metadata.
- Implement `workspace_capabilities` in `apps/api/src/local/local-workspace-backend.ts`:
  - Returns local capability matrix reflecting `--git-push` and `--git-network` options.
  - Aligns `capabilities.workspace` with local-mode flags (`mode: 'local'`, `platform`, `sandboxed: false`, `gitNetwork`, `gitPush`).
  - Enriches `workspace_status` with standard capability metadata.
  - Returns structured authorization errors with `requiredCapability: 'repository.push'` when `git_push` is denied.
- Update `apps/api/src/mcp-response-text.ts` to include `requiredCapability` in human-readable text output.

### Phase 3: Tests and Verification
- Unit tests in `packages/contracts/test/contracts.test.ts` for schemas, error codes, and capability types.
- Unit tests in `apps/runner/test/workspace-capabilities.test.ts`:
  - `workspace_capabilities` in `owner-bearer` mode with and without GitHub App installation.
  - `workspace_capabilities` in `cloudflare-access` mode for read-only vs read-write repository grants.
  - Capability inclusion in `workspace_open` (initial and replay), `workspace_status`, and `workspace_context`.
  - Structured authorization errors on denied `git_push` and `github_action`.
  - Error propagation through `sendRunnerError` in `apps/runner/src/app.ts`.
- Unit tests in `apps/api/test/local/local-capabilities.test.ts` for local stdio capability introspection and error payloads.
- Run full unit and integration test suite (`npm test`).

### Phase 4: Documentation, Skill Sync, and Docs Reference
- Update `docs/mcp-api.md` and `docs/security-model.md` with `workspace_capabilities` and structured authorization error contracts.
- Update `scripts/build-docs-reference.mjs` to categorize `workspace_capabilities` under `Workspace Lifecycle`.
- Run `npm run docs:reference` to regenerate `docs-site/reference/tools.md` and `docs-site/public/llms.txt`.
- Update `.agents/skills/cloudharness/references/workspace-lifecycle-and-results.md`.
- Run `npm run plugin:sync` to sync the packaged plugin skill.
- Run `npm run verify` to ensure all repo gates pass.
## Acceptance Criteria
- [x] Agents can query repository/workspace capabilities before modifying the repository via `workspace_capabilities`, `workspace_open`, `workspace_status`, or `workspace_context`.
- [x] Git push permission is represented explicitly in `capabilities.repository.push`, `permissions.contents.write`, and `operations.gitPush`.
- [x] GitHub Issues permissions are represented explicitly in `capabilities.repository.issuesRead`, `capabilities.repository.issuesWrite`, `permissions.issues`, and `operations.issue*`.
- [x] Pull Request permissions are represented explicitly in `capabilities.repository.pullRequestsRead`, `capabilities.repository.pullRequestsWrite`, `permissions.pullRequests`, and `operations.pullRequest*`.
- [x] Capabilities are scoped to the workspace's bound repository.
- [x] Capabilities reflect CloudHarness policy, not merely upstream GitHub permissions.
- [x] Authorization failures identify the missing capability with structured `code`, `operation`, `repository`, and `requiredCapability`.
- [x] Capability results are machine-readable and stable enough for agent planning.
- [x] Tests cover read-only and read/write repositories across `owner-bearer`, `cloudflare-access`, and `local` modes.
