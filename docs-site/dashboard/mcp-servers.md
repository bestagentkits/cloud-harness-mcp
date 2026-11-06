---
title: MCP Servers
description: Manage the downstream MCP servers your Cloud Harness MCP Gateway exposes to AI agents.
---

# MCP Servers

`/dashboard/mcp-servers` manages the MCP Hub: the downstream MCP servers that your
[MCP Gateway](/mcp-gateway) endpoint fronts. Select **MCP Servers** in the rail's
**Configure** group, or search for it in the command palette.

## How an agent finds the right tool

Your AI client connects one endpoint and always sees five tools, however many servers
you register. The page's gateway card shows that endpoint with a copy button and,
when the deployment enables the managed API-key lane, a second copyable endpoint
(`https://api.harness.zuey.me/mcp-gateway`) for clients that authenticate with a
key from [API Keys](/dashboard/api-keys). Otherwise the card says the lane is not
enabled. It explains the flow:

1. `search` finds a `server.tool` from a plain description of the need, across every
   enabled server the caller may use, and can be narrowed to one server.
2. `inspect` returns that one tool's input schema and permission.
3. `execute` runs it, re-checking permission on every call.
4. `permissions` and `status` report what is allowed and which servers are connected.

Because schemas load only on `inspect`, adding servers does not grow the client's
context window.

## Manage servers

The **Registered servers** list shows each server's transport, status, and tool count.
From it you can add, edit, test, refresh tools, enable or disable, and delete a server.
[Add an MCP server](/mcp-gateway#add-an-mcp-server) lists the fields.

Open a server to reach `/dashboard/mcp-servers/:serverId`, with tabs for:

- **Overview** — connection details, status, and whether the server is enabled.
  A server set to **Authenticate with OAuth** also shows an **OAuth** panel with
  its sign-in state (`Not configured`, `Authorization required`, `Authorizing`,
  `Connected`, `Reauthorization required`, or `Error`), the issuer, granted
  scopes, and token expiry, plus **Connect** (or **Reconnect** /
  **Reauthorize**) and **Disconnect**. `Not configured` means the operator has
  not set the OAuth redirect URL, so **Connect** is hidden until they do. See
  [Connect an OAuth-protected server](/mcp-gateway#connect-an-oauth-protected-server).
- **Tools** — the cached tool list, searchable by name or description.
- **Permissions** — allow or deny each tool, or fall back to the server default.
- **Logs** — metadata-only records of gateway calls to that server.

The breadcrumb returns to the list, and the rail keeps **MCP Servers** current on
every detail tab.

## In the new dashboard

In the [new dashboard](index.md#new-dashboard-preview), a server's detail tabs (Overview, Tools,
Permissions, Logs) are part of the address, for example `/dashboard/mcp-servers/<id>?tab=logs`,
so you can link to or reload a tab. Switching tabs replaces the address rather than adding
history entries, so Back leaves the server page. Header values are masked, and
closing the add or edit dialog clears everything you typed. A change that races another
edit is refused and the list reloads with the latest version; an open edit dialog is
refilled with that version for you to review before saving again. If the settings save but
the enabled switch then fails, the dialog says *Saved; enabled state not changed* and saving
again retries only on top of what was saved.
