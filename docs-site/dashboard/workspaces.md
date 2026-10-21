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
- **Multi-repository workspaces:** A workspace opened over MCP with several repositories is titled by its primary repository and shows a repository count; search also matches its aliases. The detail view lists each repository's alias, checkout path, ref, and **Primary** or **Read-only** badge. The **Open Workspace** form opens one repository; use `workspace_open` with `repositories` for more.

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
  in place instead of resolving them.
- **Automation** groups hooks by the lifecycle event that runs them
  (`on_workspace_open`, `post_checkout`, `pre_commit`, `post_commit`, `manual`) beside an
  ordered pipeline, lists the resolved skills, and offers a guarded skill-script runner.
  Pick a skill and name one of its scripts (for example `run.sh`); the run is pinned to
  the skill digest shown in the list. Each run then asks you to approve it: the dialog
  names the skill, script and digest, and **Approve and run** grants that one run and
  executes it in a disposable helper container. The approval expires after about a
  minute and is used up by the run, even one that fails, so a later run asks again.
  **Cancel** rejects the approval so it does not wait on the Approvals page. If the skill changed
  since the list loaded, the run is refused; reload the tab and try again. When the run
  ends, its exit code, where it ran, the signal that stopped it on a timeout, and its
  bounded, redacted output appear below the
  form, including for a script that exits with an error.
- **Deploy** lists repository-defined deployment targets with their last reported result,
  duration and failure detail; running one asks for confirmation because deployments act
  outside the sandbox.

The sections are contextual: they never appear as rail entries, because a workspace
capability is not a global destination.

## Repository explorer

A multi-repository workspace adds a **Repositories** panel to **Summary**. Each repository
shows its alias, `owner/name`, ref, checkout path, **Primary** or **Read-only** badges, its
branch, whether it has uncommitted changes, and how many commits are unpushed or behind
its upstream, with links that open its **Files**, **Git**, or **Terminal** view. The
dashboard reads this status from inside the executor, so it appears only while the
workspace is active. If a checkout cannot be read, that repository shows **Status
unavailable** rather than looking clean. A branch with no upstream shows **No upstream
branch** instead of "Nothing unpushed".

**Files**, **Git**, and **Terminal** show a **Repository** selector above the view, and
the choice stays in the address (`?repository=<alias>`), so links and reloads keep it:

- **Files** browses and edits inside the selected repository, or the workspace root
  when **Workspace root** is chosen.
- **Git** needs a repository: until you choose one it shows **Choose a repository**
  instead of defaulting to the primary. Every read and operation (fetch, pull,
  checkout, branch, merge, rebase, worktrees) acts on the selected repository.
- **Terminal** opens new sessions in `repos/<alias>`, and the re-attach list shows the
  directory of each session that did not start at the workspace root.
- **Finalize** commits one repository. In a multi-repository workspace the dialog asks
  which one, preselecting the repository of the current **Files**, **Git**, or
  **Terminal** view.

A single-repository workspace shows no selector and behaves exactly as before.

## Runtime

Tasks and sessions are volatile — they disappear when the workspace is reaped, unlike
retained artifacts. Task cancellation asks for confirmation, the dependency graph
renders state as text inside each node (never colour alone) and is keyboard-focusable,
and session output is fetched through a read-only, bounded call: the dashboard never
sends input to an agent's session. For an interactive shell, use the
[Terminal](/dashboard/terminal) section instead.
