# Phase 6 (issue #220, Phase 5): contextual Git tab and Finalize workflow

Date: 2026-09-21 · Branch: `mrgoonie/dashboard-ux-overhaul-phase-6` (task-6 delta over `main`)
Plan: `plans/260921-1422-issue-220-dashboard-ux-overhaul/phase-06-git-and-finalize.md`

## Summary

Workspace Git is contextual and Finalize stays the happy path. The cockpit's Git tab
shows branch/upstream/ahead-behind, the staged/modified/untracked summary and the
changed-file list parsed from `git status --short --branch`, a bounded staged or
unstaged diff with an explicit truncation notice, recent commits, and worktrees in a
disclosure. Advanced operations — fetch, fast-forward-only pull, checkout, branch,
merge, rebase — live in one collapsed form and report conflicts in place.

Phase 6 of 12 for #220. This PR does not close the epic.

## What changed

- `apps/api/src/dashboard-response.ts` — `parseGitStatus` and `parseWorktrees` turn the
  runner's bounded Git text into a tested summary (branch, upstream, ahead/behind,
  index vs worktree counts, untracked count, entries; worktree path/head/branch). The
  union gains `git_status`, `git_diff`, `git_log`, `git_fetch`, `git_pull`,
  `git_checkout`, `git_branch`, `git_merge`, `git_rebase`, `worktrees_list`,
  `worktrees_create`, `worktrees_remove` with projections that bound output at 8 KB.
- `apps/api/src/dashboard-router.ts` — read routes
  `GET /git/status`, `GET /git/diff?staged=`, `GET /git/log?limit=`,
  `GET /worktrees`, plus mutation routes `POST /git/{fetch,pull,checkout,branch,merge,rebase}`,
  `POST /worktrees` and `DELETE /worktrees/:name`. Every mutation keeps the
  contract's own fencing (constrained ref arguments, identity, expected head where
  the contract requires it) and inherits the session/CSRF middleware.
- `apps/api/dashboard/dashboard-render.js` — `renderGitStatus`, `renderGitDiff`,
  `renderGitLog`, `renderWorktrees`, `renderGitAdvanced`, `renderGitPanel`.
- `apps/api/dashboard/dashboard.js` — the cockpit's Git tab loads status, diff, log
  and worktrees together; the staged/unstaged toggle is a URL parameter (shareable,
  back-button correct); worktree removal confirms; the advanced form maps each action
  onto its contract body; conflicts surface in place.
- `docs/design-guidelines.md` — the Git contract, including why Finalize remains
  primary and why conflicts are never auto-resolved.

## Verification

- `npx vitest run dashboard apps/api/test/dashboard-git.test.ts` — 21 files, 290 tests,
  all passing; `npm run typecheck -w @cloud-harness/api` clean.
- `apps/api/test/dashboard-git.test.ts` — status parsing (ahead/behind, index vs
  worktree counts, untracked, detached head, missing upstream, empty output), worktree
  parsing (branch and detached forms), and the renderers (escaped paths, diff side
  labels, truncation notice, commit list, collapsed worktrees with their create form,
  all six advanced actions present, composed panel).
- Two parser defects were caught by these tests before merge: trimming the porcelain
  code erased which side changed (`M ` vs ` M`), and the detached-worktree branch text
  was mis-assigned. Both are fixed and covered.

## Residual

Merge and rebase are exposed as advanced actions; conflict resolution is not offered
because the runner contract does not provide an interactive resolver, and the panel
says so. Worktree creation uses the contract's `name` + `ref` form only.
