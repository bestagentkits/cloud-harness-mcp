---
title: Workspace Explorer (MCP Apps)
description: Browse a workspace's files, Git diff, and task states in ChatGPT, Claude, and other MCP Apps hosts.
---

# Workspace Explorer (MCP Apps)

Cloud Harness ships a read-only **workspace explorer** as an
[MCP Apps](https://modelcontextprotocol.io/extensions/apps) view. In a host
that renders MCP Apps, such as ChatGPT or Claude, it shows one workspace as an
interactive panel inside the conversation:

- **Files**: a lazily expanded file tree and a bounded file preview.
- **Git**: `git status` for the active repository and its unstaged or staged
  diff, with added, removed, and hunk lines highlighted.
- **Tasks**: managed task states, their dependencies, and bounded output, with
  an optional watch that refreshes every few seconds while tasks are running.

The panel follows the host's light or dark theme, fits narrow layouts, and is
fully keyboard operable (arrow keys move between the Files, Git, and Tasks
tabs).

## Setup

There is nothing extra to configure. Connect the client to `/mcp` or to a
workspace-bound endpoint `/mcp/workspaces/<workspaceId>` as described in
[ChatGPT](/ai-tools/chatgpt) or [Claude Desktop](/ai-tools/claude); local stdio
mode serves it too. `/mcp-gateway` does not.

Then ask for it, for example:

> Open workspace ws_… in the workspace explorer.

The model calls `workspace_show_ui` with the workspace id, and the host renders
the panel. If you do not see a panel, the client does not render MCP Apps (or
has the feature off); it still receives the same workspace summary as
`workspace_status`, so the conversation continues as text.

## What it can and cannot do

- It is **read-only**. It reads only through `workspace_status`, `files_list`,
  `files_read`, `git_status`, `git_diff`, `tasks_list`, `tasks_status`, and
  `tasks_graph`. It cannot run commands, edit files, push, or start or cancel
  tasks: ask the model for those.
- It shows **one workspace**: the one it was opened for. Every read uses your
  own authorization for that workspace, exactly as if the model had called the
  tool.
- What you browse in the panel stays in the panel; it is not sent to the model.
- Large content is bounded: previews stop at 256 KiB, diffs at 512 KiB or
  8,000 lines, and task output at 256 KiB, with a note when a view stops early.
  Ask the model to read the rest with `files_read` or `git_diff` paging.
- When the workspace lease expires or the workspace is closed, the panel says
  so and stops refreshing. Ask the model to renew, recover, or reopen it, then
  open the explorer again.

Live rendering inside ChatGPT and Claude has not yet been verified end to end;
Cloud Harness's own tests drive the view through the official MCP Apps host
bridge and a headless browser.

See the [`workspace_show_ui` reference](/reference/tools#workspace-show-ui) for
the tool contract.
