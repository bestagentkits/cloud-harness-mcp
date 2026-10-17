---
status: in-progress
issue: 404
branch: claude/determined-gates-yzou9l
base: dev
---

# Multi-repository workspaces (issue #404)

## Outcome

One owner-bound workspace can hold up to N (default 5, operator-configurable)
independent Git checkouts under one executor, lease and trust domain, while every
existing single-repository open, Git, GitHub, finalize and recovery flow keeps its
exact behaviour.

## Decisions

- Layout: legacy workspaces keep `<job>/repo` mounted at `/workspace`. A
  multi-repository workspace mounts the same `<job>/repo` tree, which holds one
  independent checkout per alias at `repos/<alias>/`. The executor mount is
  therefore unchanged.
- Registry: an additive `workspace_repositories` table written in the same
  transaction that admits the workspace. Legacy rows have no registry rows; the
  resolver synthesizes a deterministic primary entry for them.
- Selector: optional `repositoryId` on repository-aware tools accepts the stable
  `repo_…` id or the alias (aliases cannot contain `_`, so the two never collide).
- Git, worktree, finalize, recovery export and GitHub tools require a selector in
  a multi-repository workspace and fail with `INVALID_INPUT` otherwise. File,
  search and command tools without a selector operate on the workspace tree root;
  with a selector they are confined to that checkout (worker root override, so
  symlinks and `..` cannot reach sibling checkouts).
- A scoped record view (`repositoryUrl`, ref and checkout subpath replaced) is what
  every existing helper receives, so token minting, transfer helpers, recovery
  helpers and capability computation resolve per repository from the trusted
  registry. Legacy calls produce byte-identical Docker arguments.
- `read-only` access blocks brokered writes (push, finalize push, GitHub write
  actions) and clamps advertised capabilities; it is not runtime isolation.
- Idempotency fingerprints for push/finalize/batch writes include the resolved
  `repositoryId` only for multi-repository workspaces, so legacy replays match.
- Auto-close and recovery status inspect every checkout and report per-repository
  reasons.

## Phases

1. Contracts: open shape, selector, new tools `workspace_repos_list` and
   `workspace_repo_status`, config key. Tests in `packages/contracts/test/`.
2. Runner persistence and resolver (`state-store.ts`, new
   `workspace-repositories.ts`), open/clone, scoped helpers, lifecycle.
3. API/local mode/Dashboard display.
4. Docs (`docs/`, `docs-site/`, skill references, ADR), reference regeneration.
5. Verification (`npm run verify`, docs checks) and isolated review.

## Follow-ups (separate issues)

- P1 dynamic `workspace_repo_add`/`workspace_repo_remove`, Dashboard repo explorer.
- P2 repository-targeted guidance/skills/hooks, coordinated cross-repo PR flow,
  benchmarks.
