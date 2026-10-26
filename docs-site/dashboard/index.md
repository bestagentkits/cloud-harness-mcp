---
title: Operator Dashboard Overview
description: Tour of the Cloud Harness Mission Control operator dashboard.
---

# Operator Dashboard

The **Mission Control** operator dashboard is available at `https://harness.zuey.me/dashboard`. It is organised around operator intent — **Home**, **Operate**, **Configure**, **Data**, and **Admin** — rather than around the subsystems behind it. `/dashboard` is the Overview; it answers four questions above the fold (what needs attention, what is running, what it costs, and what expires soon) and every tile links into the filtered view that explains it.

## Key Sections

- **[Overview](/dashboard/):** Decision metrics first — Needs attention, Running now, Cost (with the scope it measured), and Expiring soon — then an Analytics section, then Access and Server information. Each figure links to the view behind it.
- **[Workspaces](/dashboard/workspaces):** Open, inspect, and finalize TTL-limited workspaces. Each workspace opens as a cockpit with Summary, Agents, Runtime, Terminal, Files, Git, Automation, Deploy, Artifacts, and Activity sections plus Renew lease, Finalize, recover and close actions.
- **[Terminal](/dashboard/terminal):** An interactive shell inside a workspace, from the cockpit's Terminal tab, plus `/dashboard/terminals` for every live terminal across your workspaces.
- **[Agents](/dashboard/agents):** Every coding agent across your workspaces with its parent-child hierarchy, status, model profile, age, TTL, tokens, cost, and budget utilisation; each agent opens into Overview, Usage, bounded Logs, and Messages (steer, follow-up, cancel).
- **[Traces](/dashboard/traces):** One durable trace per coding-agent run with a KPI strip (errors, tokens, cost, latency p50/p95, time to first token), filters, a span waterfall, reconciliation against the usage ledger, and JSON, CSV, or OTLP JSON export. Shown only when the operator enables agent traces.
- **[Automations](/dashboard/automations):** Start a budgeted, read-only agent run when a chosen label is added to a GitHub issue or pull request. Runs, Rules, Connections, and Deliveries views; off unless the operator enables automations.
- **[Activity](/dashboard/activity):** One operational timeline with All, Agents, Tasks, MCP, Deployments, and Audit filters. Runtime rows are live; audit rows are retained and redacted, and every row says which it is.
- **[Approvals](/dashboard/approvals):** Privilege grants with their real status, the requested command, workspace, working directory, and command digest. Approve and Reject appear only on unexpired pending grants, and the rail counts only those.
- **[Projects](/dashboard/projects):** Track repositories and manage project-scoped environment configurations.
- **[Knowledge](/dashboard/knowledge):** Memories and journals with search, a link graph, and an editor that keeps unsaved drafts across a reload and asks before you leave one.
- **[Secrets & Credentials](/dashboard/secrets):** Manage global and project-scoped credentials encrypted at rest with AES-256-GCM and automatic ingest-time output stream redaction. Creating a secret is a dialog; the value is write-only.
- **[Models & Budgets](/dashboard/models):** Configure LLM provider credentials, model profiles, token pricing, and capability limits for coding agents.
- **[Skills & Skill Sets](/dashboard/skills):** Manage the skill library, provider imports, skill sets, and the toolkit registry.
- **[Integrations](/dashboard/integrations):** GitHub App authorization for private repository access. `/dashboard/github` redirects here.
- **[MCP Servers](/dashboard/mcp-servers):** The MCP Hub behind your gateway endpoint: register downstream MCP servers, search their tools, set permissions, and read call logs.
- **[Artifacts](/dashboard/artifacts):** Download and inspect workspace output files, build logs, and test results.
- **[API Access](/dashboard/api-keys):** Create and revoke static gateway keys for IDE and local CLI tools.
- **[Audit Logs](/dashboard/audit):** The durable security record, also reachable as the Audit filter inside the Activity Center.
- **[Settings](/dashboard/settings):** Instance-wide defaults applied to newly opened workspaces, and how long MCP OAuth clients stay signed in.
- **[Profile & Preferences](/dashboard/profile):** View signed-in identity details, edit the display name shown in the top-bar chip, and switch the theme with the icon control in the top bar, which cycles System, Light, and Dark and persists server-side. Profile has no rail entry: the top-bar chip and the command palette are its entry points.

## Search and Version

- **Search:** press `CMD+K` or `CTRL+K` (or click the "Search or jump to…" field in the top bar) to jump to any dashboard page or find a workspace, project, secret, API key, model credential or profile, or artifact. Results cover the first page of each resource type. Memories and journals are searched on the Knowledge page, which has its own search. Press `Escape` or tap/click outside the palette to close it.
- **Server version:** the left rail shows the version of the running MCP server, so you can confirm which build answered a request. The rail stays fixed beside the page and scrolls on its own when the navigation is taller than the window.
- **Account controls:** the top-bar chip shows your display name and opens the Profile page; the adjacent icon signs you out.

Every dashboard page ends with the same footer crediting [AgentKit](https://agentkit.best).

## New dashboard preview

A rebuilt dashboard is rolling out behind the `CLOUD_HARNESS_DASHBOARD_UI` setting, which defaults to `legacy`. To try it in one browser without changing the instance, add `?ui=react` to any dashboard address, such as `/dashboard?ui=react`; add `?ui=legacy` (or use **Use classic Dashboard** in its sidebar) to switch back, and you stay on the same page. The choice is stored in a browser cookie only. Your theme choice follows you between both versions.

In the new dashboard:

- **Pages keep their addresses.** Every page and deep link of the classic dashboard has the same `/dashboard/...` address, filters stay in the URL, and reload, Back and Forward return you to the same view. Pages whose controls have not moved yet link to the classic dashboard. Inbox, Traces, Automations and Agent policies have no page in the new dashboard yet: their addresses show a not-found page with an **Open classic Dashboard** link, so use the classic dashboard (`?ui=legacy`) for them until they move. For a workspace with several repositories, also use the classic dashboard: the new Terminal, Files and Git views do not pick a repository yet.
- **Command palette:** press `Ctrl+K` or `Cmd+K`, or click **Search**, to jump to a page, a recently opened workspace, the current page's main action, a theme, or the assistant. The shortcut is ignored while you type in a terminal.
- **[Assistant](/dashboard/assistant):** the **Assistant** button opens an embedded operator agent that can open pages, read what you see and prepare changes. Every change it prepares waits for your confirmation in a dialog that shows the exact request.
- **Shortcuts:** `[` collapses or expands the sidebar, and `/` moves focus to the workspace search box.
- **Small screens:** the menu button in the top bar opens the navigation as a drawer.
- **Display preferences:** text size, density, contrast and the sidebar state are saved in this browser only. The theme is saved to your account cookie. Animations are turned off when your system asks for reduced motion.
- **Migrated pages:** Overview, Workspaces, Agents (list and detail), Activity, Audit, Projects and environments, Knowledge, Skills, Profile and Settings run in the new dashboard with the same data and actions as the classic pages. Their filters, tabs and selected item are part of the address, so a copied link opens the same view. Activity shows the pending approvals summary, while approving and rejecting stay on the classic Approvals page for now; the TypeSafe key is also still entered on the classic Settings page.
- **Workspace cockpit:** the Summary, Agents, Runtime and Activity tabs work in the new dashboard; Runtime shows each task's output (`?task=` in the address) and lets you open, read and close shell sessions. The Terminal, Files, Git, Automation, Deploy and Artifacts tabs still open the classic cockpit.

## Design System & Security Invariants

- **Zero Secrets Rendered:** Container tokens, SSH private keys, and runner authentication credentials are never sent to or displayed in the dashboard. Dashboard search reads an allowlisted projection from seven resource endpoints and never indexes secret values, secret descriptions, or knowledge content.
- **No Client Storage (legacy dashboard):** In the current dashboard, theme preferences and session states are managed strictly via HttpOnly cookies and server session headers, and search results are cached in memory for the current page view only. The React Dashboard keeps the theme in the same HttpOnly cookie and may also store non-secret display settings and UI state in the browser. Secrets, keys, tokens and terminal output are never stored in the browser in either version.
- **Strict Content Security Policy (CSP):** Runs under `default-src 'none'` with no external CDN dependencies or tracking scripts. The terminal emulator is a pinned copy served by the harness itself, under the same policy.
