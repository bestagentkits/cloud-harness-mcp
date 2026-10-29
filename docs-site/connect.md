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
| **[MCP Gateway](/mcp-gateway) URL** | `https://harness.zuey.me/mcp-gateway` | `https://api.harness.zuey.me/mcp-gateway` |
| **Authentication** | Cloudflare Access OAuth | Dashboard-managed API Key |
| **Header** | Access JWT Cookie / Bearer | `Authorization: Bearer <api-key>` |
| **Target Clients** | ChatGPT, Web App Connectors | Cursor, Claude Code, Codex, Antigravity |
| **Key Expiry** | OAuth grant duration ([Settings](/dashboard/settings#mcp-oauth-sessions)) | 1–3,650 days (configurable, approximately 10 years) |
| **Max Keys per Identity** | N/A | 10 active keys |

### Workspace-bound endpoint

`https://harness.zuey.me/mcp/workspaces/<workspaceId>` serves the same tools as
`/mcp` and, for a client that supports the native
[Skills over MCP](/agent-toolkits#skills-over-mcp-native-client-skills)
extension, also that one workspace's `workspace` and `repository` skills.
Connect to it only when you want those skills to appear natively in your client
for a workspace you already opened; use `/mcp` for everything else. It uses the
Managed OAuth lane's host and authentication (or the owner bearer on an
owner-bearer instance); the Static API Key lane forwards only `/mcp` and
`/mcp-gateway`, so it cannot reach it. The endpoint stops serving skills once the workspace is closed or its
lease expires.

### Signing in with agentkit.best

An instance can also accept agentkit.best accounts on a separate hostname
(`https://harness.agentkit.best/mcp` for the first-party instance). Add that URL
as a remote MCP server; the client discovers agentkit.best from the server's
protected resource metadata and opens the agentkit.best consent page for the
`cloud-harness:workspace` scope. Only the agentkit.best accounts the operator
listed can connect, and each gets its own workspaces. The MCP gateway is not
served on that hostname. Revoke access any time under Account → Connected apps
on agentkit.best. Operators enable the lane with the `AGENTKIT_AUTH_*` settings
in the [environment reference](/reference/environment-variables).


---

## Local Stdio Mode

In addition to remote Streamable HTTP, Cloud Harness MCP can run locally over **stdio** against a selected folder:

```bash
cloud-harness-mcp --transport stdio --workspace /absolute/path/to/project
```

Local mode exposes the full tool surface directly to the local folder with host-user authority. Closing the workspace terminates processes without deleting the project folder.

### Several local workspaces from one server

To serve several persistent project folders, for example on a dev VM or a host
with mounted volumes, register them in one operator-owned config file and pass
its absolute path with `--workspace-config` instead of `--workspace`:

```yaml
# /etc/cloud-harness/workspaces.yaml (JSON with the same shape also works)
version: 1
workspaces:
  api:
    path: /srv/projects/api
  web:
    path: /mnt/volumes/web
    gitNetwork: true   # optional per-workspace override of --git-network
    gitPush: false     # optional per-workspace override of --git-push
http:                  # optional; used only with --transport http
  host: 127.0.0.1
  port: 3100
```

The file is the only way to register a folder: no tool can add, move, or rename
one. The server refuses to start when the file has unknown fields, duplicate
keys, YAML aliases, or invalid names, or when a path is missing, not a
directory, registered twice, or nested inside another registered path. The
exact schema and defaults are owned by
[`local-workspace-registry.ts`](https://github.com/bestagentkits/cloud-harness-mcp/blob/main/apps/api/src/local/local-workspace-registry.ts).

Every registered folder is already open. Call `workspace_list` to get each
entry's `name`, `root`, `rootAvailable`, and `workspaceId`. The ID is derived
from the name and the resolved folder, so it stays the same across restarts and
changes only when you rename the entry or move the folder. Pass `workspaceId` on
every call whenever more than one folder is registered.

**Stdio (one client):**

```bash
claude mcp add cloud-harness-local --transport stdio -- \
  node /path/to/cloud-harness-mcp/apps/api/dist/index.js \
  --transport stdio --workspace-config /etc/cloud-harness/workspaces.yaml
```

Over stdio, `workspace_set_active` picks a default folder for that one process.

**Local HTTP (several clients, one long-running process):**

```bash
MCP_BEARER_TOKEN_FILE=/etc/cloud-harness/local-token \
  node /path/to/cloud-harness-mcp/apps/api/dist/index.js \
  --transport http --workspace-config /etc/cloud-harness/workspaces.yaml

claude mcp add --transport http cloud-harness-local http://127.0.0.1:3100/mcp \
  --header "Authorization: Bearer $(cat /etc/cloud-harness/local-token)"
```

This serves the registered folders at `/mcp` and needs a bearer token of 32 to
512 characters in `MCP_BEARER_TOKEN` or `MCP_BEARER_TOKEN_FILE`. It does not use
Docker or the runner. Because requests share no session, `workspace_set_active`
is rejected and every call must name its `workspaceId`, unless only one folder
is registered. Keep the default loopback bind; if a client reaches it through
another host name or a browser origin, add that name to `http.publicHosts` or
the origin to `http.allowedOrigins`.

If a folder disappears or is replaced (for example an NFS mount drops), calls to
it fail with a retryable `UNAVAILABLE` error and `workspace_list` reports
`rootAvailable: false` until the mount returns. `workspace_close` stops that
folder's processes without deleting files, and `workspace_recover` reopens it
with the same ID.

::: warning Host authority
Every registered folder runs commands as the host user that started the server.
Path confinement stops tool paths from escaping a folder, but it is not a
sandbox. Use this mode only for one trusted operator. See the
[security model](https://github.com/bestagentkits/cloud-harness-mcp/blob/main/docs/security-model.md#local-stdio-security-model).
:::

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
