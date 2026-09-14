---
title: Operator Dashboard Overview
description: Tour of the Cloud Harness Mission Control operator dashboard.
---

# Operator Dashboard

The **Mission Control** operator dashboard is available at `https://harness.zuey.me/dashboard`. It provides operators with live visibility into active workspaces, security audit logs, API key management, and GitHub App integrations.

## Key Sections

- **[Workspaces](/dashboard/workspaces):** Inspect live Docker containers, open files, interactive shells, and close running workspaces.
- **[Projects](/dashboard/projects):** Track repositories and manage project-scoped environment configurations.
- **[Secrets & Credentials](/dashboard/secrets):** Manage global and project-scoped credentials encrypted at rest with AES-256-GCM and automatic ingest-time output stream redaction.
- **[Subagent Models](/dashboard/models):** Configure LLM provider credentials, model profiles, token pricing, and capability limits for Pi subagents.
- **[API Keys](/dashboard/api-keys):** Create and revoke static API keys for IDE and local CLI tools.
- **[GitHub App](/dashboard/github):** Manage GitHub App installation bindings for private repository cloning and push access.
- **[Artifacts](/dashboard/artifacts):** Download and inspect workspace output files, build logs, and test results.
- **[Audit Trail](/dashboard/audit):** Review immutable security logs of every tool invocation and authorization event.
- **[Profile & Preferences](/dashboard/profile):** View signed-in identity details, edit the display name shown in the top-bar chip, and switch the theme with the icon control in the top bar, which cycles System, Light, and Dark and persists server-side.

## Search and Version

- **Search:** press `CMD+K` or `CTRL+K` (or use the search button in the top bar) to jump to any dashboard page or find a workspace, project, secret, API key, model credential or profile, or artifact. Results cover the first page of each resource type. Memories and journals are searched on the Knowledge page, which has its own search. Press `Escape` or tap/click outside the palette to close it.
- **Server version:** the left rail shows the version of the running MCP server, so you can confirm which build answered a request. The rail stays fixed beside the page and scrolls on its own when the navigation is taller than the window.
- **Account controls:** the top-bar chip shows your display name and opens the Profile page; the adjacent icon signs you out.

Every dashboard page ends with the same footer crediting [AgentKit](https://agentkit.best).

## Design System & Security Invariants

- **Zero Secrets Rendered:** Container tokens, SSH private keys, and runner authentication credentials are never sent to or displayed in the dashboard. Dashboard search reads an allowlisted projection from seven resource endpoints and never indexes secret values, secret descriptions, or knowledge content.
- **No Client Storage:** Theme preferences and session states are managed strictly via HttpOnly cookies and server session headers. Search results are cached in memory for the current page view only.
- **Strict Content Security Policy (CSP):** Runs under `default-src 'none'` with no external CDN dependencies or tracking scripts.
