---
title: Git Transfer Semantics
description: Deep dive on credential-isolated remote Git fetch, pull, and push helpers.
---

# Git Transfer Semantics

Cloud Harness MCP enforces strict isolation between repository execution containers and GitHub credentials.

## The Transfer Problem

Standard coding agent sandboxes either:
1. Embed the user's GitHub Personal Access Token or SSH key directly into the container filesystem or environment (allowing arbitrary scripts or dependencies to steal the credential), or
2. Forbid remote push entirely, requiring manual user intervention.

## The Sibling Helper Solution

Cloud Harness solves this with an **ephemeral sibling Git helper**:

```
[ Workspace Container ] (no network, no token)
       ▲
       │ (local disk mount)
       ▼
[ Host Repo Directory ]
       ▲
       │ (local disk mount)
       ▼
[ Sibling Git Helper ] ──(token over stdin)──► [ github.com:owner/repo.git ]
```

1. The agent invokes `git_push(refspec, forceWithLease?, expectedRemoteOid?, expectedAbsent?, delete?, idempotencyKey?)`.
2. The Runner starts an ephemeral Alpine container with network access scoped only to `github.com`.
3. The Runner streams an installation token over `stdin` into the helper's `git-credential` helper.
4. The helper executes the push against the remote origin and immediately exits.
5. The container is destroyed. The token is never written to disk or `.git/config`.

## Compare-and-Swap (CAS) & Concurrency Control

- **`git_commit` HEAD Guard (`expectedHeadOid`):** Prevents commits on top of unexpected intermediate state. If the workspace HEAD has moved, the commit is rejected with `STALE_HEAD`.
- **`git_push` Force-with-Lease (`expectedRemoteOid`):** Pushes with `forceWithLease: true` require `expectedRemoteOid` or `expectedAbsent`. If the remote branch has diverged, the push fails with `CONFLICT` to prevent silent overwrites.
- **Atomic branch locks:** The lease is checked by GitHub's receiving server, so a branch works as a distributed lock:

  | Operation | Input | Fails with `CONFLICT` when |
  | --- | --- | --- |
  | Create only | `refspec: "HEAD:merge-lock"`, `forceWithLease: true`, `expectedAbsent: true` | the branch already exists |
  | Compare-and-swap | `refspec: "HEAD:merge-lock"`, `forceWithLease: true`, `expectedRemoteOid: "<oid>"` | the branch no longer points at `<oid>` |
  | Delete if match | `refspec: "merge-lock"`, `delete: true`, `forceWithLease: true`, `expectedRemoteOid: "<oid>"` | the branch no longer points at `<oid>` |

- **Refspec policy:** the source is `HEAD` or a branch name; the destination is a branch name or `refs/heads/...`. Tags, notes, other `refs/` namespaces, `+` force refspecs, `..`, `@{`, option-like values, and `:`-prefixed delete refspecs are rejected; deletion is possible only through `delete` with a lease. A push GitHub refuses by policy (`[remote rejected]`: branch protection, rulesets, hooks) returns non-retryable `FORBIDDEN`, or `GITHUB_PERMISSION_MISSING` when it changes `.github/workflows` without the Workflows permission. Fast-forwarding a protected branch such as `dev` succeeds only when GitHub's rules allow it (required checks already passing on the commit, and no pull-request requirement unless the App may bypass it).

## Idempotency & Unknown-Outcome Recovery

Network failures or runner restarts during a push can leave the client unsure whether the commit reached the remote repository.

1. Supply an `idempotencyKey` on the initial `git_push` or `workspace_finalize` call.
2. If a transport timeout or network drop occurs, the runner returns `UNKNOWN_REMOTE_STATE` with `resumeAction: "reconcile_push"`.
3. Retrying the identical request with the same `idempotencyKey` triggers automatic remote-ref reconciliation (`git ls-remote` probe). If the commit already landed on the remote branch, the call returns success with `alreadyFinalized: true` without pushing duplicate commits.

## Owner-Scoped Repository Cache

When `enableRepoCache` is enabled, the runner maintains bare Git repository caches partitioned strictly by the authenticated principal ID. Initial clones use `git clone --reference-if-able <cache> --dissociate` to leverage shared local object storage while ensuring that each workspace has a fully detached, independent, and isolated working tree.
