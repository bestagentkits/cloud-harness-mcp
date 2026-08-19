---
title: Connect Grok / xAI to Cloud Harness MCP
description: Integrating Cloud Harness MCP with xAI Responses API.
---

# Grok / xAI Responses API

<div class="md-twin-hint">
  <strong>AI Crawler / Raw View:</strong> Fetch this page as raw Markdown at <code>/ai-tools/grok.md</code>.
</div>

## API Configuration

When using the xAI Responses API with remote tool calling, pass the static API gateway endpoint in your request tool definitions:

```json
{
  "tools": [
    {
      "type": "mcp",
      "mcp": {
        "server_url": "https://api.harness.zuey.me/mcp",
        "headers": {
          "Authorization": "Bearer <YOUR_DASHBOARD_API_KEY>"
        }
      }
    }
  ]
}
```

Ensure only required write tools are allowlisted if running unattended tasks.
