---
title: Connect Claude Desktop to Cloud Harness MCP
description: Setting up Claude Desktop with Cloud Harness MCP via API Key gateway.
---

# Claude Desktop

<div class="md-twin-hint">
  <strong>AI Crawler / Raw View:</strong> Fetch this page as raw Markdown at <code>/ai-tools/claude.md</code>.
</div>

Claude Desktop can connect to Cloud Harness MCP through its configuration file using an HTTP proxy or static API key.

## Configuration

Open your Claude Desktop configuration file:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Add the `cloud_harness` entry under `mcpServers`:

```json
{
  "mcpServers": {
    "cloud_harness": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-fetch",
        "https://api.harness.zuey.me/mcp"
      ],
      "env": {
        "AUTHORIZATION": "Bearer <YOUR_DASHBOARD_API_KEY>"
      }
    }
  }
}
```

Restart Claude Desktop and check the hammer icon to verify tool availability.
