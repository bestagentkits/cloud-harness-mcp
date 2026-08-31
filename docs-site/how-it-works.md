---
title: How It Works
description: System architecture and request flow of the Cloud Harness MCP remote coding harness.
---

# How It Works

<div class="md-twin-hint">
  <strong>AI Crawler / Raw View:</strong> Fetch this page as raw Markdown at <code>/how-it-works.md</code>.
</div>

Cloud Harness MCP is architected as a split control plane and execution runtime. This separation ensures that Internet-facing request handlers never possess Docker authority, while isolated containers executing repository code never inherit control plane credentials.

## System Architecture

```
                               PUBLIC INTERNET
                                      │
                 ┌────────────────────┴────────────────────┐
                 │                                         │
        (Managed OAuth Lane)                     (Static API Key Lane)
                 │                                         │
                 ▼                                         ▼
        Cloudflare Access                       Cloudflare Worker Gateway
                 │                                         │
                 └────────────────────┬────────────────────┘
                                      │
                                      ▼
                        Ingress Proxy (NGINX Loopback)
                                      │
                         ┌────────────┴────────────┐
                         │  CONTROL PLANE (TRUSTED)│
                         │                         │
                         │   Stateless MCP API     │
                         │          │ (RPC)        │
                         │          ▼              │
                         │     Runner Service      │
                         │      ├── SQLite State   │
                         │      ├── Docker Auth    │
                         │      └── GitHub Broker  │
                         └────────────┬────────────┘
                                      │
                    ┌─────────────────┴─────────────────┐
                    │                                   │
                    ▼                                   ▼
        ┌───────────────────────┐           ┌───────────────────────┐
        │   WORKSPACE EXECUTOR  │           │   GIT TRANSFER HELPER │
        │  • Non-root (UID 10001│           │  • Ephemeral bare repo│
        │  • 3-Zone Storage     │           │  • GitHub App Token   │
        │  • Network: NONE (def)│           │    passed via STDIN   │
        │  • No Docker socket   │           │  • Origin-only push   │
        │  • TTL auto-cleanup   │           │  • Ephemeral cleanup  │
        └───────────────────────┘           └───────────────────────┘
```

## Request Flow

1. **Client Connection:**
   The AI agent (Claude, ChatGPT, Cursor, etc.) connects to either the Managed OAuth endpoint (`https://harness.zuey.me/mcp`) or the Static API Key endpoint (`https://api.harness.zuey.me/mcp`).
2. **Ingress & Authentication:**
   The Ingress Proxy strips untrusted headers and forwards verified JSON-RPC requests over loopback to the stateless **MCP API**.
3. **Policy & Lifecycle Execution:**
   The API performs JSON schema validation against `TOOL_SCHEMA_BY_NAME` and issues an internal RPC to the **Runner**. The Runner validates principal permissions, checks concurrency bounds, and orchestrates the workspace container.
4. **Isolated Execution:**
   The **Workspace Executor** is spawned from `cloud-harness-executor:local`. The repository is cloned into a dedicated directory. Commands, file edits, and tasks execute inside this container under user `harness` (UID 10001) across partitioned user-space toolchain directories (`/opt/user-tools`) and temporary home (`/tmp/cloud-harness-home`).
5. **Credential-Free Git Origin Transfer:**
   When `git_push` is invoked, the Runner starts an ephemeral helper container, streams a short-lived GitHub App installation token over `stdin`, pushes to GitHub origin, and immediately tears down the helper. The workspace executor never touches or observes the token.
6. **Result Normalization:**
   Structured output is truncated to safety bounds (e.g. 64KB per file read, 1MB per exec run) and returned through the Streamable HTTP connection.

## Key Invariants

- **Default Network: `network-none`** — Workspace executors cannot access LAN or WAN unless explicitly started with `networkProfile: "dependency-access"`, which permits only public DNS and TCP 80/443 through an attested Linux host firewall that blocks private, control-plane, and metadata ranges.
- **No Docker-in-Docker** — The Docker socket is never mounted into the workspace container.
- **Idempotent Lifecycle** — `workspace_open` requires an `idempotencyKey`. If a client disconnects and retries with the same key, it attaches to the existing workspace rather than starting a duplicate clone.
- **TTL Bounds** — Workspaces enforce both a wall-clock TTL (default 15 minutes) and an idle TTL (default 5 minutes). When expired, all files and containers are permanently scrubbed.
