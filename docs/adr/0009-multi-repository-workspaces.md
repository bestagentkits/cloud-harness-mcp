# ADR 0009: Multi-Repository Workspaces

- **Status:** Accepted
- **Date:** 2026-10-17
- **Related Issues:** Issue #404. It keeps the single-owner trust model of
  [ADR 0001](0001-multi-tenant-isolation-and-haas-ladder.md) unchanged.

## Context

Real changes often span repositories: a service and its client library, an API
and the schema package it publishes, an application and its infrastructure
repository. One workspace held exactly one checkout, so an agent had to open one
workspace per repository, pay for one executor each, juggle several leases, and
could not run a build or test that needs both trees side by side.

## Decision

One `workspace_open` may name a set of repositories. The workspace keeps one
executor, one lease, one owner, and one trust domain; only the number of Git
checkouts changes.

- **Layout.** The executor's `/workspace` mount stays the workspace tree root.
  A multi-repository workspace holds one independent checkout per alias at
  `repos/<alias>/`. A single-repository workspace keeps its checkout at the root,
  so its Docker arguments and paths are unchanged.
- **Registry.** The repository set is recorded with the workspace in the same
  admission transaction. A single-repository workspace has no registry rows; the
  runner synthesizes a deterministic entry for it, so both shapes answer the same
  selector and listing tools.
- **Selector.** Repository-aware tools take an optional `repositoryId`, which
  accepts the stable `repo_` id or the alias. Aliases cannot contain `_`, so the
  two forms never collide. Tools bound to one Git repository (Git, worktrees,
  finalize, recovery export, GitHub) require it in a multi-repository workspace
  rather than guessing. File, search, and command tools without it act on the
  tree root, so cross-repository builds still work; with it they are confined to
  that checkout through the worker's root override.
- **Per-repository brokering.** Every helper receives a record view scoped to
  the selected repository, so private-clone and push tokens are minted for that
  repository URL from the trusted registry, never from caller input.
- **Access.** `read-only` is a brokered-write policy: it refuses push, finalize
  push, recovery export, and GitHub write actions for that repository and clamps
  its advertised capabilities. It is deliberately not runtime isolation.
- **Compatibility.** The single-repository open shape, result fields, and
  idempotency fingerprints are unchanged. The resolved repository joins write
  fingerprints only in a multi-repository workspace.
- **Bound.** An operator-set per-workspace limit, inside a schema ceiling,
  bounds clone cost and disk use against the shared workspace byte ceiling.
- **Changing the set after open.** `workspace_repo_add` and
  `workspace_repo_remove` change the set of an active multi-repository
  workspace; a single-repository workspace keeps its one checkout at the root,
  because promoting it would move every path. Both hold the mutation lease,
  commit the registry change and the idempotency replay in one transaction
  fenced on the workspace generation, and are serialized per workspace. Add
  reuses the open-time policy, limit, brokered clone, and history defaults and
  registers the row only after the clone, so a failure leaves at most a
  directory it then removes, scoped to the verified `repos/<alias>` path. Remove
  reuses the auto-close unsaved-work check, adds linked worktrees (which that
  check counts only when dirty), refuses while anything runs inside the
  checkout, and deletes the row before the directory, so a failed removal
  leaves an unregistered entry that still blocks auto-close instead of a
  registered empty checkout. Agents record no repository, so any active agent
  blocks a removal.
- **Cross-repository search and artifacts.** The search tools take
  `scope: "all"` instead of a separate tool: one `maxResults` budget across
  checkouts, results attributed by `repositoryId` and alias with paths relative
  to their checkout, and a cursor that names the next repository rather than a
  position inside one, which keeps the cursor small and stateless. Artifact
  snapshots record the source repository as provenance; restore never applies
  it implicitly because the destination may be another workspace.

The executable owners are
[`apps/runner/src/workspace-repositories.ts`](../../apps/runner/src/workspace-repositories.ts),
[`apps/runner/src/workspace-service.ts`](../../apps/runner/src/workspace-service.ts),
and [`packages/contracts/src/tool-schemas.ts`](../../packages/contracts/src/tool-schemas.ts);
the user-facing contract is in [MCP usage](../mcp-api.md#multi-repository-workspaces)
and the boundary in the [security model](../security-model.md#multi-repository-workspaces).

## Rejected and deferred alternatives

- **One workspace per repository, coordinated by the client:** no shared
  filesystem for builds that need both trees, and several executors and leases
  for one task.
- **Per-repository runtime isolation (separate mounts, users, or executors):**
  would make `read-only` a real write barrier, but breaks the single shared tree
  that cross-repository builds need and multiplies executor cost. Repositories
  in one workspace already share an owner and trust domain, so the policy-only
  `read-only` mode is the honest boundary.
- **Implicit default repository for Git tools:** a silent fallback to the
  primary checkout would commit or push to the wrong repository. Requiring the
  selector fails closed with `INVALID_INPUT` instead.
- **Mounting each checkout at a different executor path:** would change the
  executor mount for every workspace; keeping `/workspace` as the tree root
  leaves single-repository workspaces byte-identical.
- **Fixing the set at open (superseded):** the first release fixed the set at
  open. Reopening a workspace to add one repository discards the executor,
  sessions, and lease, so add and remove are now decided above.
- **Converting a single-repository workspace on add (rejected):** it would move
  the root checkout into `repos/<alias>/` and break every path a caller holds.
- **Resuming a search inside a checkout (rejected):** a per-checkout offset
  would need either server-side search state or a re-run that can shift under
  concurrent edits; the caller narrows a truncated checkout with `repositoryId`.
- **Deferred:** repository-targeted guidance and hooks, and coordinated
  cross-repository pull requests, remain follow-up work.

## Consequences

- A process in the executor can read and write every checkout, including one
  opened `read-only`; reviewers must not treat `read-only` as containment.
- Local stdio mode does not support multi-repository workspaces; a local
  workspace is one directory chosen at startup.
- Auto-close and recovery inspect every checkout. Files written beside the
  checkouts, and entries under `repos/` that are not a registered checkout
  directory, block auto-close because no remote holds them.
- The registry is an additive table with no schema-version bump. A release
  that predates it ignores the table and would treat a multi-repository
  workspace as one checkout at the tree root, which is not a Git repository,
  so finish and close multi-repository workspaces before rolling back.
