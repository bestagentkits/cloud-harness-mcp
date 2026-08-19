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

## Running the Server with Docker Compose

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
   curl http://127.0.0.1:3000/health
   # Returns: {"status":"healthy"}
   ```
