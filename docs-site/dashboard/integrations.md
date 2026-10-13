---
title: Integrations
description: GitHub App authorization for private repository access on this instance.
---

# Integrations

`/dashboard/integrations` holds the instance's GitHub App authorization: the
installation bindings that let workspaces clone and push private repositories. See
[GitHub Bindings](/dashboard/github) for the permissions and troubleshooting details.

Downstream MCP servers are not an integration tab. They are the MCP Hub behind your
gateway endpoint and have their own rail entry, [MCP Servers](/dashboard/mcp-servers).

## Compatibility

`/dashboard/integrations/github` and `/dashboard/github` open this page, so existing
bookmarks keep working. `/dashboard/integrations/mcp-servers`, where MCP servers
briefly lived as a tab, redirects to `/dashboard/mcp-servers`.
