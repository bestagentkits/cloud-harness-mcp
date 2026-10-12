---
title: Connecting MCP Clients
description: Protocol lanes, authentication modes, and client routing in Cloud Harness MCP.
---

# Connecting MCP Clients

Cloud Harness MCP provides two distinct connection lanes over **Streamable HTTP MCP**:

```
                                  AI CLIENT
                                      │
                   ┌──────────────────┴──────────────────┐
                   ▼                                     ▼
        Managed OAuth Lane                      Static API Key Lane
  https://harness.zuey.me/mcp            https://api.harness.zuey.me/mcp
                   │                                     │
           Browser OAuth SSO                     Static Header Bearer
        (GitHub / Google via Access)           Authorization: Bearer <key>
                   │                                     │
         • Claude Desktop / ChatGPT Custom App • Cursor / Claude Code
         • Codex App (Loopback OAuth)          • Non-interactive CLI scripts
```

## Protocol Lane Comparison

| Feature | Managed OAuth Lane | Static API Key Lane |
|---|---|---|
| **Public URL** | `https://harness.zuey.me/mcp` | `https://api.harness.zuey.me/mcp` |
| **Authentication** | Cloudflare Access OAuth | Dashboard-managed API Key |
| **Header** | Access JWT Cookie / Bearer | `Authorization: Bearer <api-key>` |
| **Target Clients** | ChatGPT, Web App Connectors | Cursor, Claude Code, Codex, Antigravity |
| **Key Expiry** | Session bound | 1–3,650 days (configurable, approximately 10 years) |
| **Max Keys per Identity** | N/A | 10 active keys |

### Workspace-bound endpoint

`https://harness.zuey.me/mcp/workspaces/<workspaceId>` serves the same tools as
`/mcp` and, for a client that supports the native
[Skills over MCP](/agent-toolkits#skills-over-mcp-native-client-skills)
extension, also that one workspace's `workspace` and `repository` skills.
Connect to it only when you want those skills to appear natively in your client
for a workspace you already opened; use `/mcp` for everything else. It uses the
Managed OAuth lane's host and authentication (or the owner bearer on an
owner-bearer instance); the Static API Key lane forwards only `/mcp` and cannot
reach it. The endpoint stops serving skills once the workspace is closed or its
lease expires.


---

## Local Stdio Mode

In addition to remote Streamable HTTP, Cloud Harness MCP can run locally over **stdio** against a selected folder:

```bash
cloud-harness-mcp --transport stdio --workspace /absolute/path/to/project
```

Local mode exposes the full tool surface directly to the local folder with host-user authority. Closing the workspace terminates processes without deleting the project folder.

---

## Managing API Keys

1. Log into the **Operator Dashboard** at `https://harness.zuey.me/dashboard`.
2. Navigate to **API Keys** in the sidebar.
3. Click **Generate New Key**, specify an expiry (1–3,650 days, approximately 10 years) and label.
4. Copy the revealed key immediately. Store it securely in your local environment or credential vault.

::: danger One-Time Display
API keys are shown exactly once upon creation and cannot be recovered from the database. If lost, revoke the old key and create a new one.
:::

## Supported AI Clients

Select your AI coding tool for specific setup instructions:

- [ChatGPT](/ai-tools/chatgpt)
- [Claude Desktop](/ai-tools/claude)
- [Claude Code](/ai-tools/claude-code)
- [Cursor IDE](/ai-tools/cursor)
- [OpenAI Codex CLI](/ai-tools/codex)
- [Google Gemini CLI](/ai-tools/gemini)
- [Google Antigravity](/ai-tools/antigravity)
- [Grok / xAI](/ai-tools/grok)
