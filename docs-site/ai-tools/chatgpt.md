---
title: Connect ChatGPT to Cloud Harness MCP
description: Step-by-step configuration for ChatGPT Custom MCP Apps via Managed OAuth.
---

# ChatGPT Custom MCP App

<div class="md-twin-hint">
  <strong>AI Crawler / Raw View:</strong> Fetch this page as raw Markdown at <code>/ai-tools/chatgpt.md</code>.
</div>

ChatGPT supports remote MCP connectors via Developer Mode / Custom Plugins using Managed OAuth.

## 1. Cloudflare Zero Trust Configuration

Before connecting ChatGPT Web, configure the OAuth callback endpoints in your Cloudflare Zero Trust dashboard:

1. Log into [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) → **Access controls** → **Applications**.
2. Click **Edit** on the application protecting `harness.zuey.me`.
3. Navigate to **Advanced settings** → **Managed OAuth**.
4. Under **Allowed redirect URIs**, add:
   - `https://chatgpt.com/connector/oauth/*`
   - `https://chatgpt.com/connector_platform_oauth_redirect`
   - `https://chatgpt.com/api/aip/p/oauth/callback`
5. Click **Save application**.

::: tip Least-Privilege Scoping
Always scope ChatGPT redirect URIs to `https://chatgpt.com/connector/oauth/*` rather than a broad wildcard `https://chatgpt.com/*` to avoid leaking authorization codes on arbitrary endpoints.
:::

---

## 2. Setup Instructions in ChatGPT

1. In ChatGPT Web, click your avatar → **Settings** (or **Workspace Settings**) → **Connected apps** / **Create new plugin / connector**.
2. Name the connector (e.g. `CloudHarness`).
3. Set the **Server URL** to:
   ```text
   https://harness.zuey.me/mcp
   ```
4. Select **OAuth** as the Authentication method.
5. Click **Create** (or **Connect & Authorize**).
6. A browser popup will open the Cloudflare Access login page (GitHub or Google SSO). Complete authentication to link the connector.
7. Once authorized, ChatGPT registers the Cloud Harness MCP tools.

---

## 3. Troubleshooting

### `Dynamic client registration failed (invalid_client_metadata: redirect_uri is not allowed)`
**Cause:** Cloudflare Access rejected ChatGPT's callback URL during Dynamic Client Registration.
**Fix:**
1. In ChatGPT's connector modal, expand **Advanced OAuth settings** to view the exact redirect URI assigned to your connector.
2. Verify that `https://chatgpt.com/connector/oauth/*` (or the exact URI shown in the modal) is listed in **Allowed redirect URIs** in your Cloudflare Zero Trust dashboard.
3. Save the Cloudflare application and retry creating the connector.
