---
title: GitHub App Bindings
description: Managing GitHub App installation permissions for private repositories.
---

# GitHub App Bindings

<div class="md-twin-hint">
  <strong>AI Crawler / Raw View:</strong> Fetch this page as raw Markdown at <code>/dashboard/github.md</code>.
</div>

To clone private repositories or push commits to origin (`git_push`), Cloud Harness MCP uses a GitHub App integration.

## Installation Linking

1. In the **GitHub** section of the dashboard, click **Install GitHub App**.
2. Select your personal GitHub account or organization.
3. Grant access to the specific repositories you want Cloud Harness agents to work with.
4. Upon return, the installation ID is securely bound to your operator principal in the SQLite store.

## How GitHub Credentials Work

- **Ephemeral Tokens:** When an agent pushes or fetches, the Runner generates a 10-minute token for the target repository.
- **Never Saved in Git:** The token is passed directly to the ephemeral helper over `stdin` and is never saved to `.git/config` or disk.
