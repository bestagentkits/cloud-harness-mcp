---
title: Installation & Prerequisites
description: System requirements and setup instructions for Cloud Harness MCP server.
---

# Installation & Prerequisites

<div class="md-twin-hint">
  <strong>AI Crawler / Raw View:</strong> Fetch this page as raw Markdown at <code>/installation.md</code>.
</div>

## System Requirements

- **Linux OS:** Ubuntu 24.04 LTS (recommended) or Debian 12
- **Docker Engine:** 26.0+ with Docker Compose v2
- **Node.js:** 24.x LTS (for local CLI/development)
- **RAM:** Minimum 4GB (8GB recommended for concurrent workspaces)
- **Disk:** Minimum 40GB SSD for container images, jobs, and build caches

## 1-Click Automated Server Installer (Recommended)

Deploy a production-ready CloudHarness MCP server with automated Let's Encrypt TLS (Caddy) or Cloudflare Tunnel in a single command on any clean Linux VPS (Ubuntu 24.04 LTS recommended):

```bash
# Interactive setup (prompts for domain and ingress preference)
curl -fsSL https://raw.githubusercontent.com/bestagentkits/cloud-harness-mcp/main/scripts/install.sh | sudo bash

# Or non-interactive with automated Caddy TLS
curl -fsSL https://raw.githubusercontent.com/bestagentkits/cloud-harness-mcp/main/scripts/install.sh | sudo bash -s -- \
  --domain mcp.example.com \
  --email admin@example.com \
  --non-interactive

# Or with Cloudflare Tunnel (0 open host ports)
curl -fsSL https://raw.githubusercontent.com/bestagentkits/cloud-harness-mcp/main/scripts/install.sh | sudo bash -s -- \
  --ingress tunnel \
  --domain mcp.example.com \
  --tunnel-token "<your-cloudflare-tunnel-token>" \
  --non-interactive
```

The installer automatically:
1. Validates OS, RAM (>= 2GB), and storage prerequisites.
2. Configures Docker CE and Docker Compose plugin.
3. Generates high-entropy cryptographic keys (`MCP_BEARER_TOKEN`, `RUNNER_TOKEN`, and `secret-keyring.json`) with strict `0700`/`0600` permissions.
4. Sets up automated TLS via Caddy reverse proxy or Cloudflare Tunnel attached to the loopback ingress network.
5. Registers and enables `cloud-harness-mcp.service` via systemd.
6. Runs image builds and executes the automated canary health verification.
7. Outputs copy-pasteable client configuration for Claude Desktop and Cursor.

### Managing the Server (`cloudharness` CLI)

Once installed, use the `cloudharness` utility to manage your instance:

```bash
# Check service, container, and ingress health status
cloudharness status

# View service logs
cloudharness logs api -f
cloudharness logs runner -f

# View or safely rotate MCP bearer token
sudo cloudharness token view
sudo cloudharness token rotate

# Upgrade to the latest release
sudo cloudharness upgrade
```

---

## Installing the Companion Agent Skill

You can install the self-contained `cloudharness` agent skill directly from this repository using the [Skills CLI](https://www.npmjs.com/package/skills):

```bash
# Project scope
npx skills add bestagentkits/cloud-harness-mcp --skill cloudharness

# Or global user scope
npx skills add bestagentkits/cloud-harness-mcp --skill cloudharness --global
```

### Claude Code Plugin Marketplace

```bash
claude plugin marketplace add bestagentkits/cloud-harness-mcp
claude plugin install cloud-harness@bestagentkits
```

### OpenAI Codex Plugin

```bash
codex plugin marketplace add bestagentkits/cloud-harness-mcp
codex plugin add cloud-harness@bestagentkits
```

---

## Manual Setup with Docker Compose (Alternative)

1. **Clone the Repository:**
   ```bash
   git clone https://github.com/bestagentkits/cloud-harness-mcp.git
   cd cloud-harness-mcp
   ```

2. **Configure Environment:**
   ```bash
   cp .env.example .env
   # Edit .env and supply your secrets (MCP_BEARER_TOKEN, RUNNER_TOKEN, etc.)
   ```

3. **Build Images and Start Containers:**
   ```bash
   docker compose --profile images build executor-image api runner
   docker compose up -d
   ```

4. **Verify Health:**
   ```bash
   curl http://127.0.0.1:3100/readyz
   # Returns: {"status":"healthy"}
   ```
