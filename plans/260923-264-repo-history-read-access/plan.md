---
title: Repository history read access (issue #264)
status: completed
issue: 264
branch: claude/vibe-ship-beta-80bcd2
mode: beta
route: feature
---

# Repository history read access

Source: https://github.com/bestagentkits/cloud-harness-mcp/issues/264

## Outcome

An agent can answer "what changed recently?" on a fresh workspace without a
human approving a read-only call.

## Root causes (verified)

- `worker/clone-helper.sh` always clones with `--depth 1`.
- `git_fetch` has no depth control; `git fetch --unshallow` inside the executor
  has no credentials by design.
- The approval prompt comes from MCP client tool annotations: `github_action`
  is one tool with `destructiveHint: true`, so every action (including
  `pr_list`) is annotated destructive. The runner has no per-action approval
  gate (`apps/runner/src/workspace-service.ts` `github_action` branch).

## Design

1. `workspace_open` gains `fetchDepth` (integer 0..100000, 0 = full history)
   and `shallowSince` (ISO date/datetime), mutually exclusive. Default stays
   depth 1 (clone cost/perf unchanged). Passed to `clone-helper.sh` as a history
   spec argument (`depth:N`, `since:DATE`, `full`).
2. `git_fetch` gains `depth` (1..100000), `unshallow` (boolean) and
   `shallowSince`, at most one. Routed through the broker's existing
   transfer-helper (credentials never enter the checkout); the transfer fetch
   applies the depth and the offline import applies `--depth`/`--shallow-since`/
   `--unshallow` with `--update-shallow`.
3. New read actions `commit_list`, `compare`, `release_list`, `tag_list`
   (contents: read) implemented in `worker/gh-helper.sh` via `gh api`/`gh release`.
4. New tool `github_read` (readOnly, idempotent, openWorld, not destructive)
   accepting only read actions: `pr_list`, `pr_view`, `issue_list`,
   `issue_view`, `commit_list`, `compare`, `release_list`, `tag_list`. Shares the
   runner handler with `github_action`. `github_action` keeps every existing
   action and also accepts the new read actions (backward compatible).
5. `workspace_capabilities` adds operations `commitList`, `compare`,
   `releaseList`, `tagList` and a `githubActions` block
   `{ readOnlyTool: 'github_read', readOnly: [...], gated: [...] }`.
6. Local mode rejects `github_read` like `github_action`, and rejects the new
   `git_fetch` history options consistently with its existing fetch handling.

## Non-goals

- Changing the default clone depth.
- Adding a server-side approval system; approval is client-driven via annotations.
- Exposing tokens or raw `gh` to the executor.

## Acceptance criteria

- [ ] `git_log` can return N commits / N days of history on a freshly opened
      workspace (`fetchDepth` / `shallowSince`).
- [ ] `git_fetch` can deepen or unshallow through the broker.
- [ ] `github_action` and `github_read` support `commit_list` and `compare`.
- [ ] Read-only GitHub calls are available on a tool annotated read-only /
      non-destructive (`github_read`), so clients do not prompt per call.
- [ ] `workspace_capabilities` reports read-only vs gated actions.
- [ ] Contracts, runner, helper tests pass; docs, docs-site, skill synced.

## Phases

| Phase | Files | Validation |
| --- | --- | --- |
| Contracts | `packages/contracts/src/tool-schemas.ts`, `runner-api.ts` | contracts tests |
| Runner + helpers | `apps/runner/src/workspace-service.ts`, `github-app-broker.ts`, `worker/*.sh`, local backend | runner tests, shell syntax |
| Docs | `docs/mcp-api.md`, `docs-site/reference`, skill refs, `plugin:sync`, `docs:reference` | `npm run verify` |

## Risks

- Import with `--depth` from a shallow local transfer repo: covered by passing
  `--update-shallow`; `--unshallow` only when the checkout is shallow.
- `compare` refs are validated with a conservative ref pattern (no `..`, no
  leading `-`).
