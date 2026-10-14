---
title: Approvals
description: The inbox for privilege grants and managed package plans.
---

# Approvals

`/dashboard/approvals` is the inbox for two kinds of request that wait for your
decision:

- **Privilege grants**: requests to run a command in a workspace that needs your explicit
  approval before the runner will execute it.
- **Package plans**: requests to install or update a [managed toolbox package](/dashboard/packages).

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

The rail shows a count next to **Approvals** only while an unexpired grant or package plan
is pending, so the absence of a badge means there is nothing to decide rather than nothing
to look at.

::: tip Where requests come from
A workspace that wants to run a privileged command raises a request instead of blocking
forever. Until you decide, the command does not run.
:::

## Package plans

The **Package plans** section lists the plans agents create with `packages_plan`. Each
plan is a preview of an install or update. The section is shown only when managed
packages are on. Otherwise it reads "Managed packages are off. Operators enable them with
PACKAGES_ENABLED=true."

Each plan shows:

- the package, the planned version, the ecosystem, and the scope;
- a comparison of the current release with the planned version, or **New install**;
- the **plan digest**, shortened. Focus it, or hover it, to read the full value;
- the requested version spec, the resolved source, the registry integrity, the dependency
  count, the estimated size, the binaries it exposes, the runtime versions, the number of
  affected workspaces, and when the plan was created and when it expires.

A risk list appears above the facts when the plan:

- runs npm lifecycle scripts;
- would expose a binary name another package already provides;
- was overtaken by a newer change to the same package.

### Deciding a plan

**Approve** and **Reject** appear only on a pending plan that has not expired. Approving
posts the digest shown on the row, and the confirmation repeats it in full. The runner
refuses the approval if the plan no longer matches that digest, if the plan expired, or if
the package changed since the plan was made. Ask the agent for a new plan in that case. An
approved plan that is not applied yet offers **Withdraw approval**. Both decisions are
audited.

The approval mode decides whether you see decisions at all:

- `PACKAGES_APPROVAL_MODE=required` (the default): every plan waits here.
- `PACKAGES_APPROVAL_MODE=none`: plans are approved by policy when they are created. They
  are listed for the record.
