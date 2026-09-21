---
title: Operator Dashboard Overview
description: Tour of the Cloud Harness Mission Control operator dashboard.
---

# Operator Dashboard

The **Mission Control** operator dashboard is available at `https://harness.zuey.me/dashboard`. It is organised around operator intent — **Home**, **Operate**, **Configure**, **Data**, and **Admin** — rather than around the subsystems behind it. `/dashboard` is the Overview; it answers four questions above the fold (what needs attention, what is running, what it costs, and what expires soon) and every tile links into the filtered view that explains it.

## Key Sections

- **[Overview](/dashboard/):** Decision metrics first — Needs attention, Running now, Cost (with the scope it measured), and Expiring soon — then an Analytics section, then Access and Server information. Each figure links to the view behind it.
- **[Workspaces](/dashboard/workspaces):** Open, inspect, and finalize TTL-limited workspaces. Each workspace opens as a cockpit with Summary, Agents, Runtime, Files, Git, Automation, Deploy, Artifacts, and Activity sections plus Renew lease, Finalize, recover and close actions.
- **[Agents](/dashboard/agents):** Every coding agent across your workspaces with its parent-child hierarchy, status, model profile, age, TTL, tokens, cost, and budget utilisation; each agent opens into Overview, Usage, bounded Logs, and Messages (steer, follow-up, cancel).
- **[Activity](/dashboard/activity):** One operational timeline with All, Agents, Tasks, MCP, Deployments, and Audit filters. Runtime rows are live; audit rows are retained and redacted, and every row says which it is.
- **[Approvals](/dashboard/approvals):** Pending privilege grants with the requested command, workspace, working directory, and command digest, plus Approve and Reject. The rail shows a count only while something is pending.
- **[Projects](/dashboard/projects):** Track repositories and manage project-scoped environment configurations.
- **[Secrets & Credentials](/dashboard/secrets):** Manage global and project-scoped credentials encrypted at rest with AES-256-GCM and automatic ingest-time output stream redaction. Creating a secret is a dialog; the value is write-only.
- **[Models & Budgets](/dashboard/models):** Configure LLM provider credentials, model profiles, token pricing, and capability limits for coding agents.
- **[Skills & Skill Sets](/dashboard/skills):** Manage the skill library, provider imports, skill sets, and the toolkit registry.
- **[Integrations](/dashboard/integrations):** One page for external connections, with GitHub and MCP Servers as its two tabs. `/dashboard/github` and `/dashboard/mcp-servers` redirect here.
- **[Artifacts](/dashboard/artifacts):** Download and inspect workspace output files, build logs, and test results.
- **[API Access](/dashboard/api-keys):** Create and revoke static gateway keys for IDE and local CLI tools.
- **[Audit Logs](/dashboard/audit):** The durable security record, also reachable as the Audit filter inside the Activity Center.
- **[Settings](/dashboard/settings):** Instance-wide defaults applied to newly opened workspaces.
- **[Profile & Preferences](/dashboard/profile):** View signed-in identity details, edit the display name shown in the top-bar chip, and switch the theme with the icon control in the top bar, which cycles System, Light, and Dark and persists server-side. Profile has no rail entry: the top-bar chip and the command palette are its entry points.

## Search and Version

- **Search:** press `CMD+K` or `CTRL+K` (or use the search button in the top bar) to jump to any dashboard page or find a workspace, project, secret, API key, model credential or profile, or artifact. Results cover the first page of each resource type. Memories and journals are searched on the Knowledge page, which has its own search. Press `Escape` or tap/click outside the palette to close it.
- **Server version:** the left rail shows the version of the running MCP server, so you can confirm which build answered a request. The rail stays fixed beside the page and scrolls on its own when the navigation is taller than the window.
- **Account controls:** the top-bar chip shows your display name and opens the Profile page; the adjacent icon signs you out.

Every dashboard page ends with the same footer crediting [AgentKit](https://agentkit.best).

## Design System & Security Invariants

- **Zero Secrets Rendered:** Container tokens, SSH private keys, and runner authentication credentials are never sent to or displayed in the dashboard. Dashboard search reads an allowlisted projection from seven resource endpoints and never indexes secret values, secret descriptions, or knowledge content.
- **No Client Storage:** Theme preferences and session states are managed strictly via HttpOnly cookies and server session headers. Search results are cached in memory for the current page view only.
- **Strict Content Security Policy (CSP):** Runs under `default-src 'none'` with no external CDN dependencies or tracking scripts.
