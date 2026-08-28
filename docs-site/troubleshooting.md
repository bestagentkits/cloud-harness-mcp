---
title: Troubleshooting & Diagnostics
description: Resolution playbooks for common errors, clone issues, and runtime states.
---

# Troubleshooting & Diagnostics

<div class="md-twin-hint">
  <strong>AI Crawler / Raw View:</strong> Fetch this page as raw Markdown at <code>/troubleshooting.md</code>.
</div>

## Common Issues & Fixes

### 1. `docker: No such image: cloud-harness-executor:local`
**Cause:** Local executor image was pruned by a host Docker cleanup or never built.
**Fix:** Rebuild the image from the project root:
```bash
docker compose --profile images build executor-image
```

---

### 2. `repository clone failed: unauthorized`
**Cause:** Attempting to clone a private repository without a valid GitHub App installation.
**Fix:**
1. Open the Operator Dashboard → **GitHub**.
2. Click **Install GitHub App** and authorize the target repository.
3. Ensure the repository URL matches the format `https://github.com/owner/repo.git`.

---

### 3. `workspace expired: TTL exceeded`
**Cause:** The workspace reached its 15-minute wall-clock limit or 5-minute idle limit.
**Fix:** Workspaces are ephemeral by design. Re-open a workspace using `workspace_open` with a fresh idempotency key.

---

### 4. API Key Denied (`401 Unauthorized`)
**Cause:** Expired key, revoked key, or key used against the Managed OAuth URL instead of the gateway.
**Fix:**
- Ensure the client URL is `https://api.harness.zuey.me/mcp` (NOT `https://harness.zuey.me/mcp`).
- Verify key validity in the Dashboard under **API Keys**.

---

### 5. OAuth DCR Error (`redirect_uri is not allowed by the account configuration`)
**Cause:** Cloudflare Access Managed OAuth rejected Dynamic Client Registration because the client's callback URL was not allowlisted.
**Fix:**
1. Log into [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) → **Access controls** → **Applications**.
2. Edit the application for your MCP hostname → **Advanced settings** → **Managed OAuth**.
3. Add the required callback URLs to **Allowed redirect URIs**:
   - **Claude Desktop:** `https://claude.ai/api/mcp/auth_callback` and `https://claude.com/api/mcp/auth_callback`
   - **Codex App / Native Clients:** Pin `mcp_oauth_callback_port = 3118` in `~/.codex/config.toml` and add `http://127.0.0.1:3118/callback/*`, `http://127.0.0.1:3118/*`, `http://localhost:3118/callback/*`, and `http://localhost:3118/*`.
   - **ChatGPT Web:** `https://chatgpt.com/connector/oauth/*`, `https://chatgpt.com/connector_platform_oauth_redirect`, and `https://chatgpt.com/api/aip/p/oauth/callback`.

---

### 6. Frequent MCP Sign-out or Re-authentication Prompts in AI Tools
**Cause:** When connecting via Managed OAuth (`https://harness.zuey.me/mcp`), client continuity depends on Cloudflare Access's **Grant session duration** (refresh token lifetime). When the grant expires, the client prompts for interactive browser re-authentication.

**Fix:**
1. **Adjust Managed OAuth Grant Session Duration (OAuth Clients):**
   - Log into [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) → **Access controls** → **Applications**.
   - Edit the MCP application → **Advanced settings** → **Managed OAuth**.
   - Set **Grant session duration** to your preferred continuity interval (Cloudflare recommends 1–2 weeks for CLI/agent clients, or longer up to 1 month where supported by the tenant).
   - Keep the **Access token lifetime** short (5–15 minutes, default 15 minutes) so silent refresh and policy re-evaluation continue normally.
2. **Switch to Static API Key Gateway (Zero-Reauth for Coding Tools):**
   - For IDE/CLI coding agents (Claude Code, Cursor, Codex, etc.) that support static headers, generate an API key from the Dashboard at `https://harness.zuey.me/dashboard/api-keys` (configurable for 1 to 3,650 days, approximately 10 years).
   - Configure the tool to connect directly to `https://api.harness.zuey.me/mcp` with `Authorization: Bearer <api-key>` to eliminate interactive OAuth prompts entirely.

---

### 7. Local Stdio: `--workspace path must be absolute` or Directory Error
**Cause:** The `--workspace` argument provided to `cloud-harness-mcp --transport stdio` is relative, does not exist, or points to a regular file instead of a directory.
**Fix:** Provide a valid, existing absolute directory path (e.g. `/home/user/project` or `/mnt/c/Users/user/project` in WSL). Native Windows path formats (like `C:\...`) are unsupported in v1 local stdio mode; run the process inside WSL instead.
