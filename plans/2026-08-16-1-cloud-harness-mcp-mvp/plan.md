---
title: "Cloud Harness MCP MVP"
description: "Deliver a private single-owner remote coding harness over authenticated Streamable HTTP MCP."
status: completed
priority: P1
effort: 12d
issue: 1
branch: feat/mvp
tags: [feature, backend, api, auth, infra, critical]
blockedBy: []
blocks: []
created: 2026-08-16
---

# Cloud Harness MCP MVP

## Outcome

A deployable TypeScript MCP service at `https://cloud-harness-mcp.46-250-239-227.sslip.io/mcp` lets one authenticated owner open persistent, TTL-bound coding workspaces and use files, grep, exec, shell, tasks, Git, worktrees, skills, hooks, and memories through structured, bounded tools.

## Constraints

- Use TypeScript SDK v2 split packages and modern stateless Streamable HTTP, with SDK-provided stateless 2025 compatibility.
- Keep the public API/control plane and Docker-socket runner as separate services; only the private runner may reach Docker.
- Require bearer authentication plus explicit Host/Origin validation before MCP dispatch.
- Use hardened per-workspace containers, isolated clones, opaque owner-bound IDs, bounded output, and configurable TTL/resource limits.
- Run clone/checkout in a fixed, resource-limited helper container; trusted runner code never evaluates executor-writable Git metadata.
- Support public Git clone and an optional trusted GitHub App broker; never pass clone or deployment credentials into executors.
- Reuse existing nginx for HTTPS and bind application ingress to host loopback.
- Document rootful Docker/socket authority as a private-MVP limitation, not hostile-tenant isolation.
- Keep executor egress disabled by default; an explicit owner-only bridge-network profile may be enabled for dependency installation and is documented as a weaker boundary.

## Non-Goals

- Hostile multi-tenancy, anonymous/public service, billing, or a web UI.
- microVM, gVisor, or other stronger kernel isolation in this release.
- A general OAuth authorization server or dynamic client registration.
- Deprecated 2024 HTTP+SSE, unrestricted clone protocols, arbitrary executor images, or unrestricted egress.

## Dependencies

- Node.js LTS, npm workspaces, Docker Engine/Compose, Git, and a digest-pinnable executor image.
- Existing VPS nginx and certificate tooling; GitHub Actions production environment and SSH deployment identity.
- Optional GitHub App ID, installation ID, and private-key file for private repository cloning.
- Research: [MCP](./reports/mcp-research.md) and [sandbox/deployment](./reports/sandbox-deployment-research.md).

## Phases

| Phase | Name | Status |
|---|---|---|
| 1 | [Foundation and Contracts](./phase-01-start.md) | Completed |
| 2 | [MCP Core and Tool Surface](./phase-02-mcp-core-and-tool-surface.md) | Completed |
| 3 | [Sandbox and Workspace Runtime](./phase-03-sandbox-and-workspace-runtime.md) | Completed |
| 4 | [Quality, CI, and Documentation](./phase-04-quality-ci-and-documentation.md) | Completed |
| 5 | [VPS Deployment and End-to-End Verification](./phase-05-vps-deployment-and-end-to-end-verification.md) | Completed |

## Acceptance Criteria

- [x] Modern `2026-07-28` calls and initialized 2025 Streamable HTTP clients invoke the same tool implementations without transport session state.
- [x] Invalid bearer, Host, or Origin is rejected; the API service has no Docker socket or host job mount.
- [x] Workspaces survive calls, recover lost create responses through idempotency/listing, expire under one cleanup authority, and execute only in CPU/memory/PID/file/output-limited non-root containers with no default egress or credentials.
- [x] Public clone works without persisted credentials. Optional GitHub App support is contract- and leak-tested, and is live-verified only when owner-supplied App credentials are available.
- [x] Every required tool has validated input/output schemas, truthful annotations, structured errors, cursor pagination, and enforced output/time caps.
- [x] Unit, real-SDK HTTP integration, Docker isolation, compatibility, cancellation, and production HTTPS end-to-end tests pass.
- [x] Docker/Compose, CI, SSH deployment, rollback, operations, security, configuration, API, and user documentation are complete.
- [x] Codex CLI bearer configuration and the official MCP SDK client are documented; the official client completes live interoperability verification.
- [x] The live endpoint passes evidence-backed verification recorded in `plans/2026-08-16-1-cloud-harness-mcp-mvp/reports/mvp-verification.md`.

## Resolved Design Decisions

- VPS preflight was completed before implementation: Docker 28.3.3 with AppArmor/seccomp/cgroup namespaces, existing nginx/certbot, 11 GiB RAM, and sufficient free disk were observed; ingress uses `127.0.0.1:3100` and the sslip.io hostname above without changing existing sites.
- Disk usage protection is explicitly best-effort on the current shared filesystem: one-workspace admission, a soft workspace ceiling, and a host reserve floor reduce risk but are not a hard quota. Hostile tenancy remains blocked until quota-backed storage and stronger execution isolation exist.
- Synchronous exec is request-owned; detached tasks and shells are workspace-owned. Close/TTL kills the whole container and all descendants. Each creation/launch accepts an idempotency key and is discoverable after a lost response.
- The first install has an uninstall/route-disable rollback; upgrades use schema-version checks, a quiesced state backup, and previous release images/config.

## Red Team Review

### Session — 2026-08-16

**Findings:** 27 raw findings consolidated into 14 decisions (11 accepted, 3 rejected as contrary to the accepted private-MVP scope or explicit requested tool surface). Full adjudication: [plan red-team report](./reports/plan-red-team.md).
