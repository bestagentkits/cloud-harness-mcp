---
title: Self-Hosting & Deployment
description: Deploying a private Cloud Harness MCP server on your own infrastructure.
---

# Self-Hosting & Deployment

Cloud Harness MCP is designed for straightforward self-hosting on any modern Linux VPS or cloud instance.

## Deployment Architectures

### 1. 1-Click Automated Deployment (Caddy / Cloudflare Tunnel)

For a modern, zero-fuss self-hosted deployment on standard Linux (Ubuntu 24.04 LTS):

```bash
# Single-command install with Let's Encrypt TLS (Caddy)
curl -fsSL https://raw.githubusercontent.com/bestagentkits/cloud-harness-mcp/main/scripts/install.sh | sudo bash
```

- **Caddy Ingress:** Automatically requests and renews Let's Encrypt TLS certificates, proxying traffic to the loopback ingress `127.0.0.1:3100`.
- **Cloudflare Tunnel:** Connects `cloudflared` directly to the `ingress` network, exposing zero host listening ports.
- **Management:** Uses the `cloudharness` CLI (`cloudharness status`, `cloudharness logs`, `cloudharness token`).

### 2. Traditional NGINX Reverse Proxy Runbook

For custom infrastructure with existing NGINX setups:

1. **Bootstrap VPS:** Run `deploy/scripts/bootstrap-vps.sh` to install Docker, systemd unit, and permissions.
2. **Deploy Release:** Run `deploy/scripts/deploy-release.sh <git-sha>` to build and start production containers. The deploy runs as a host systemd unit (`cloud-harness-deploy-<sha>`), so a dropped SSH session does not interrupt it; follow it with `journalctl -fu cloud-harness-deploy-<sha>`.
3. **Canary Verification:** Run `scripts/deploy-canary.mjs` to execute an automated end-to-end workspace test against the newly deployed instance.

To use [webhook automations](/dashboard/automations) (GitHub, Linear, Jira, or a custom sender), set `AUTOMATIONS_ENABLED=true` for the API and runner. The release's nginx upgrade installs the `/integrations/webhooks/` route. If Cloudflare Access protects the hostname, add an Access bypass for that path only; the webhook signature is its authentication.

When you deploy from GitHub Actions (`.github/workflows/deploy.yml`), each merge to `main` deploys once. If that merge cuts a release, the Release workflow requests a second CI run for its version commit and production deploys the tagged commit once that run passes, so the reported server version matches the newest release tag. That adds one CI cycle before the merge reaches production. If the version commit's CI fails, the merge itself deploys instead; a flaky failure can be retried with `gh workflow run ci.yml --ref main` while the version commit is still the head of `main`.
