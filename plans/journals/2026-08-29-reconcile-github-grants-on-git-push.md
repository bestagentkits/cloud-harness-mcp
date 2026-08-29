---
title: Reconcile GitHub repository grants on git_push
date: 2026-08-29
summary: Automatically reconcile and refresh GitHub App installation grants when write tokens are missing or stale during git_push
---

# Reconcile GitHub repository grants on git_push

Automatically reconcile and refresh GitHub App installation grants when write tokens are missing or stale during `git_push`.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.

## Problem & Root Cause

When a workspace was opened on a public repository (or a repository added after initial GitHub App binding), the initial clone ran anonymously without caching repository grants in SQLite. When the user subsequently committed changes and called `git_push` (or `workspace_finalize`), `WorkspaceService` called `mintPrincipalRepositoryToken` with `requiredPermission: 'write'`.

Because no grant was yet recorded or the cached grant was stale/read-only, `mintPrincipalRepositoryToken` threw `FORBIDDEN: GitHub repository access is not authorized` without attempting grant reconciliation with GitHub API. Additionally, `refreshRepositoryToken` hardcoded `requiredPermission: 'read'` and was only invoked upon clone failure.

## Solution & Implementation

1. Updated `refreshRepositoryToken` in `apps/runner/src/workspace-service.ts` to accept `permission: 'read' | 'write' = 'read'`.
2. Updated `repositoryToken` in `apps/runner/src/workspace-service.ts` so that when `permission === 'write'` and the initial token minting fails or throws, it calls `refreshRepositoryToken(ownerId, repositoryUrl, 'write')` to reconcile grants from GitHub API via `GitHubBindingService` before failing.
3. Added a comprehensive test suite in `apps/runner/test/git-push-reconcile.test.ts` covering:
   - `git_push` grant reconciliation when write token is not cached (reproducing the initial `FORBIDDEN` rejection and verifying refreshed write-token minting).
   - Fast-path verification when write grant is already cached.
   - Clean failure when principal has no matching GitHub App installation.
   - Clean failure when reconciled installation has only read-only permissions for the repository.

## Verification

- `npm run verify` passed: 59 test files, 414 tests green.
- `npx vitest run apps/runner/test/git-push-reconcile.test.ts` passed (4/4 tests).
- `npx vitest run apps/runner/test/private-repo-clone-reconcile.test.ts` passed (3/3 tests).
