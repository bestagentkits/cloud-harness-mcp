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
- **Default Network `network-none`:** Outbound network is disabled unless explicitly requested as `dependency-access`, which permits only public DNS and TCP 80/443 while an attested Linux host firewall blocks loopback-to-host, Docker/control-plane, RFC 1918, link-local, and cloud-metadata ranges. It fails closed if attestation is unavailable and still permits public exfiltration.

### 3. Privileged Execution & Operator Grants
- Privileged (`sudo`/root) commands are treated as an explicit threat model weakening and are supported in **Cloudflare Access** mode only.
- Running with `privileged: true` requires an operator approval grant (`PRIVILEGE_APPROVAL_REQUIRED`), single-use, 60s TTL, bound to command and working directory hash.
- Approval is performed by authenticated operators via the Dashboard control plane (`/api/v1/privilege-grants`). MCP clients cannot self-approve.
- Approved privileged commands run in isolated ephemeral containers with root cleanup normalizers.

### 4. Credential Safety
- Private clone, push, and GitHub CLI operations use short-lived GitHub App tokens passed exclusively over `stdin` into ephemeral helpers.
- Tokens are never stored in environment variables, configuration files, or repository commit history.

### 5. Toolkit Provisioning Firewall & Content-Addressed Storage
- **Internal Network Containment:** All toolkit clone helpers run attached strictly to an `internal: true` network with no default gateway. Raw TCP sockets fail at the kernel level (`ENETUNREACH`).
- **Dual-Homed Provisioning Proxy:** All helper outbound traffic traverses `provisioning-proxy:3128`, enforcing DNS allowlists for approved Git hosts and blocking private subnets, loopback, and cloud metadata (`169.254.169.254`).
- **Content-Addressed Storage (CAS):** Pinned bundles are verified with full-tree SHA-256 digests and published atomically with `fsync` ordering to `TOOLKIT_CACHE_ROOT`.

### 6. Skill Tiers & Execution Isolation
- **Built-in & Owner Tiers (`/opt/cloud-harness/skills:ro`, `/opt/cloud-harness/owner-skills:ro`):** Mounted read-only (`:ro`) at the container engine boundary, preventing in-container modification.
- **Workspace & Repository Tiers (`/workspace/.cloud-harness/skills`, `/workspace/.agents/skills`):** Reside within the mutable repository checkout. Execution creates a snapshot under `/tmp/cloud-harness-exec/<runId>` and validates the full-tree bundle digest before execution to detect unintentional filesystem race conditions.

