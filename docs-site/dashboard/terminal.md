---
title: Terminal
description: An interactive shell inside a workspace, opened from the operator dashboard.
---

# Terminal

The **Terminal** tab of a workspace cockpit (`/dashboard/workspaces/<id>/terminal`) opens
an interactive `bash` shell inside that workspace's executor. It is a real terminal:
full-screen programs, colours, job control, and window resizing behave as they would in
a local terminal.

The shell runs in the same sandbox as agent commands, with the same user, limits,
network profile, and environment. It does not run on the host or in the harness's own
services, and it gives you no more access than an agent working in that workspace has.

## Opening and re-attaching

Visiting the tab never starts a shell by itself. Choose **New session** to open one in
the workspace root. If the workspace already has running terminals, the tab lists them
with **Re-attach**; re-attaching replays the recent output it still holds. When earlier
output has already been dropped, the terminal says how many bytes were skipped instead
of showing an incomplete screen as if it were whole.

A workspace can hold only a limited number of live terminals at once. Opening one more
is refused with a message naming the limit; close a terminal you no longer need first.

## Keyboard

Keys typed into the terminal go to the shell, including **Tab** and **Escape**. Press
**Ctrl+Shift+F6** to move focus out of the terminal to its toolbar, then use Tab and
Shift+Tab to move through the page as usual.

The terminal follows the dashboard theme, including a switch between light, dark, and
system while it is open.

## Closing and limits

**Close** ends the shell and every process it started. The workspace and its files are
unchanged. A terminal also ends when it has been idle too long, when it reaches its
maximum lifetime, when the shell exits, or when the workspace stops. Its status pill
says which, and **New session** starts a fresh one.

While a terminal is running in an open tab, the workspace counts as active, so it is not
expired for idleness. It still ends at the workspace's maximum lifetime; the idle and
lifetime expiry the dashboard shows are never later than the workspace's own. If the
workspace is closed or expires, the terminal shows **No longer available** and stops
polling.

Terminals are not resumed. If the harness restarts, every open terminal ends and shows
**No longer available**; start a new session to continue. Use a background task (for
example `tasks_run` from an AI tool) for long-running work that must survive a restart.

## All terminals

`/dashboard/terminals` lists your terminals across workspaces with their size, age, and
idle expiry. Ended terminals stay listed briefly with their final status. Each row links
to the workspace's Terminal tab, and **Close** ends a running terminal after a
confirmation.

## Privacy and audit

Secret values that the harness injected into the workspace are redacted from terminal
output before it is kept or shown, the same as for agent command output. Redaction
matches exact values only, so avoid printing secrets in an encoded or partial form.
If a typed character only appears after the next key (for example `g` when a `ghp_…`
token is injected), that is redaction holding back text that could begin a secret
until the following bytes show it is not one.

The [audit log](/dashboard/audit) records only that a terminal was opened and how it
ended. What you type and what the shell prints are never written to the audit log.

## For operators

The live-terminal limit, idle timeout, maximum lifetime, and retained output size are
the `TERMINAL_*` runner settings in the
[environment-variable reference](/reference/environment-variables). Terminals are a
dashboard feature only; there is no MCP tool for them. For errors, see
[Troubleshooting](/troubleshooting#_22-dashboard-terminal-is-unavailable-or-no-longer-available).
