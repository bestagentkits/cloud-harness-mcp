---
layout: home
title: Cloud Harness MCP
hero:
  name: Cloud Harness MCP
  text: Remote Coding, Under One Owner
  tagline: A private remote coding harness exposed through authenticated Streamable HTTP MCP. Isolated clones, non-root Docker executors, TTL bounds, and full code intelligence.
  actions:
    - theme: brand
      text: Get Started →
      link: /getting-started
    - theme: alt
      text: Tools Reference
      link: /reference/tools
    - theme: alt
      text: Connect AI Tools
      link: /ai-tools/overview
features:
  - title: Single-Owner Private Model
    details: Designed intentionally for one trusted operator or team. Arbitrary execution capability inside shared-kernel executors with strict boundary separation.
  - title: Streamable HTTP MCP
    details: Supports both Managed OAuth (Cloudflare Access SSO) and dashboard-managed static API keys for local/IDE connectors.
  - title: Sandboxed Executors
    details: Non-root execution in TTL-limited Docker containers with default network mode "none" and no control plane secrets.
  - title: Credential-Isolated Git
    details: Sibling transfer helper handles GitHub App authentication over stdin. Executors never see GitHub App tokens or push keys.
  - title: Rich Tool Surface
    details: 52 public MCP tools covering file operations, AST symbols, grep search, PTY shells, background sessions, and DAG task graphs.
  - title: Mission Control Dashboard
    details: Embedded dark/light web console for managing active workspaces, repositories, API keys, artifacts, and security audits.
---

<div class="md-twin-hint">
  <strong>AI Crawlers:</strong> Browse clean Markdown for any page by appending <code>.md</code> to the URL (e.g. <code>/getting-started.md</code>), or read the complete index at <a href="/llms.txt">/llms.txt</a> and <a href="/llms-full.txt">/llms-full.txt</a>.
</div>

## Architecture at a Glance

Cloud Harness separates request validation from Docker execution authority:

```
[ AI Client ] (OAuth / API Key)
       │
       ▼
[ Credential-Free Ingress Proxy ]
       │
       ▼
[ Stateless MCP API ]
       │ (Authenticated Private RPC)
       ▼
[ Trusted Runner ] ──► [ Docker Authority ] ──► [ Non-Root Executor ]
       │                                              │
       ├─► [ SQLite State Store ]                     └─► [ Isolated Repo Clone ]
       └─► [ GitHub App Broker ] ─(stdin)─► [ Ephemeral Git Helper ]
```

## Quick Endpoints

| Protocol Lane | Public Endpoint | Authentication Method |
|---|---|---|
| **Managed OAuth** | `https://harness.zuey.me/mcp` | Cloudflare Access (GitHub/Google SSO) |
| **Static API Key** | `https://api.harness.zuey.me/mcp` | `Authorization: Bearer <dashboard-api-key>` |
| **Operator Dashboard** | `https://harness.zuey.me/dashboard` | Browser SSO Session |
| **Documentation** | `https://docs.harness.agentkit.best` | Public (Static Pages) |
