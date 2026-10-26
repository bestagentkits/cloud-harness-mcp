---
title: API Keys Management
description: Creating, monitoring, and revoking static MCP gateway API keys.
---

# API Keys

Static API keys allow IDE extensions (Cursor), local CLI agents (Claude Code, Codex), and scripts to authenticate against `https://api.harness.zuey.me/mcp` without an interactive browser OAuth flow. The same key also reaches the [MCP Gateway](/mcp-gateway) at `https://api.harness.zuey.me/mcp-gateway`. Keys have no per-endpoint scopes: any active key can run the downstream MCP tools you allowed in **MCP Servers**, using the secrets you configured for them, so revoke a key you suspect has leaked.

## Key Rules & Limits

- **Maximum Active Keys:** Up to 10 active keys per operator identity.
- **Configurable Lifetime:** 1 day to 3,650 days (approximately 10 years).
- **One-Time Secret Reveal:** Keys are shown only once upon generation.
- **Instant Revocation:** Revoking a key denies any ongoing or future MCP requests instantly.

## Generating a Key

1. Navigate to **API Access** in the dashboard.
2. Click **Create API key** (the page's single accented action).
3. Choose a descriptive label (e.g. `Cursor Workstation M1`) and select an expiration timeframe.
4. Copy the key value immediately (`chm_key_...`).

The key is shown once, in a dialog, and cannot be recovered. Creation moves into that
dialog rather than sitting under the list, and the action is disabled with an explanation
when the key limit is reached or the gateway is not ready.

## In the new dashboard

The [new dashboard](index.md#new-dashboard-preview) shows a new key once, in a dialog that
only **I have saved it** or Escape closes. The key disappears if you leave the page, reload,
or your dashboard session ends, and it is never kept in the browser, so copy it before you
move on. A lost key cannot be shown again: revoke it and create another.
