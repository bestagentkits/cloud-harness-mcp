---
title: Connect ChatGPT to Cloud Harness MCP
description: Step-by-step configuration for ChatGPT Custom MCP Apps via Managed OAuth.
---

# ChatGPT Custom MCP App

<div class="md-twin-hint">
  <strong>AI Crawler / Raw View:</strong> Fetch this page as raw Markdown at <code>/ai-tools/chatgpt.md</code>.
</div>

ChatGPT supports remote MCP connectors via Developer Mode using Managed OAuth.

## Prerequisites

- ChatGPT Plus, Team, or Enterprise subscription with Developer Mode enabled.
- Cloudflare Access SSO account (GitHub/Google) authorized for the Cloud Harness instance.

## Setup Instructions

1. In ChatGPT, navigate to **Settings** (or **Workspace Settings**) → **Apps** → **Create Custom App**.
2. Set the **Server URL** to:
   ```text
   https://harness.zuey.me/mcp
   ```
3. Select **OAuth** as the authentication method.
4. Click **Connect & Authorize**. A browser popup will direct you to Cloudflare Access login.
5. Complete Google or GitHub authentication.
6. Once authorized, ChatGPT will scan and register the 52 Cloud Harness MCP tools.

::: tip Cloud Connection Note
ChatGPT communicates directly from OpenAI infrastructure to `https://harness.zuey.me/mcp`. No local port-forwarding or reverse tunnel is required.
:::
