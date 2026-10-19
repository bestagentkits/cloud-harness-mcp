---
status: done
issue: 408
branch: feat/408-dynamic-repositories
base: dev
---

# Dynamic repositories and repository explorer (issue #408)

## Outcome

A multi-repository workspace can gain and lose checkouts after open, search all
checkouts with attributed results, snapshot/restore artifacts per repository,
and the Dashboard lets the owner browse, inspect and operate one repository at a
time.

## Decisions

- `workspace_repo_add` / `workspace_repo_remove` apply only to multi-repository
  workspaces; a single-repository workspace (checkout at the tree root) refuses
  with `INVALID_INPUT`. Removing the last repository is refused.
- Both are write tools fenced by workspace generation and keyed by the standard
  idempotency key; replay returns the recorded result.
- Add: repository policy validation, clone into `repos/<alias>`, registry row
  inserted only after the clone succeeds; failure removes only the new checkout.
- Remove: refused while the checkout has uncommitted/untracked paths, stashes,
  worktrees or unpushed commits (auto-close checks), or while tasks, sessions or
  agents use it.
- `MAX_WORKSPACE_REPOSITORIES` bounds the set after add.
- Search: `scope: "all"` on `grep_search`/`symbols_search`/`symbols_references`
  is mutually exclusive with `repositoryId`; results carry `repositoryId` and
  `alias`; pagination stays bounded by the existing `maxResults` and cursor.
- Artifacts: `artifacts_snapshot`/`artifacts_restore` accept `repositoryId`;
  the snapshot records the repository as provenance.

## Phases

1. Backend (contracts, runner, API wiring, tests, docs, skill references).
2. Dashboard repository explorer (UI, router, contract tests, docs-site page).
3. Integration, gates (`lint`, `typecheck`, `test:unit`, `test:integration`,
   `docs:reference`, `plugin:sync`), isolated review, PR into `dev`.

## Out of scope

Local stdio multi-repository mode, coordinated cross-repository pull requests,
merging to `main` or deploying.
