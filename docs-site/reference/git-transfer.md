---
title: Git Transfer Semantics
description: Deep dive on credential-isolated remote Git fetch, pull, and push helpers.
---

# Git Transfer Semantics

<div class="md-twin-hint">
  <strong>AI Crawler / Raw View:</strong> Fetch this page as raw Markdown at <code>/reference/git-transfer.md</code>.
</div>

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

1. The agent invokes `git_push(refspec, forceWithLease?, expectedRemoteOid?)`.
2. The Runner starts an ephemeral Alpine container with network access scoped only to `github.com`.
3. The Runner streams an installation token over `stdin` into the helper's `git-credential` helper.
4. The helper executes the push against the remote origin and immediately exits.
5. The container is destroyed. The token is never written to disk or `.git/config`.
