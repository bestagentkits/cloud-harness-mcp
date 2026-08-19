---
title: Concepts & Glossary
description: Essential domain concepts, terminology, and invariants in Cloud Harness MCP.
---

# Concepts & Glossary

<div class="md-twin-hint">
  <strong>AI Crawler / Raw View:</strong> Fetch this page as raw Markdown at <code>/concepts.md</code>.
</div>

## Core Concepts

### Workspace
A bounded, temporary working directory created on the host filesystem at `/var/lib/cloud-harness/jobs/<workspaceId>/repo`. A workspace hosts a clean clone of the target Git repository and is mounted exclusively into a single executor container.

### Executor
The Docker container (`cloud-harness-executor:local`) executing repository commands on behalf of the workspace. It runs with UID/GID 1000 (`node`), has no Docker socket, lacks host mount access, and is isolated by network namespaces.

### Runner
The trusted central daemon (`apps/runner`) responsible for Docker container lifecycle, SQLite state persistence, GitHub App token brokerage, and audit recording. It is not exposed to the public Internet.

### Principal
The authenticated identity invoking MCP tools.
- In **Managed OAuth** mode, the principal is identified by Cloudflare Access claims (`sub`, `email`).
- In **Static API Key** mode, the principal is identified by the API key record created in the dashboard.
Workspaces are strictly isolated between different principals.

### Idempotency Key
A unique client-generated string (8–128 characters) passed to mutating lifecycle operations such as `workspace_open`. If network connectivity drops, sending the same idempotency key recovers the existing workspace without repeating the clone operation.

### Time-To-Live (TTL)
Every workspace enforces two hard lifetime boundaries:
1. **Wall TTL (default 900s / 15 min):** The maximum total duration a workspace may exist before automatic termination.
2. **Idle TTL (default 300s / 5 min):** The maximum period of inactivity between MCP tool calls before cleanup.

### Artifact
Output files generated during workspace execution (logs, test reports, build outputs) that exceed inline MCP message bounds or need to survive container termination. Managed under `/var/lib/cloud-harness/artifacts`.

### Sibling Git Transfer Helper
An ephemeral container spawned by the Runner to handle `git_fetch`, `git_pull`, and `git_push`. It mounts the workspace repository as a sibling, receives a 10-minute GitHub App installation token via `stdin`, talks only to `github.com`, and is immediately destroyed.
