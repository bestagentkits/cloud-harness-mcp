---
title: Operator Dashboard Overview
description: Tour of the Cloud Harness Mission Control operator dashboard.
---

# Operator Dashboard

The **Mission Control** operator dashboard is available at `https://harness.zuey.me/dashboard`. It provides operators with live visibility into active workspaces, security audit logs, API key management, and GitHub App integrations.

## Key Sections

- **[Workspaces](/dashboard/workspaces):** Inspect live Docker containers, open files, interactive shells, and close running workspaces.
- **[Projects](/dashboard/projects):** Track repositories that have been cloned into workspaces.
- **[API Keys](/dashboard/api-keys):** Create and revoke static API keys for IDE and local CLI tools.
- **[GitHub App](/dashboard/github):** Manage GitHub App installation bindings for private repository cloning and push access.
- **[Artifacts](/dashboard/artifacts):** Download and inspect workspace output files, build logs, and test results.
- **[Audit Trail](/dashboard/audit):** Review immutable security logs of every tool invocation and authorization event.
- **[Profile & Preferences](/dashboard/profile):** View signed-in identity details and configure server-persisted theme preferences (System, Light, Dark).

## Design System & Security Invariants

- **Zero Secrets Rendered:** Container tokens, SSH private keys, and runner authentication credentials are never sent to or displayed in the dashboard.
- **No Client Storage:** Theme preferences and session states are managed strictly via HttpOnly cookies and server session headers.
- **Strict Content Security Policy (CSP):** Runs under `default-src 'none'` with no external CDN dependencies or tracking scripts.
