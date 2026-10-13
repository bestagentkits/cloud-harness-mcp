---
phase: 1
title: "OSS 1-Click Installer & Production Compose Pipeline"
status: pending
priority: P1
effort: "5d"
dependencies: []
---

# Phase 01: OSS 1-Click Installer & Production Compose Pipeline

## Overview
Deliver a frictionless, secure, one-command installation pipeline (`curl -fsSL https://get.cloudharness.io | bash`) for the open-source community to deploy CloudHarness MCP on standard Linux servers (Ubuntu, Debian, Rocky Linux). The installer strictly follows the verified repository deployment architecture (`deploy/scripts/bootstrap-vps.sh`, `deploy/scripts/deploy-release.sh`, `deploy/scripts/release-runtime.sh`, and `deploy/systemd/cloud-harness-mcp.service`): checking out the repository into `/opt/cloud-harness-mcp/repo`, configuring `/etc/cloud-harness-mcp/runtime.env` with `MCP_BEARER_TOKEN`, an independent `RUNNER_TOKEN`, container-mounted `SECRET_KEYRING_FILE=/run/cloud-harness-secrets/secret-keyring.json` (written on the host at `/etc/cloud-harness-mcp/secret-keyring.json`), provisioning Caddy TLS to forward to loopback ingress `127.0.0.1:3100`, installing systemd service `cloud-harness-mcp.service`, and executing the authoritative deployment script `/usr/local/sbin/cloud-harness-deploy <RELEASE_SHA>` to build required images (`executor-image`, `api`, `runner`), start systemd, verify readiness at `127.0.0.1:3100/readyz`, and run the deployment canary probe.

## Requirements
- **Functional:**
  - **Preflight System Verification:**
    - Verify root/sudo privileges (`EUID == 0` or invoke `sudo`).
    - Verify OS family (`/etc/os-release` for Debian, Ubuntu, RHEL, Rocky Linux).
    - Validate available RAM (>= 2GB), storage (>= 10GB under `/var/lib/cloud-harness`), and architecture (x86_64, aarch64).
    - Detect port conflicts on 80/443.
  - **Directory Structure & Permissions (`bootstrap-vps.sh` & `deploy-release.sh`):**
    - Install & Repo root: `/opt/cloud-harness-mcp` (mode `0755`) and `/opt/cloud-harness-mcp/repo` (mode `0755`).
    - Config & secrets: `/etc/cloud-harness-mcp/` (mode `0700`).
    - State & Backups: `/var/lib/cloud-harness/state` (mode `0700`), `/var/lib/cloud-harness/backups` (mode `0700`).
    - Jobs, Artifacts & Repos: `/var/lib/cloud-harness/jobs` (mode `0750`), `/var/lib/cloud-harness/artifacts` (mode `0750`), `/var/lib/cloud-harness/cache/repos` (mode `0750`).
  - **Repository Checkout & Release Pinning:**
    - Clone repository into `/opt/cloud-harness-mcp/repo` with blob filtering: `git clone --filter=blob:none https://github.com/bestagentkits/cloud-harness-mcp.git /opt/cloud-harness-mcp/repo`.
    - Resolve target 40-character commit SHA (e.g. pinned stable release SHA).
  - **Cryptographic Key & Secret Generation (Exact Contract):**
    - Generate `MCP_BEARER_TOKEN` (48-byte base64 random secret) for client bearer authentication.
    - Generate independent `RUNNER_TOKEN` (48-byte base64 random secret) for private API-to-Runner service communication.
    - Generate host secret file `/etc/cloud-harness-mcp/secret-keyring.json` (mode `0600`) matching `SecretKeyringConfigSchema`:
      `{"activeVersion": 1, "keys": [{"version": 1, "key": "<base64-32-byte-secret>"}]}`.
    - Set `SECRET_KEYRING_FILE=/run/cloud-harness-secrets/secret-keyring.json` in `runtime.env` (since `compose.production.yaml` mounts `/etc/cloud-harness-mcp:/run/cloud-harness-secrets:ro` inside the runner container).
    - Write `/etc/cloud-harness-mcp/runtime.env` (mode `0600`) populated with standard configuration keys.
  - **Ingress & TLS Automation:**
    - Direct Domain: Caddy reverse proxy on host port 80/443 terminating TLS and forwarding upstream to loopback ingress `http://127.0.0.1:3100`.
    - Zero-Port Cloudflare Tunnel: `cloudflared` overlay container attached to the non-internal `ingress` Compose network, routing traffic directly to `http://ingress:3100` without publishing host ports.
  - **Authoritative First Deployment (`deploy-release.sh` invocation):**
    - Install helper scripts:
      - `/usr/local/sbin/cloud-harness-deploy` -> `deploy/scripts/deploy-release.sh`
      - `/usr/local/sbin/cloud-harness-rollback` -> `deploy/scripts/rollback-release.sh`
      - `/usr/local/sbin/cloud-harness-upgrade-nginx` -> `deploy/scripts/upgrade-nginx-dashboard.sh`
      - Systemd unit `/etc/systemd/system/cloud-harness-mcp.service` -> `deploy/systemd/cloud-harness-mcp.service`
    - Execute `/usr/local/sbin/cloud-harness-deploy "$RELEASE_SHA"` which performs:
      1. Detaches checkout to `$RELEASE_SHA`.
      2. Builds required images: `docker compose -f compose.yaml -f compose.production.yaml --profile images build executor-image api runner`.
      3. Enables and starts systemd unit: `systemctl enable --now cloud-harness-mcp.service`.
      4. Polls readiness: `wait_ready` on `http://127.0.0.1:3100/readyz`.
      5. Verifies running image IDs (`verify_running_images`).
      6. Executes MCP smoke initialize request with `MCP_BEARER_TOKEN` and runs `/app/scripts/deploy-canary.mjs`.
  - **Lifecycle Management CLI (`bin/cloudharness`):**
    - Commands: `status`, `logs`, `restart`, `upgrade`, `token create`.
    - Symlinked to `/usr/local/bin/cloudharness`.
  - **Non-interactive / Headless Mode:**
    - Support `--non-interactive`, `--domain <DOMAIN>`, `--email <EMAIL>` for automated script deployments.

## Architecture & Installation Flow

```text
                               ┌──────────────────────────────────────────────┐
                               │  User runs: curl https://.../install.sh | sh │
                               └──────────────────────┬───────────────────────┘
                                                      │
                                                      ▼
                                       ┌──────────────────────────────┐
                                       │ 1. Preflight System Checks   │
                                       │    (RAM, Disk, OS, Ports)    │
                                       └──────────────┬───────────────┘
                                                      │
                                                      ▼
                                       ┌──────────────────────────────┐
                                       │ 2. Docker & Compose Setup    │
                                       │    (Official Docker CE repo) │
                                       └──────────────┬───────────────┘
                                                      │
                                                      ▼
                                       ┌──────────────────────────────┐
                                       │ 3. Bootstrap Dirs & Secrets  │
                                       │    /opt/cloud-harness-mcp/   │
                                       │    /repo (git clone & pin)   │
                                       │    /etc/cloud-harness-mcp/   │
                                       │    runtime.env & keyring.json│
                                       └──────────────┬───────────────┘
                                                      │
                                                      ▼
                                       ┌──────────────────────────────┐
                                       │ 4. Caddy / Tunnel Ingress    │
                                       │    Forwards to 127.0.0.1:3100│
                                       └──────────────┬───────────────┘
                                                      │
                                                      ▼
                                       ┌──────────────────────────────┐
                                       │ 5. cloud-harness-deploy <SHA>│
                                       │    - Build images (executor) │
                                       │    - Start systemd service   │
                                       │    - Verify 127.0.0.1:3100/ready
                                       │    - Run Canary Verification │
                                       └──────────────┬───────────────┘
                                                      │
                                                      ▼
                                       ┌──────────────────────────────┐
                                       │ 6. Output MCP Connection JSON│
                                       │    Claude Desktop & Cursor   │
                                       └──────────────────────────────┘
```

## Configuration Schema Reference (`/etc/cloud-harness-mcp/runtime.env`)

```ini
# Generated by cloudharness installer
AUTH_MODE=owner-bearer
OWNER_ID=owner
MCP_BEARER_TOKEN=<generated-base64-token>
RUNNER_TOKEN=<generated-independent-token>
# Container mount path (mounted from host /etc/cloud-harness-mcp/secret-keyring.json)
SECRET_KEYRING_FILE=/run/cloud-harness-secrets/secret-keyring.json

API_PUBLIC_HOSTS=127.0.0.1,localhost,<configured-domain>
API_ALLOWED_ORIGINS=https://<configured-domain>
API_PORT=3000
RUNNER_PORT=3001
RUNNER_URL=http://runner:3001

JOBS_ROOT=/var/lib/cloud-harness/jobs
STATE_DB=/var/lib/cloud-harness/state/cloud-harness.db
ARTIFACT_ROOT=/var/lib/cloud-harness/artifacts
REPO_CACHE_ROOT=/var/lib/cloud-harness/cache/repos

EXECUTOR_IMAGE=cloud-harness-executor:local
ALLOWED_GIT_HOSTS=github.com
WORKSPACE_NETWORK_MODE=none
WORKSPACE_WALL_TTL_SECONDS=900
WORKSPACE_IDLE_TTL_SECONDS=300
```
## Related Code Files
- Create: `scripts/install.sh` (The canonical open-source installer shell script)
- Reference: `deploy/scripts/bootstrap-vps.sh` (Directory and systemd bootstrap reference)
- Reference: `deploy/scripts/deploy-release.sh` (Authoritative image build, deployment and verification runner)
- Reference: `deploy/scripts/release-runtime.sh` (Compose environment wrappers and health probes)
- Reference: `deploy/systemd/cloud-harness-mcp.service` (Production systemd unit file)
- Create: `deploy/caddy/Caddyfile.template` (Automated Let's Encrypt TLS reverse proxy to `127.0.0.1:3100`)
- Create: `deploy/cloudflare-tunnel/docker-compose.tunnel.yaml` (Optional tunnel overlay)
- Create: `bin/cloudharness` (Bash management utility symlinked to `/usr/local/bin/cloudharness`)
- Modify: `compose.production.yaml` (Expose configurable ingress bindings and Caddy/Tunnel overlays)
- Modify: `docs-site/deployment.md` (Update official community installation instructions)

## Implementation Steps
1. **Preflight & Architecture Detection (`scripts/install.sh`):**
   - Check POSIX shell, root permissions (`EUID == 0` or invoke `sudo`).
   - Validate minimum memory (2GB) and disk space (10GB under `/var/lib/cloud-harness`).
   - Detect OS family (`/etc/os-release` for Debian/Ubuntu vs RHEL/Rocky).
2. **Dependency Resolution:**
   - Detect existing `docker` and `docker compose`.
   - If missing, configure official Docker GPG keys and install `docker-ce`, `docker-ce-cli`, `containerd.io`, `docker-compose-plugin`.
3. **Directory Structure & Repository Checkout (`bootstrap-vps.sh` & `deploy-release.sh` alignment):**
   - Create directories:
     `install -d -m 0755 /opt/cloud-harness-mcp`
     `install -d -m 0700 /etc/cloud-harness-mcp /var/lib/cloud-harness/state /var/lib/cloud-harness/backups`
     `install -d -m 0750 /var/lib/cloud-harness/jobs /var/lib/cloud-harness/artifacts /var/lib/cloud-harness/cache/repos`
   - Clone repository into `/opt/cloud-harness-mcp/repo` if not present, and resolve current release SHA.
   - Install systemd unit: `install -m 0644 /opt/cloud-harness-mcp/repo/deploy/systemd/cloud-harness-mcp.service /etc/systemd/system/cloud-harness-mcp.service`.
   - Install deployment tools:
     `install -m 0755 /opt/cloud-harness-mcp/repo/deploy/scripts/deploy-release.sh /usr/local/sbin/cloud-harness-deploy`
     `install -m 0755 /opt/cloud-harness-mcp/repo/deploy/scripts/rollback-release.sh /usr/local/sbin/cloud-harness-rollback`
     `install -m 0755 /opt/cloud-harness-mcp/repo/deploy/scripts/upgrade-nginx-dashboard.sh /usr/local/sbin/cloud-harness-upgrade-nginx`
4. **Idempotent Secret Generation:**
   - Check if `/etc/cloud-harness-mcp/runtime.env` and `/etc/cloud-harness-mcp/secret-keyring.json` exist. If present, preserve them untouched.
   - If absent:
     - Generate `MCP_BEARER_TOKEN` and `RUNNER_TOKEN` via `openssl rand -base64 48 | tr -d '\n'`.
     - Generate host keyring file `/etc/cloud-harness-mcp/secret-keyring.json` (mode 0600):
       `KEY_B64=$(openssl rand -base64 32)`
       `printf '{"activeVersion":1,"keys":[{"version":1,"key":"%s"}]}\n' "$KEY_B64" > /etc/cloud-harness-mcp/secret-keyring.json`
     - Write `/etc/cloud-harness-mcp/runtime.env` (mode 0600) setting `SECRET_KEYRING_FILE=/run/cloud-harness-secrets/secret-keyring.json`.
5. **Ingress & TLS Configuration:**
   - Direct Domain: Caddy reverse proxy on host port 80/443 terminating TLS and forwarding upstream to loopback ingress `http://127.0.0.1:3100`.
   - Cloudflare Tunnel: `cloudflared` overlay container on the non-internal `ingress` network routing upstream directly to `http://ingress:3100` (or host service to `http://127.0.0.1:3100`).
6. **Execute Initial Deployment (`cloud-harness-deploy <SHA>`):**
   - Run `/usr/local/sbin/cloud-harness-deploy "$RELEASE_SHA"` to build `executor-image`, `api`, and `runner` images, enable systemd service, verify `readyz`, and run the canary verification script.
7. **Management CLI (`bin/cloudharness`):**
   - Implement CLI commands: `status`, `logs`, `start`, `stop`, `restart`, `token create`, `upgrade`.
8. **Client Configuration Output:**
   - Print copy-pasteable JSON configuration for `claude_desktop_config.json`, `.cursor/mcp.json`, and Codex.

## Success Criteria
- [ ] Running `curl -fsSL https://get.cloudharness.io | bash` on a clean Ubuntu 24.04 VPS completes in < 60s.
- [ ] `cloud-harness-deploy <RELEASE_SHA>` builds all images (`cloud-harness-executor:local`, `cloud-harness-api:local`, `cloud-harness-runner:local`).
- [ ] Systemd service `cloud-harness-mcp.service` is active and running with `WorkingDirectory=/opt/cloud-harness-mcp/repo`.
- [ ] `/etc/cloud-harness-mcp/runtime.env` contains `SECRET_KEYRING_FILE=/run/cloud-harness-secrets/secret-keyring.json`.
- [ ] Runner container loads secret keyring from `/run/cloud-harness-secrets/secret-keyring.json` without readiness errors.
- [ ] Loopback health probe `http://127.0.0.1:3100/readyz` returns HTTP 200 OK.
- [ ] Smoke test and canary verification (`deploy-canary.mjs`) pass with exit code 0.
- [ ] `cloudharness status` returns healthy status for API, Runner, and Ingress Proxy.
- [ ] `cloudharness token create --name "Laptop"` generates a functional scoped API key.
- [ ] Re-running the installer safely reconciles configuration without overwriting existing tokens or database state.

## Risk Assessment
- **Risk:** Port 80 or 443 already bound by existing web servers (nginx/apache).
  - *Observable Signal:* Installer preflight check detects port conflict.
  - *Response:* Provide choice to use alternative port with external reverse proxy, use Cloudflare Tunnel, or abort gracefully.
- **Risk:** Image build failure on memory-constrained servers (<2GB RAM).
  - *Observable Signal:* Docker build process killed with OOM error.
  - *Response:* Installer preflight enforces minimum 2GB RAM check and sets up a temporary 2GB swapfile if physical RAM is tight.

### Architectural Invariant & Scoped API-Key Auth Mode Compatibility
- **Current Implementation Boundary:** `packages/contracts/src/config.ts` enforces that managed API-key generation is restricted to `AUTH_MODE=cloudflare-access` (authenticated through the dashboard BFF with origin attestation). Under single-owner `AUTH_MODE=owner-bearer`, the system uses the single high-entropy `MCP_BEARER_TOKEN`.
- **Status & Next Step:** `bin/cloudharness` implements `token view` and `token rotate` for the active `MCP_BEARER_TOKEN`. Generating scoped, multi-client API keys under `owner-bearer` mode requires a distinct dual-auth design that does not weaken origin validation, and is documented as a follow-up feature.
