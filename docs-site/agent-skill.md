---
title: Agent Skill (cloudharness)
description: Companion operating skill for AI coding agents.
---

# Agent Skill: `cloudharness`

<div class="md-twin-hint">
  <strong>AI Crawler / Raw View:</strong> Fetch this page as raw Markdown at <code>/agent-skill.md</code>.
</div>

The `cloudharness` skill teaches AI coding agents how to autonomously navigate workspaces, execute tests, manage worktrees, and run tasks within Cloud Harness MCP.

## Installation

```bash
# Skills CLI (recommended)
npx skills add bestagentkits/cloud-harness-mcp --skill cloudharness --global

# Claude Code Plugin
claude plugin install cloud-harness@bestagentkits

# OpenAI Codex Plugin
codex plugin add cloud-harness@bestagentkits
```

## Capabilities Taught to the Agent

- **Safe Lifecycle:** Always keeping the `workspaceId`, closing stale shells before exit.
- **Incremental Navigation:** Using `files_list` pagination and `grep_search` rather than recursive host dumping.
- **Atomic File Edits:** Applying targeted patches with `files_apply_patch` instead of rewriting massive files.
- **Clean Git Handoffs:** Verifying commit status before calling `git_push`.
