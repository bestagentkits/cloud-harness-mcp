---
title: Connect Cursor IDE to Cloud Harness MCP
description: Adding Cloud Harness MCP to Cursor settings via Streamable HTTP.
---

# Cursor IDE

<div class="md-twin-hint">
  <strong>AI Crawler / Raw View:</strong> Fetch this page as raw Markdown at <code>/ai-tools/cursor.md</code>.
</div>

Cursor supports remote MCP servers over HTTP with custom request headers.

## Configuration

1. In Cursor, open **Cursor Settings** (`Cmd+,` on macOS, `Ctrl+,` on Windows/Linux).
2. Navigate to **Features** → **MCP Servers** → click **Add New MCP Server**.
3. Fill in the server details:
   - **Name:** `cloud-harness`
   - **Type:** `sse` or `http`
   - **Server URL:** `https://api.harness.zuey.me/mcp`
   - **Headers:** `{"Authorization": "Bearer <YOUR_DASHBOARD_API_KEY>"}`
4. Click **Save** and verify the status indicator turns green with 52 tools active.
