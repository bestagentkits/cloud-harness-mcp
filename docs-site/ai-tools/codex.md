---
title: Connect OpenAI Codex to Cloud Harness MCP
description: Adding Cloud Harness MCP to Codex configuration file.
---

# OpenAI Codex

<div class="md-twin-hint">
  <strong>AI Crawler / Raw View:</strong> Fetch this page as raw Markdown at <code>/ai-tools/codex.md</code>.
</div>

Codex uses TOML-based configuration for remote MCP endpoints.

## Configuration

Set your environment variable:

```bash
export CLOUD_HARNESS_MCP_TOKEN="<YOUR_DASHBOARD_API_KEY>"
```

Add the following block to `~/.codex/config.toml` (or `.codex/config.toml` in your project root):

```toml
[mcp_servers.cloud_harness]
url = "https://api.harness.zuey.me/mcp"
bearer_token_env_var = "CLOUD_HARNESS_MCP_TOKEN"
required = true
tool_timeout_sec = 300
default_tools_approval_mode = "writes"
```

Restart Codex and verify:

```bash
codex mcp list
```
