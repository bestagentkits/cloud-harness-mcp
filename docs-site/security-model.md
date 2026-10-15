---
title: Security & Threat Model
description: Security boundaries, trust domains, and isolation mechanisms in Cloud Harness MCP.
---

# Security & Threat Model

## Intended Trust Model

Cloud Harness MCP is intentionally a **private, single-owner remote coding harness**. It allows arbitrary repository-controlled execution inside a constrained executor, but it is **not a hostile multi-tenant sandbox**.

## Defensive Layers

### 1. Ingress & Control Plane Isolation

- The Ingress Proxy is the only service bound to external loopback.
- The API and Runner never publish host ports directly.
- The API has no access to the Docker socket or host filesystem mounts.

### 2. Executor Confinement & Hardening

- **Non-Root User:** Containers execute as UID 10001 (`harness`).
- **Hardened Standard Mode:** Standard executors strictly maintain `--read-only`, `--cap-drop ALL`, and `--security-opt no-new-privileges`.
- **3-Zone Storage Partitioning:** Ephemeral secrets/config in RAM tmpfs (`/tmp/cloud-harness-home`), persistent user-space toolchains in `/opt/user-tools` & `/var/cache/harness`, and clean Git checkout in `/workspace`.
- **No Docker Authority:** No socket mount or host filesystem access.
- **Dashboard Terminal:** The [Terminal](/dashboard/terminal) opens a shell inside this same executor, as the same user and under the same limits; it never runs on the host or in the harness services. It is reachable only through the authenticated dashboard, is not an MCP tool, and its audit records only open and close, never keystrokes or output.
- **Network Egress On by Default (`dependency-access`):** Workspace executors have outbound network access by default, so a workspace can reach the GitHub API and the bundled `gh` CLI. `dependency-access` permits only public DNS and TCP 80/443 while an attested Linux host firewall blocks loopback-to-host, Docker/control-plane, RFC 1918, link-local, and cloud-metadata ranges. It fails closed if attestation is unavailable and still permits public exfiltration. `network-none` blocks all egress and is the per-workspace or instance-wide opt-out.

### 3. Privileged Execution & Operator Grants

- Privileged (`sudo`/root) commands are treated as an explicit threat model weakening and are supported in **Cloudflare Access** mode only.
- Running with `privileged: true` requires an operator approval grant (`PRIVILEGE_APPROVAL_REQUIRED`), single-use, 60s TTL, bound to command and working directory hash.
- Approval is performed by authenticated operators via the Dashboard control plane (`/api/v1/privilege-grants`). MCP clients cannot self-approve. The [Approvals](/dashboard/approvals) page shows each grant's real status and offers a decision only for an unexpired pending grant.
- Approved privileged commands run in isolated ephemeral containers with root cleanup normalizers.
- The `bash` tool has no privileged mode; privileged commands stay on `exec_run`. Its `toolbox` target (off unless the operator sets `PACKAGES_ENABLED=true`) runs each command in a fresh, hardened, no-network container with no checkout, mounts, or secrets. The runner removes it by exact name and verifies the removal; an in-container deadline and a periodic sweep cover a runner that dies mid-command, and `TOOLBOX_MAX_CONCURRENT` caps how many run at once.
- Managed packages (`packages_*`, off unless `PACKAGES_ENABLED=true`) are built in a short-lived hardened container whose only network is the provisioning proxy. That proxy is shared with toolkit acquisition, so a builder reaches the registry hosts the operator lists in `PACKAGES_PROXY_HOSTS` plus the proxy's built-in Git and toolkit hosts. The builder gets no secrets or tokens. Planning runs no package code: uv installs pre-built wheels only and npm lifecycle scripts are off by default. Each release is tree-verified and launch-checked with no network before it is published. Releases are mounted read-only at `/opt/chm-packages/<releaseId>`. With `PACKAGES_APPROVAL_MODE=required`, every apply needs a Dashboard approval bound to the exact plan digest. A package still runs with full workspace authority, so approve only packages you would run in a workspace yourself.

- The optional Decision Plane (off unless the operator sets `DECISION_PLANE_PURPOSES` and the owner stored a TypeSafe key) is advisory only. It can reorder MCP gateway search results that permission filtering already allowed, and add a `data.diagnosis` hint to a generic GitHub failure. It never changes an error code, retries, or grants access. Before anything is sent, secrets are redacted fail-closed: if redaction cannot complete, nothing leaves. Each decision leaves one audit row without prompt text. `TYPESAFE_EGRESS=off` stops it instance-wide.

### 4. Credential Safety

- Private clone, push, and GitHub CLI operations use short-lived GitHub App tokens passed exclusively over `stdin` into ephemeral helpers.
- When no GitHub App token is available, an operator-supplied `GH_TOKEN`/`GITHUB_TOKEN` fallback is used instead: the runner environment credential (owner-bearer mode only), then the requesting principal's global runtime secret. The fallback is also passed only over `stdin`.
- The optional Cloudflare API token that lets Dashboard Settings manage MCP OAuth session lifetimes is runner-only: the API, ingress, browser, and workspace executors never receive it. Scope it to one account with **Access: Apps and Policies Write** (or **Read**).
- Tokens are never stored in configuration files, MCP results, audit payloads, or repository commit history. The one documented exception is an operator-created GitHub runtime secret, which is deliberately injected into executor environments to authenticate the workspace `gh` CLI. Because egress is the default posture, repository-controlled code can exfiltrate such a credential; prefer a fine-grained token scoped to the repositories the workspace needs, or keep the instance or workspace on `network-none`.

### 5. Secrets Management & Ingest-Time Redaction

- **Write-Only At Rest:** Global and project environment secrets are encrypted at rest with AES-256-GCM via the runner-held keyring (`SECRET_KEYRING_FILE`). Secret values and ciphertext are never returned over MCP or dashboard APIs.
- **Scope Precedence:** Active global `runtime` secrets are automatically inherited by remote Docker workspaces; `runtime` environment secrets override colliding global keys when explicitly injected with `confirmEnvironmentInjection: true`.
- **Stream & Output Redactor:** Streaming task, shell, session, and Dashboard Terminal output chunks are sanitized across stream boundaries to `[REDACTED_SECRET: <NAME>]` before retained buffering, while synchronous `exec_run` command outputs and error messages are sanitized after capture before return.

### 6. Toolkit Provisioning Firewall & Content-Addressed Storage

- **Internal Network Containment:** All toolkit clone helpers run attached strictly to an `internal: true` network with no default gateway. Raw TCP sockets fail at the kernel level (`ENETUNREACH`).
- **Dual-Homed Provisioning Proxy:** All helper outbound traffic traverses `provisioning-proxy:3128`, enforcing DNS allowlists for approved Git hosts and blocking private subnets, loopback, and cloud metadata (`169.254.169.254`).
- **Content-Addressed Storage (CAS):** Pinned bundles are verified with full-tree SHA-256 digests and published atomically with `fsync` ordering to `TOOLKIT_CACHE_ROOT`.

### 7. Skill Tiers & Execution Isolation

- **Built-in & Owner Tiers (`/opt/cloud-harness/skills:ro`, `/opt/cloud-harness/owner-skills:ro`):** Mounted read-only (`:ro`) at the container engine boundary, preventing in-container modification.
- **Workspace & Repository Tiers (`/workspace/.cloud-harness/skills`, `/workspace/.agents/skills`):** Reside within the mutable repository checkout. Execution creates a snapshot under `/tmp/cloud-harness-exec/<runId>` and validates the full-tree bundle digest before execution to detect unintentional filesystem race conditions.
- **Skills over MCP:** The native `skills/*` extension serves only `built-in` skills and the authenticated user's own library skills. Every file is hashed from the bytes on disk, symlinked or special files make a skill unservable, and a read whose bytes no longer match the manifest fails. Served content is untrusted input; reading it never activates a skill or runs a script.
