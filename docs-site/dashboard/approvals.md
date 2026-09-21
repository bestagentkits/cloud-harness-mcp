---
title: Approvals
description: The privilege-grant inbox for pending command approvals.
---

# Approvals

`/dashboard/approvals` is the inbox for **privilege grants** — requests to run a command
in a workspace that needs your explicit approval before the runner will execute it.

## What a request shows

Each pending request lists the requested command, the workspace it targets, the working
directory, the command's SHA-256 digest, and when it was created and when it expires.
The digest is what the runner verifies, so approving is approving *that* command rather
than a description of it.

## Decisions

**Approve** lets the command run in that workspace under your identity. **Reject**
discards the request and the command stays blocked. Both decisions are audited, and both
ask for confirmation first because neither can be undone.

The rail shows a count next to **Approvals** only while something is pending, so the
absence of a badge means there is nothing to decide rather than nothing to look at. When
the inbox is empty it says so and explains that requests leave the list once decided.

::: tip Where requests come from
A workspace that wants to run a privileged command raises a request instead of blocking
forever. Until you decide, the command does not run.
:::
