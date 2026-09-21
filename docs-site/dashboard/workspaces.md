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

Click **Open Workspace** in the Dashboard to launch a new workspace:
- **Repository & Ref:** Enter an approved HTTPS Git repository and optional branch/tag.
- **Network Profile (optional):** Override the instance default from [Settings](/dashboard/settings) for this workspace. Choose **No network (air-gapped isolation)** when the workspace must have no egress; otherwise dependency access permits only public DNS and TCP 80/443.
- **Skill Sets (optional):** Select the sets the workspace should resolve. Because the same skill name can exist at several tiers, a launch can produce a conflict; resolve each one with a radio choice, since launch stays disabled until every conflict has an override. See [Skills & Skill Sets](/dashboard/skills).
::: danger Data Purge on Close
Closing a workspace unmounts the Docker filesystem and recursively deletes the job directory. Ensure any necessary changes have been committed and pushed to origin before closing.
:::

## The workspace cockpit

Opening a workspace gives you a cockpit rather than a metadata page. The header carries
the repository, status, branch, network profile and remaining lease, with **Renew lease**
as the primary action, **Finalize workspace** beside it, and recover/close behind **More
actions**. Nine contextual sections follow: **Summary**, **Agents**, **Runtime**,
**Files**, **Git**, **Automation**, **Deploy**, **Artifacts**, and **Activity**.

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
- **Git** keeps **Finalize** as the happy path and stays collapsed for everything else:
  branch, ahead/behind, staged/modified/untracked counts, the changed-file list, a
  bounded staged or unstaged diff, recent commits, worktrees, and advanced operations
  (fetch, fast-forward-only pull, checkout, branch, merge, rebase) that report conflicts
  in place instead of resolving them.
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
sends input to a session, so this page cannot become a terminal.
