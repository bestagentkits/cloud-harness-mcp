---
title: Connect Claude Desktop to Cloud Harness MCP
description: Setting up Claude Desktop with Cloud Harness MCP via API Key gateway.
---

# Claude Desktop

<div class="md-twin-hint">
  <strong>AI Crawler / Raw View:</strong> Fetch this page as raw Markdown at <code>/ai-tools/claude.md</code>.
</div>

Claude Desktop can connect to Cloud Harness MCP via **Native OAuth (Recommended)** or via the **Static API Key Gateway**.

## Option 1: Native OAuth via Connectors UI (Recommended)

Claude Desktop supports native OAuth 2.0 with Dynamic Client Registration (RFC 7591) and Cloudflare Access Managed OAuth.

1. In Cloudflare Zero Trust, ensure **Allowed redirect URIs** includes:
   - `https://claude.ai/api/mcp/auth_callback`
   - `https://claude.com/api/mcp/auth_callback`
2. Open **Claude Desktop** → Go to **Settings** → **Connectors** (or **Add custom connector**).
3. Enter the Managed OAuth URL:
   ```text
   https://harness.zuey.me/mcp
   ```
4. Click **Connect**. Claude Desktop will open your default browser to complete authentication via Cloudflare Access (GitHub or Google SSO) and link the connector.

---

## Option 2: Static API Key Gateway

For environments using static headers, configure `claude_desktop_config.json`:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

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

Restart Claude Desktop and check the tool availability in your chat view.

---

## Option 3: Local Stdio Mode (Direct Folder Access)

To operate directly on a local project directory without remote cloud hosting, configure `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cloud_harness_local": {
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
