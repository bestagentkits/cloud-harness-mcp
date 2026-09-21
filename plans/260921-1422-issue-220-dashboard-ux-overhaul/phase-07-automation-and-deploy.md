---
phase: 7
title: "Workspace Automation (skills, hooks) and Deploy (issue Phase 6)"
status: pending
priority: P1
effort: "1-1.5d"
dependencies: [3]
---

# Phase 7: Automation and Deploy

Issue phase: **Phase 6**.

## Goal

The workspace-scoped Automation page makes skills and hooks discoverable and
explains when they run. The Deploy section shows the targets an operator can
deploy this workspace to, with their last known result and failure detail.

## Tasks

1. **Skills section**: discovered skills with description and instructions where
   safe to show, plus scripts/actions only where the existing contract marks them
   executable. Activation stays behind the existing guarded contracts.
2. **Hooks section**: grouped by lifecycle event (`on_workspace_open`,
   `post_checkout`, `pre_commit`, `post_commit`, `manual`) with an accessible
   pipeline visualization that shows order, plus a retained text list.
   Activate/deactivate/run only through existing guarded contracts.
3. **Deploy section**: target name, last result/status, duration, a run action,
   and failure detail. Deployment is an external-effect risk: keep the explicit
   confirmation semantics the current contract requires.
4. **Safety copy**: any action that mutates the workspace or an external system
   states its effect before running, and reports the outcome in the live region.

## Acceptance criteria

- Every lifecycle group renders, including groups with no hooks (explicit empty
  copy, not a missing row).
- The pipeline visualization has a text equivalent and is not colour-only.
- Guarded actions cannot be triggered when the contract forbids them; the UI
  explains why instead of failing silently.
- Deploy run keeps its confirmation and surfaces classified failures.

## Verification

```bash
npx vitest run dashboard
npm run verify
```

Tests: hook grouping, guard-disabled rendering, deploy result/failure rendering,
pipeline text equivalence. Browser QA at desktop and ~375px in both themes.

## Risks

| Risk | Mitigation |
|---|---|
| "Executable skill script" is over-exposed | Render only what the contract marks executable; never infer capability |
| Deploy confirmation bypassed by a keyboard path | Single confirmation helper reused for all external-effect actions |
