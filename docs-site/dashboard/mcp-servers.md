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
- **Tools** — the cached tool list, searchable by name or description.
- **Permissions** — allow or deny each tool, or fall back to the server default.
- **Logs** — metadata-only records of gateway calls to that server.

The breadcrumb returns to the list, and the rail keeps **MCP Servers** current on
every detail tab.
