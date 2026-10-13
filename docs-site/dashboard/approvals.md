---
title: Approvals
description: The privilege-grant inbox for command approvals.
---

# Approvals

`/dashboard/approvals` is the inbox for **privilege grants** — requests to run a command
in a workspace that needs your explicit approval before the runner will execute it.

## What a request shows

Each request lists its status, the requested command, the workspace it targets, the
working directory, the command's SHA-256 digest, and when it was created and when it
expires. The status is the one the runner reports: **Pending**, **Approved**,
**Rejected**, **Used** (approved and consumed by the command), or **Expired**. A pending
request whose expiry has passed reads as **Expired**.
The digest is what the runner verifies, so approving is approving *that* command rather
than a description of it.

## Decisions

**Approve** and **Reject** appear only on a pending request that has not expired.
**Approve** lets the command run in that workspace under your identity. **Reject**
discards the request and the command stays blocked. Both decisions are audited, and both
ask for confirmation first because neither can be undone. Decided, used, and expired
requests stay listed for a while without actions, so you can see what happened.

The rail shows a count next to **Approvals** only while an unexpired request is pending,
so the absence of a badge means there is nothing to decide rather than nothing to look
at.

::: tip Where requests come from
A workspace that wants to run a privileged command raises a request instead of blocking
forever. Until you decide, the command does not run.
:::
