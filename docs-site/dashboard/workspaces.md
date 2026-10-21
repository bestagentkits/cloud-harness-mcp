---
title: Workspaces Dashboard
description: Monitoring and managing active Cloud Harness coding workspaces.
---

# Workspaces

The Workspaces panel lists all currently active and recently closed workspace environments associated with your identity.

## Workspace Management

- **Status Indicators:** View workspace lifecycle phase (`ready`, `busy`, `closed`, `error`).
- **TTL Countdown:** Inspect remaining wall-clock TTL and idle timer before automatic cleanup.
- **Resource Details:** Check memory limits, container status, and the effective network profile (`dependency-access` or `network-none`).
- **Force Close:** Immediately terminate a stuck container and permanently purge all temporary workspace files from the host disk.

## Opening Workspaces

Click **New workspace** on the Workspaces page to launch a new workspace. The wizard has
three steps (Repository, Skills and toolkits, Review):
- **Repository & Ref:** Enter an approved HTTPS Git repository and optional branch/tag.
- **Network Profile (optional):** Override the instance default from [Settings](/dashboard/settings) for this workspace. Choose **No network (air-gapped isolation)** when the workspace must have no egress; otherwise dependency access permits only public DNS and TCP 80/443.
- **Skill Sets (optional):** Select the sets the workspace should resolve. Because the same skill name can exist at several tiers, a launch can produce a conflict; resolve each one with a radio choice, since launch stays disabled until every conflict has an override. See [Skills & Skill Sets](/dashboard/skills).
- **Toolkits (optional):** Add preset toolkits and ready licensed kits for your owner scope. A licensed kit without a licence token is shown as not ready. The review step asks the runner to check the selection before launch.

The wizard survives a reload of the tab: it reopens on the same step with the same
choices. A repository URL that contains credentials, a query or a fragment is refused and
never kept. If the launch answer is lost, pressing **Launch workspace** again sends the
same request key, so the harness opens at most one workspace for it; changing any field
starts a new request. **Cancel** discards the draft.
::: danger Data Purge on Close
Closing a workspace unmounts the Docker filesystem and recursively deletes the job directory. Ensure any necessary changes have been committed and pushed to origin before closing.
:::

## The workspace cockpit

Opening a workspace gives you a cockpit rather than a metadata page. The header carries
the repository, status, branch, network profile and remaining lease, with **Renew lease**
as the primary action, **Finalize workspace** beside it, and recover/close behind **More
actions**. Contextual sections follow: **Summary**, **Agents**, **Runtime**,
**Terminal**, **Files**, **Git**, **Automation**, **Deploy**, **Artifacts**, and
**Activity**.

- **Summary** shows health, observable state (branch, attributable repository items,
  capabilities, network posture) and a **Needs attention** panel for the reasons the
dashboard can read: a lease inside its threshold, a failed workspace, a quarantined
  network, or uncommitted work. Cost is shown only when the backend can support it, and
  reads "Not reported" otherwise.
- **Agents** lists the agents this workspace ran, with their hierarchy; see
  [Agents](/dashboard/agents).
- **Runtime** shows tasks (status, duration, exit code, dependencies, bounded output,
  cancel), the task dependency graph as accessible SVG with a table fallback, and
  sessions whose output is read-only and bounded. See [Runtime](#runtime).
- **Terminal** opens an interactive shell inside the workspace; see
  [Terminal](/dashboard/terminal).
- **Git** keeps **Finalize** as the happy path and stays collapsed for everything else:
  branch, ahead/behind, staged/modified/untracked counts, the changed-file list, a
  bounded staged or unstaged diff, recent commits, worktrees, and advanced operations
  (fetch, fast-forward-only pull, checkout, branch, merge, rebase) that report conflicts
  in place instead of resolving them. Checkout, merge, rebase and worktree removal ask
  for confirmation first; fetch, pull and branch run directly.
- **Automation** groups hooks by the lifecycle event that runs them
  (`on_workspace_open`, `post_checkout`, `pre_commit`, `post_commit`, `manual`) beside an
  ordered pipeline, lists the resolved skills, and offers a guarded skill-script runner.
- **Deploy** lists repository-defined deployment targets with their last reported result,
  duration and failure detail; running one asks for confirmation because deployments act
  outside the sandbox.

The sections are contextual: they never appear as rail entries, because a workspace
capability is not a global destination.

## Runtime

Tasks and sessions are volatile — they disappear when the workspace is reaped, unlike
retained artifacts. Task cancellation asks for confirmation, the dependency graph
renders state as text inside each node (never colour alone) and is keyboard-focusable,
and session output is fetched through a read-only, bounded call: the dashboard never
sends input to an agent's session. For an interactive shell, use the
[Terminal](/dashboard/terminal) section instead.

In the new dashboard, the Runtime tab shows the dependency graph above the task list,
and nothing polls: **Refresh** re-reads the tasks, sessions and graph together. Each task
also lists the tasks it depends on as a column. **Output** opens a task's bounded output
and puts the task in the address (`?task=`), so the view survives a reload; **Next
slice** reads the next part of a long output. You can open a named shell session, read
its output, and close it after a confirmation.

## Files, deploy and finalize in the new dashboard

- **Files** keeps the folder in `?path=` and the open file in `?file=`, so a link opens
  the same file. A save sends the file's last-read digest; if the file changed elsewhere
  you get a conflict dialog that keeps your edit and lets you review the latest version
  or copy your changes. Deleting a file asks for confirmation.
- **Git** keeps the staged/unstaged diff choice in `?staged=`; checkout and removing a
  worktree ask for confirmation.
- **Automation** runs a hook at a chosen stage or a skill script, each pinned to the
  digest you saw, so a changed hook or script is refused instead of run. Running a skill
  script still needs an owner privilege grant that the dashboard cannot provide yet.
- **Deploy** is a two-step wizard: choose a target, review it, then confirm the run.
  The chosen target survives a reload; the run output does not.
- **Finalize** keeps one request key across retries of the same commit, so a retry after
  a lost answer does not push twice. **Close** sends the workspace generation you saw.
