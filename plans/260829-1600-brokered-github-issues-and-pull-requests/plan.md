# Plan: Brokered GitHub Issues and Pull Request Operations

## Overview
Implement typed, brokered GitHub Pull Request and Issue operations for CloudHarness MCP workspaces, enabling complete autonomous end-to-end workflows (inspect -> edit -> commit -> push -> PR / issue creation/management) without exposing credentials inside the workspace executor.

## Status
- **Status:** completed
- **Mode:** official
- **Route:** feature
- **Issue:** #105
- **Branch:** mrgoonie/feat-add-brokered-github-issues-and-pull-request

## Phases
1. [Phase 1: Contracts and Tool Schemas](phase-01-contracts-and-schemas.md) - Extend `github_action` schemas with `pr_update`, `pr_comment`, `pr_create.draft`, and `issue_create` metadata.
2. [Phase 2: Worker Helper and Runner Execution](phase-02-worker-gh-helper-and-runner-service.md) - Update `worker/gh-helper.sh` and `apps/runner/src/workspace-service.ts` with action handlers, idempotency tracking, and write categorization.
3. [Phase 3: Unit and Integration Test Suite](phase-03-tests-and-verification.md) - Comprehensive unit tests for contract validation, runner execution, idempotency, and error handling.
4. [Phase 4: Documentation and Plugin Sync](phase-04-documentation-and-sync.md) - Update `docs/mcp-api.md`, `docs/security-model.md`, `docs-site/`, and run reference generators.

## Acceptance Criteria
- [x] `github_action` supports `pr_list`, `pr_view`, `pr_create` (including draft PRs), `pr_update` (title, body, base, state), and `pr_comment` (with idempotency support).
- [x] `github_action` supports `issue_list`, `issue_view`, `issue_create` (with labels/assignees), `issue_update`, `issue_comment`, `issue_comment_update`, `label_create`, `issue_labels_add`, `issue_labels_remove`, and `issue_publish`.
- [x] Security guarantees preserved: tokens never leak to executor workspace, target repo strictly bound to workspace, least-privilege token scopes.
- [x] All unit and integration tests pass.
- [x] Public documentation and docs site updated in sync.
