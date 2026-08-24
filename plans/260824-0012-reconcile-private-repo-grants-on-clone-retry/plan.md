---
title: "Reconcile Private GitHub Repository Grants Before Clone Retry"
description: "Reconcile stale Cloudflare Access GitHub App installation grants and retry cloning once with a repository-scoped token on anonymous clone failure."
status: completed
priority: P1
effort: "2h"
tags: ["runner", "github-broker", "private-repo", "clone-helper", "cloudflare-access", "tdd"]
created: 2026-08-24
issue: 86
---

# Reconcile Private GitHub Repository Grants Before Clone Retry

- **Status**: Completed
- **Slug**: `reconcile-private-repo-grants-on-clone-retry`
- **Branch**: `fix/private-repo-clone-reconcile`

---

## 1. Executive Summary & Problem Statement

In Cloudflare Access mode, `mintPrincipalRepositoryToken()` returns `undefined` when a principal lacks cached repository grants, allowing anonymous clone for public repositories without requiring GitHub App installation bindings.

However, when a private GitHub repository is cloned:
1. `mintPrincipalRepositoryToken()` returns `undefined` if grants are not yet cached or are stale.
2. `clone-helper` performs an anonymous `git clone`.
3. Private repo requires authentication, failing with `fatal: could not read Username for 'https://github.com': terminal prompts disabled`.

The solution reconciles the principal's GitHub App installation grants upon anonymous clone failure and retries cloning once with a freshly minted repository-scoped token.

---

## 2. Roadmap & Phase Breakdown

| Phase | Title | Focus Area | Status | Priority |
| :--- | :--- | :--- | :--- | :--- |
| **Phase 01** | [Reconcile Private Repo Grants On Clone Retry](phase-01-reconcile-private-repo-grants-on-clone-retry.md) | `WorkspaceService` binding integration, stale grant refresh, bounded retry, TDD test suite | In Progress | P1 |

---

## 3. Architectural Invariants & Security Constraints

- **Strict Principal Isolation**: Never use a global or static GitHub App fallback for Cloudflare Access principals. Only reconcile when the requesting principal already has an active GitHub App installation bound for the target repo owner.
- **Single Retry Bound**: The reconciliation and authenticated clone attempt is strictly bounded to one retry.
- **Token Hygiene**: Installation tokens are passed exclusively via stdin to the ephemeral `clone-helper` container and never written to workspace files, `.git/config`, process arguments, or logs.
- **Clean Workspace State**: If the initial anonymous clone leaves partial or corrupted files in `/job/repo`, the directory is safely cleaned up before the authenticated clone retry.
- **Fast Path Preservation**: Public repositories cloning anonymously succeed on the first attempt without triggering reconciliation overhead.

<!-- slug: reconcile-private-repo-grants-on-clone-retry -->
