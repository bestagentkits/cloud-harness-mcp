---
title: Frequently Asked Questions
description: Answers to common questions about Cloud Harness MCP server.
---

# Frequently Asked Questions (FAQ)

### What makes Cloud Harness MCP different from standard local MCP servers?
Standard local MCP servers execute tools directly on your workstation with your user credentials and full filesystem permissions. Cloud Harness runs on a remote host inside dedicated, TTL-limited Docker containers, preventing rogue scripts or malicious dependencies from accessing your local machine.

### Can multiple people share one Cloud Harness instance?
Yes, under a mutual trust model. Each operator logs in via Cloudflare Access SSO or uses distinct API keys. Workspaces and artifacts are isolated by principal ID. However, because containers share the host kernel, it should only be operated by trusted team members.

### How does Git push work without storing my SSH key in the container?
When you call `git_push`, the runner provisions a short-lived ephemeral Alpine container, pipes an installation token from the GitHub App broker over `stdin`, pushes to `github.com`, and immediately destroys the container. The workspace container never sees the token.

### What happens if I forget to close a workspace?
Workspaces automatically expire when their idle TTL (5 minutes without tool calls) or wall TTL (15 minutes total duration) is reached. All containers and temporary files are permanently cleaned up.
