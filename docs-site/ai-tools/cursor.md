---
title: Connect Cursor IDE to Cloud Harness MCP
description: Adding Cloud Harness MCP to Cursor settings via Streamable HTTP.
---

# Cursor IDE

<div class="md-twin-hint">
  <strong>AI Crawler / Raw View:</strong> Fetch this page as raw Markdown at <code>/ai-tools/cursor.md</code>.
</div>

Cursor supports Cloud Harness MCP via **Streamable HTTP** (for remote cloud workspaces) and **stdio** (for direct local project workspaces).

## Option 1: Remote HTTP (API Key Gateway)

1. In Cursor, open **Cursor Settings** (`Cmd+,` on macOS, `Ctrl+,` on Windows/Linux).
2. Navigate to **Features** → **MCP Servers** → click **Add New MCP Server**.
3. Fill in the server details:
   - **Name:** `cloud-harness`
   - **Type:** `sse` or `http`
   - **Server URL:** `https://api.harness.zuey.me/mcp`
   - **Headers:** `{"Authorization": "Bearer <YOUR_DASHBOARD_API_KEY>"}`
4. Click **Save** and verify the status indicator turns green with 52 tools active.

---

## Option 2: Local Stdio Mode

For editing a local project folder directly without uploading to a remote VPS, configure `.cursor/mcp.json` in your project or global user directory:

```json
{
  "mcpServers": {
    "cloud-harness-local": {
      "command": "node",
      "args": [
        "/path/to/cloud-harness-mcp/apps/api/dist/index.js",
        "--transport",
        "stdio",
        "--workspace",
        "/absolute/path/to/project"
      ]
    }
  }
}
```
