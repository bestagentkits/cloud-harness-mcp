---
title: Security & Threat Model
description: Security boundaries, trust domains, and isolation mechanisms in Cloud Harness MCP.
---

# Security & Threat Model

<div class="md-twin-hint">
  <strong>AI Crawler / Raw View:</strong> Fetch this page as raw Markdown at <code>/security-model.md</code>.
</div>

## Intended Trust Model

Cloud Harness MCP is intentionally a **private, single-owner remote coding harness**. It allows arbitrary repository-controlled execution inside a constrained executor, but it is **not a hostile multi-tenant sandbox**.

## Defensive Layers

### 1. Ingress & Control Plane Isolation
- The Ingress Proxy is the only service bound to external loopback.
- The API and Runner never publish host ports directly.
- The API has no access to the Docker socket or host filesystem mounts.

### 2. Executor Confinement
- **Non-Root User:** Containers execute as UID 1000 (`node`).
- **No Docker Authority:** No socket mount or privileged capabilities.
- **Default Network `none`:** Outbound network is disabled unless explicitly requested as `bridge`.

### 3. Credential Safety
- Private clone and push tokens exist only in memory during the lifetime of the ephemeral Git helper.
- Tokens are streamed over `stdin` and never stored in environment variables, configuration files, or repository commit history.
