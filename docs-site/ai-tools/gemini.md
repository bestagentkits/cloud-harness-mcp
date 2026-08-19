---
title: Connect Google Gemini CLI to Cloud Harness MCP
description: Configuring Google Gemini CLI for remote Streamable HTTP MCP.
---

# Google Gemini CLI

<div class="md-twin-hint">
  <strong>AI Crawler / Raw View:</strong> Fetch this page as raw Markdown at <code>/ai-tools/gemini.md</code>.
</div>

## Configuration

Set your authorization token in your shell environment:

```bash
export CLOUD_HARNESS_MCP_TOKEN="<YOUR_DASHBOARD_API_KEY>"
```

Add the server to Gemini CLI settings or pass it via command-line flags:

```bash
gemini mcp add cloud-harness \
  --url https://api.harness.zuey.me/mcp \
  --header "Authorization: Bearer $CLOUD_HARNESS_MCP_TOKEN"
```
