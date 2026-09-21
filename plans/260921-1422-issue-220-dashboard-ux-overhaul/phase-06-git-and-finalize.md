---
phase: 6
title: "Contextual Git tab and Finalize workflow (issue Phase 5)"
status: pending
priority: P1
effort: "1.5-2d"
dependencies: [3]
---

# Phase 6: Git tab and Finalize workflow

Issue phase: **Phase 5**.

## Goal

An operator can see the workspace's Git state and finish the job — "Finalize
workspace" — without learning a Git command sequence. Advanced operations stay
available behind progressive disclosure and keep their existing guards.

## Tasks

1. **Read surfaces**: branch/ref, ahead/behind when available, staged/modified/
   untracked summary, file change list, staged and unstaged diff, recent log, and
   worktrees in an advanced section.
2. **Finalize as the happy path**: one action that explains what it will do, why
   it is blocked when it is (dirty tree, conflicts, unresolved grant), and what
   happened afterwards.
3. **Advanced operations** under progressive disclosure: branch, checkout,
   fetch/pull, merge/rebase, worktree create/remove. Each uses the existing
   fenced/validated adapter and surfaces conflict states explicitly, including the
   recovery step.
4. **Diff rendering**: bounded, escaped, monospace, with a size cap and an
   explicit truncation notice; never renders binary or oversized payloads.
5. **Conflict states**: a merge/rebase conflict renders an actionable explanation
   and a resolve path rather than a raw error string.

## Acceptance criteria

- Read surfaces render for a clean, dirty, and conflicted workspace.
- Finalize cannot run against a dirty tree without an explicit confirmation that
  names the blocking state.
- Mutating actions keep their existing validation and cannot bypass conflict
  handling.
- Diff output is bounded and escaped.

## Verification

```bash
npx vitest run dashboard
npm run verify
```

Tests: Git status/diff/log mapping, diff bound and escape, conflict-state
rendering, finalize-blocked messaging, worktree section rendering. Browser QA of
the conflicted state and the keyboard flow.

## Risks

| Risk | Mitigation |
|---|---|
| Finalize semantics differ from the runner's contract | Inspect the existing contract and adapter first; wrap, never reimplement |
| Diff rendering leaks filesystem paths outside the workspace | Reuse the existing path validation and redact absolute host paths |
