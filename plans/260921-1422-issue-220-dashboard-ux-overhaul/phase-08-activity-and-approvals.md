---
phase: 8
title: "Activity Center and Approvals inbox (issue Phase 7)"
status: pending
priority: P1
effort: "1.5-2d"
dependencies: [1, 3]
---

# Phase 8: Activity Center and Approvals

Issue phase: **Phase 7**.

## Goal

One operational timeline across agents, tasks, MCP, deployments and audit — with
Audit's durability and redaction guarantees intact — and a working inbox for
pending privilege grants so an operator can unblock work without leaving the
Dashboard.

## Tasks

1. **Activity Center** at `/dashboard/activity` with filters
   `All | Agents | Tasks | MCP | Deployments | Audit` and one event grammar:
   timestamp, category, status, actor/resource, short summary, detail link.
2. **Source honesty**: runtime-derived events are presented as live/runtime data
   and audit events as durable retained data. The UI must not imply runtime items
   are retained audit records.
3. **Audit tab** reuses the existing audit list/redaction path; the standalone
   `/dashboard/audit` page remains served and links into this tab. The temporary
   Audit sidebar entry from Phase 1 is removed here.
4. **Approvals inbox** at `/dashboard/approvals`: pending privilege grants with
   workspace/resource context, requested capability/action, created time, bounded
   metadata, and Approve/Reject. Decisions announce their outcome and refresh the
   list.
5. **Sidebar badge**: shows a count only when pending items exist; no badge at
   zero.
6. **Empty state** for no pending approvals, and an error state if the grant list
   cannot be read.

## Acceptance criteria

- Filtering by each category yields only that category; the event grammar is
  identical across categories.
- Approve/Reject work end to end, are CSRF-guarded, and cannot double-submit.
- The badge appears only with pending items and clears after a decision.
- Audit's durable/redacted guarantees are unchanged and asserted.

## Verification

```bash
npx vitest run dashboard
npm run verify
```

Tests: activity filtering per category, event mapping, approvals approve/reject
behaviour, badge count at zero and non-zero, audit redaction retained. Browser
QA of the inbox, empty state, and filter keyboard flow.

## Risks

| Risk | Mitigation |
|---|---|
| Activity implies retention that does not exist | Explicit per-category retention labelling asserted by test |
| Approvals become a privilege-escalation surface | Reuse the existing grant contract and audit logging; no new mutation path |
