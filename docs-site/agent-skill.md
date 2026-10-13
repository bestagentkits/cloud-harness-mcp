---
title: Agent Skill (cloudharness)
description: Companion operating skill for AI coding agents.
---

# Agent Skill: `cloudharness`

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
- **Native Pull Request Reviews:** Submitting `COMMENT`, `APPROVE`, or `REQUEST_CHANGES` reviews, inline file/line comments, thread replies and resolution, reviewer requests, draft/ready changes, and merges through `github_action`.

## Example: Agent-Driven Pull Request Review

`github_action` covers the whole review lifecycle on the repository bound to a workspace. Mutations accept an `idempotencyKey`, so a retried call replays the first result instead of posting twice.

```text
github_read   pr_view            { "prNumber": 42 }
github_read   pr_review_threads  { "prNumber": 42 }
github_action pr_review_comment  { "prNumber": 42, "path": "src/api.ts", "line": 18, "body": "Validate this input." }
github_action pr_review          { "prNumber": 42, "event": "REQUEST_CHANGES", "body": "See inline comments." }
  ... the author pushes fixes ...
github_read   pr_view            { "prNumber": 42 }
github_action pr_review_thread_resolve { "threadId": "PRRT_..." }
github_action pr_review          { "prNumber": 42, "event": "APPROVE" }
github_action pr_merge           { "prNumber": 42, "method": "squash", "matchHeadCommit": "<headRefOid from pr_view>" }
```

Approving or requesting changes on a pull request the acting identity authored is refused by GitHub (`GITHUB_REVIEW_NOT_ALLOWED`). Merge and auto-merge also need **Contents: Read and write** on the GitHub App; see [GitHub App setup](/dashboard/github). Check `workspace_capabilities` (`operations.pullRequestReview`, `pullRequestMerge`, and `githubActions`) to see what the current credential can do.
