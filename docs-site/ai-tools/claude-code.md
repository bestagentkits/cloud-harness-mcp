---
title: Connect Claude Code to Cloud Harness MCP
description: Registering Cloud Harness MCP in Claude Code CLI with local authorization headers.
---

# Claude Code

<div class="md-twin-hint">
  <strong>AI Crawler / Raw View:</strong> Fetch this page as raw Markdown at <code>/ai-tools/claude-code.md</code>.
</div>

Claude Code CLI natively connects to remote Streamable HTTP MCP servers.

## Quick Setup

Export your dashboard-managed API key in your shell:

```bash
export CLOUD_HARNESS_MCP_TOKEN="<YOUR_DASHBOARD_API_KEY>"
```

Register the server globally for your user:

```bash
claude mcp add cloud-harness \
  --transport http \
  --url https://api.harness.zuey.me/mcp \
  --header "Authorization=Bearer $CLOUD_HARNESS_MCP_TOKEN" \
  --scope user
```

## Verify Tools

Start Claude Code and inspect available tools:

```bash
claude
/mcp
```

You should see `cloud-harness` listed with 52 available tools.
