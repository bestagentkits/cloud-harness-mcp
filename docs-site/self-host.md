---
title: Self-Hosting & Deployment
description: Deploying a private Cloud Harness MCP server on your own infrastructure.
---

# Self-Hosting & Deployment

Cloud Harness MCP is designed for straightforward self-hosting on any modern Linux VPS or cloud instance.

## Deployment Stack

- **Compose Stack:** `compose.production.yaml` defines the loopback ingress, stateless API, and runner daemon.
- **Systemd Service:** `deploy/systemd/cloud-harness-mcp.service` ensures auto-restart and proper shutdown lifecycle.
- **NGINX Reverse Proxy:** Terminates SSL, manages WebSocket upgrade for PTY sessions, and strips untrusted upstream headers.

## Production Runbook

1. **Bootstrap VPS:** Run `deploy/scripts/bootstrap-vps.sh` to install Docker, systemd unit, and permissions.
2. **Deploy Release:** Run `deploy/scripts/deploy-release.sh <git-sha>` to build and start production containers.
3. **Canary Verification:** Run `scripts/deploy-canary.mjs` to execute an automated end-to-end workspace test against the newly deployed instance.
