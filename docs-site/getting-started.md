---
title: Getting Started Guide
description: Step-by-step walkthrough for opening a workspace, executing tools, and closing safely.
---

# Getting Started Guide

<div class="md-twin-hint">
  <strong>AI Crawler / Raw View:</strong> Fetch this page as raw Markdown at <code>/getting-started.md</code>.
</div>

## The 4-Step Lifecycle

Working with Cloud Harness MCP follows a disciplined lifecycle:

```
1. Open Workspace ──► 2. Inspect & Code ──► 3. Test & Commit ──► 4. Close Workspace
```

---

### Step 1: Open a Workspace

Call `workspace_open` with a credential-free HTTPS repository URL and a random idempotency key:

```json
{
  "repositoryUrl": "https://github.com/my-org/my-project.git",
  "idempotencyKey": "init-2026-08-19-a1b2c3d4",
  "ref": "main"
}
```

**Response:**
```json
{
  "workspaceId": "ws_abcdef1234567890abcdef123456",
  "status": "ready",
  "expiresAt": "2026-08-19T10:15:00.000Z"
}
```

::: warning Keep the Workspace ID
Save the returned `workspaceId`. All subsequent tool invocations (reading files, executing tests, running git operations) require this identifier.
:::

---

### Step 2: Inspect Files & Code

List directory entries or search symbols:

```json
// Tool: files_list
{
  "workspaceId": "ws_abcdef1234567890abcdef123456",
  "path": "src"
}

// Tool: grep_search
{
  "workspaceId": "ws_abcdef1234567890abcdef123456",
  "pattern": "export function authenticate"
}
```

Edit files surgically or write new content:

```json
// Tool: files_write
{
  "workspaceId": "ws_abcdef1234567890abcdef123456",
  "path": "src/auth.ts",
  "content": "export function authenticate() { return true; }"
}
```

---

### Step 3: Run Tests & Commit

Execute test commands inside the container:

```json
// Tool: exec_run
{
  "workspaceId": "ws_abcdef1234567890abcdef123456",
  "command": "npm test"
}
```

Commit changes to the local branch:

```json
// Tool: git_commit
{
  "workspaceId": "ws_abcdef1234567890abcdef123456",
  "message": "feat(auth): implement token validation"
}
```

Push to origin (requires GitHub App installation):

```json
// Tool: git_push
{
  "workspaceId": "ws_abcdef1234567890abcdef123456",
  "refspec": "HEAD:refs/heads/feature/auth"
}
```

---

### Step 4: Close the Workspace

Always close your workspace when finished to release container and memory resources:

```json
// Tool: workspace_close
{
  "workspaceId": "ws_abcdef1234567890abcdef123456"
}
```

Unclosed workspaces are automatically terminated when their idle TTL (5 min) or wall TTL (15 min) expires.
