---
title: Connect Grok / xAI to Cloud Harness MCP
description: Integrating Cloud Harness MCP with xAI Responses API.
---

# Grok / xAI Responses API

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
