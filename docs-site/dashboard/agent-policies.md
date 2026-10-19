---
title: Agent Policies
description: Decide what coding agents may do, per instance and per project, and test it before saving.
---

# Agent Policies

An agent policy decides whether an agent action is allowed, needs your
approval, or is denied. You write one **global** policy and, when a project
needs tighter rules, a **project** policy that narrows it.

::: info Enforcement arrives with the coding broker
This release stores, checks and simulates policies. It does not yet stop or
hold a running agent's actions: that enforcement arrives with the coding
broker, which uses the same evaluator as the simulation. Until then a saved
policy changes what **Simulate an action** returns, not what agents do.
:::

- **Settings > Agent policies** (`/dashboard/settings/agent-policies`) edits the
  global policy and lists every project that has its own.
- **Project > Agent policies** (`/dashboard/projects/<id>/agent-policies`)
  edits one project's policy. Open a project and use **Agent policies** in the
  page header.

Both pages are always reachable. Editing, checking and simulating need the
runner to run with `AGENT_POLICIES_ENABLED=true`; while it is off, the page
shows how to turn it on and the runner refuses every policy operation. See
[environment variables](/reference/environment-variables).

## What a policy controls

Every agent action has a class: **Read**, **Edit files**, **Run tests**,
**Local git**, **Publish branch**, **Open pull request**, **Network** and
**Install packages**. For each class the global policy sets:

- **Allowed**: whether agents may perform the class at all.
- **Hard deny**: always denied. Nothing, including a project or an advisor, can
  lift it.
- **Mandatory approval**: always waits for your approval.
- **Default effect**: **Allow**, **Require approval**, or **Advisor or
  approval**. With no advisor configured, **Advisor or approval** waits for
  your approval.
- **Projects may choose**: lets a project policy pick this class's effect. On a
  class with no default effect it saves **Require approval** as the default,
  which projects may then change.

The policy also sets the scope agents work in (repositories, branch prefixes
for publishing, paths, commands, packages, registries and network hosts), per
run budgets, and how long an approval request stays open. Until you save a
global policy, a read-only default applies that allows only **Read**.

Some actions are denied whatever the policy says: access to credentials or the
Docker socket, network escalation, privilege escalation, and paths outside the
workspace.

## Project policies only narrow

A project policy can remove classes, add hard denies or mandatory approvals,
shorten scope lists, and lower budgets. Fields left empty inherit the global
value. It cannot allow anything the global policy does not: saving such a
policy is refused with the fields that widen it. The **Inheritance** table
shows the global value, the project setting and the effective result side by
side.

If a project is deleted while it still has a policy, the policy is marked
**orphaned**. Every action for that project is denied until you remove the
policy, and the effective-policy preview shows no permissions.

The global page lists the 1,000 most recently changed project policies and says
so when there are more; open a project to see a policy that is not listed.

## Editing and saving

Edit the policy in the form, or switch to **JSON** to edit the document
directly. **Load JSON into form** checks your JSON and shows it in the form.

**Check changes** asks the runner to validate the draft. It shows invalid
fields, refused widenings, changes that weaken the effective policy, a field by
field diff against the saved version, and the effective policy after the
change.

**Save policy** checks the draft again. When the change lets agents do more
than before, you confirm the listed weakenings first. Your confirmation covers
exactly that list: if another save changes it before yours lands, the page
shows the current list and asks you to confirm again. If someone saved the
policy while you were editing, the page keeps your draft, reloads the saved
version, and asks you to check again.

## Simulating an action

**Simulate an action** describes one action (class, repository, branch,
command, paths, package or host, and any platform effects) and shows the
decision the runner would make: **Allow**, **Requires approval** or **Deny**,
with the reason code, the matched rules, the policy revisions used and a
fingerprint of the action. The simulation uses the same evaluator, policy
snapshot and advisor setting that the coding broker will use, so its answer is
the decision execution starts from. The one difference is the advisor: when an
advisor is configured, an **Advisor or approval** action shows as **Requires
approval** with `ADVISOR_REQUIRED`, because the advisor answers only at
execution time. It becomes **Allow** only if the advisor answers that nothing
needs to change.

Tick **Evaluate the unsaved editor draft** to try a change before saving it.
Simulations are read-only and are not recorded in the audit log.

## History and rollback

Every save creates a new revision; old revisions are never changed. **History**
lists them with their notes. **Compare with current** shows the differences, and
**Roll back** creates a new revision with the older document. A rollback that
weakens the effective policy asks for confirmation. **Remove project policy**
returns the project to the global policy; its history stays.
