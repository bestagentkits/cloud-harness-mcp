---
title: Integrations
description: One page for GitHub authorization and downstream MCP server connections.
---

# Integrations

`/dashboard/integrations` is where external connections live, so each new integration
does not become another rail entry. Select **Integrations** in the rail, then pick a
tab from the strip above the page content:

- **GitHub** (`/dashboard/integrations/github`) — GitHub App installation bindings for
  private repository cloning and push access. See [GitHub Bindings](/dashboard/github)
  for the permissions and troubleshooting details.
- **MCP Servers** (`/dashboard/integrations/mcp-servers`) — downstream MCP servers,
  their tools, permissions, and logs. See [MCP Gateway](/mcp-gateway) for the gateway
  endpoint and client configuration.

## Compatibility

`/dashboard/github` and `/dashboard/mcp-servers` redirect to the matching tab, so
existing bookmarks and links keep working. A single MCP server's detail view remains at
`/dashboard/mcp-servers/:serverId` and marks Integrations as the current rail entry.

## Why one page

The previous navigation gave GitHub and MCP Servers a rail slot each. That mirrors the
subsystems rather than the operator's intent, and it does not scale: every new
integration would widen the rail. One Integrations page keeps the rail stable while the
tabs grow, and the command palette still reaches each connection surface directly.
