---
title: Connect OpenAI Codex to Cloud Harness MCP
description: Adding Cloud Harness MCP to Codex configuration file.
---

# OpenAI Codex

Codex App and the Codex CLI can connect to Cloud Harness MCP via **Native OAuth (Recommended)** or via the **Static API Key Gateway**.

## Option 1: Native OAuth Flow (Recommended)

Codex connects directly to the Managed OAuth endpoint using loopback OAuth callback redirection.

### 1. Cloudflare Zero Trust Configuration
In your Cloudflare Zero Trust application under **Advanced settings → Managed OAuth → Allowed redirect URIs**, add:
- `http://127.0.0.1:3118/callback/*`
- `http://127.0.0.1:3118/*`
- `http://localhost:3118/callback/*`
- `http://localhost:3118/*`

### 2. Client Configuration
Add the server with a pinned callback port in `~/.codex/config.toml`:

```toml
mcp_oauth_callback_port = 3118

[mcp_servers.cloudharness]
enabled = true
url = "https://harness.zuey.me/mcp"
[mcp_servers.cloudharness.oauth]
callback_port = 3118
```

### 3. Authenticate
- **In the Codex App UI:** Go to **Plugins** → **MCPs** → Click **Authenticate** next to `cloudharness`.
- **From the CLI:** Run:
  ```bash
  codex mcp login cloudharness
  ```
Complete the login in the browser window that opens.

---

## Option 2: Static API Key Gateway

For non-interactive or static-header usage, use the dedicated API key gateway:

1. Generate a managed key in the Dashboard at `/dashboard/api-keys`.
2. Set your environment variable:
   ```bash
   export CLOUD_HARNESS_MCP_TOKEN="<YOUR_DASHBOARD_API_KEY>"
   ```
3. Configure `~/.codex/config.toml`:
   ```toml
   [mcp_servers.cloudharness]
   enabled = true
   url = "https://api.harness.zuey.me/mcp"
   bearer_token_env_var = "CLOUD_HARNESS_MCP_TOKEN"
   ```
4. Verify the server in Codex:
   ```bash
   codex mcp list
   ```

---

## Option 3: Local Stdio Mode

To connect Codex directly to a local project folder:

```toml
[mcp_servers.cloudharness_local]
command = "node"
args = ["/path/to/cloud-harness-mcp/apps/api/dist/index.js", "--transport", "stdio", "--workspace", "/absolute/path/to/project"]
```
