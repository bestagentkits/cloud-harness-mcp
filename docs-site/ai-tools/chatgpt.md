---
title: Connect ChatGPT to Cloud Harness MCP
description: Step-by-step configuration for ChatGPT Custom MCP Apps via Managed OAuth.
---

# ChatGPT Custom MCP App

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

### Step-by-Step Connector Setup

1. In ChatGPT Web, click your avatar → **Settings** (or **Workspace Settings**) → **Connected apps** / **Create new plugin / connector**.
2. Name the connector (e.g. `CloudHarness`).
3. Set the **Server URL** to:
   ```text
   https://harness.zuey.me/mcp
   ```
4. Select **OAuth** as the Authentication method.
5. Click **Create** (or **Connect & Authorize**).
6. A browser popup will open the Cloudflare Access login page (GitHub or Google SSO). Complete authentication to link the connector.
7. Once authorized, ChatGPT scans and registers the Cloud Harness MCP tool definitions.

### Developer Mode (Draft) vs. Published Custom Connector

ChatGPT provides two distinct execution modes for custom MCP apps:

1. **Developer Mode (Draft / Dev Connector):**
   - When first created, the connector is in **Draft (Dev)** state, visible under **Settings → Apps → Enabled Apps** with a **Dev** label.
   - **Prerequisites:** Developer Mode must be actively enabled for your user account (**Settings → Apps → Advanced Settings → Developer mode**).
   - **Supported Surfaces:** Testing is supported in standard 1-on-1 ChatGPT Web conversations with the draft app selected.
2. **Workspace Published (Custom Connector):**
   - To make CloudHarness accessible across your workspace without requiring each member to manage Developer Mode, a Workspace Admin/Owner must publish the connector.
   - Navigate to **Workspace Settings → Apps → Drafts**, select the connector, configure allowed actions and group access via RBAC, and click **Publish**.
   - Once published, the connector displays the **custom** label and is available to all authorized workspace members according to workspace action controls.

::: tip Plan & Feature Availability
Full MCP execution (including write/execute operations such as `workspace_open` and `exec_run`) is provided in beta for ChatGPT **Business, Enterprise, and Edu** plans. Feature availability, UI paths, and permissions follow OpenAI's [Developer mode and MCP apps in ChatGPT guide](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt).
:::

---

## 3. Troubleshooting

### `FORBIDDEN: This conversation does not support developer MCPs`

**Cause:** ChatGPT discovered the MCP tool schemas, but the active conversation context or account configuration prohibits executing draft/developer-mode MCP tools. This occurs in any of the following conditions:

1. **Unsupported Conversation Context:** Developer MCPs (draft apps) cannot be invoked in Custom GPTs, Project chats (unless permitted by project settings), Canvas mode, temporary chats, or ChatGPT mobile apps.
2. **Developer Mode Disabled:** The connector is in draft state, but Developer Mode is toggled off in the current user account settings.
3. **Draft State in Workspace Conversations:** The connector has not yet been published by a Workspace Admin/Owner and is being accessed in a standard team conversation.
4. **Plan Tier Gating:** The ChatGPT plan tier does not support full MCP write actions in developer mode.
5. **Stale Thread Cache:** An existing chat thread started prior to connector authorization retained an earlier tool configuration.

**Fix:**

1. **Use Standard 1-on-1 Web Chats:** Open a fresh conversation on ChatGPT Web, mention `@CloudHarness` or select the connector from the tools menu, and initiate the task.
2. **Enable Developer Mode:** Go to **Settings → Apps → Advanced Settings** (or **Workspace Settings → Permissions & Roles**) and ensure **Developer mode** is toggled **ON**.
3. **Publish to Workspace (Admins):** In **Workspace Settings → Apps → Drafts**, review the tool actions and click **Publish** to convert the draft into an approved workspace **Custom Connector**.
4. **Verify Plan Support:** Confirm your workspace has access to full MCP support (Business, Enterprise, or Edu plan).
5. **Start a Fresh Thread:** If the connector was just created or re-authorized, open a new chat session to refresh conversation capabilities.

---

### `Dynamic client registration failed (invalid_client_metadata: redirect_uri is not allowed)`
**Cause:** Cloudflare Access rejected ChatGPT's callback URL during Dynamic Client Registration.
**Fix:**
1. In ChatGPT's connector modal, expand **Advanced OAuth settings** to view the exact redirect URI assigned to your connector.
2. Verify that `https://chatgpt.com/connector/oauth/*` (or the exact URI shown in the modal) is listed in **Allowed redirect URIs** in your Cloudflare Zero Trust dashboard.
3. Save the Cloudflare application and retry creating the connector.
