---
title: Activity
description: One operational timeline across agents, tasks, MCP, deployments, and audit.
---

# Activity

`/dashboard/activity` is the Activity Center: one timeline with filters for **All**,
**Agents**, **Tasks**, **MCP**, **Deployments**, and **Audit**. It exists so an operator
does not have to visit five subsystems to answer "what happened, and when".

## One event grammar, two kinds of record

Every row states the same things — when it happened, which category, its status, the
actor or resource, a short summary, and where to look next — and every row says which
kind of record it is:

- **Retained audit** rows come from the durable, redacted audit record.
- **Live runtime** rows come from current runtime state and disappear with their
  workspace.

The distinction is deliberate and visible. Audit history is durable; a running task is
not, and presenting the two as one kind of record would imply a retention guarantee the
harness does not make for runtime state.

## Filters

A filter is a URL parameter (`/dashboard/activity?filter=agents`), so a filtered timeline
can be shared, bookmarked, and reached with the back button. Each filter tab shows its
own count, and an empty filter explains itself instead of rendering a blank page.

## Audit

The dedicated audit page remains at `/dashboard/audit` — including its palette entry —
for anyone who wants the raw retained record without the timeline around it. It is no
longer a rail entry, because Audit is now one filter of this page.
