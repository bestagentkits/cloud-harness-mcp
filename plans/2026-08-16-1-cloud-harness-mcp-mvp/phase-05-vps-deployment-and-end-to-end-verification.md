---
phase: 5
title: "VPS Deployment and End-to-End Verification"
status: pending
priority: P1
effort: 2d
dependencies: [4]
---

# Phase 5: VPS Deployment and End-to-End Verification

## Context Links

- [Plan](./plan.md)
- [Quality and documentation phase](./phase-04-quality-ci-and-documentation.md)
- [Sandbox and deployment research](./reports/sandbox-deployment-research.md)
- Target evidence: `plans/2026-08-16-1-cloud-harness-mcp-mvp/reports/mvp-verification.md` (created by this phase)

## Overview

Deploy the verified images to the VPS through a gated SSH workflow, reuse existing nginx for HTTPS at `cloud-harness-mcp.46-250-239-227.sslip.io`, exercise the complete remote coding loop, prove rollback, and capture sanitized evidence.

## Requirements

- Functional: production Compose keeps a credential-free ingress proxy on host loopback, API and runner on private networks, and Docker socket/job root on runner only.
- Functional: existing nginx terminates TLS and proxies `/mcp` plus health endpoints with streaming/cancellation semantics preserved.
- Functional: GitHub Actions deploys an immutable tested image digest over SSH, health-checks it, and automatically restores the prior digest on failure.
- Operational: host preflight verifies Ubuntu/Docker/cgroup/storage capacity, AppArmor/seccomp, firewall/listeners, nginx/certificate state, jobs root, service accounts, and reaper behavior.
- Evidence: sanitized report records commands, timestamps, commit/image digests, response outcomes, isolation checks, rollback drill, and remaining limitations.

## Architecture

Public traffic reaches existing nginx on `80/443`; nginx proxies only to a credential-free TCP ingress at `127.0.0.1:3100`. The proxy reaches API on an internal frontend network but cannot join the API/runner control network. Compose exposes no API or runner port and gives the runner the Docker socket and configured jobs root. A dedicated deploy identity may invoke only a fixed root-owned deployment script whose repository/origin are hardcoded and whose only release input is an exact approved commit SHA; runtime bearer and GitHub App material come from root-owned files/Compose secrets.

## Related Code Files

- Create: `compose.production.yaml`, `deploy/nginx/cloud-harness-mcp.conf`, `deploy/systemd/cloud-harness-mcp.service`
- Create: `deploy/scripts/bootstrap-vps.sh`, `deploy/scripts/deploy-release.sh`, `deploy/scripts/rollback-release.sh`
- Create: `.github/workflows/deploy.yml`, `scripts/verify-production.mjs`
- Create: `plans/2026-08-16-1-cloud-harness-mcp-mvp/reports/mvp-verification.md`
- Modify: `docs/deployment.md`, `docs/operations.md`, `docs/security-model.md`, `README.md`
- Delete: none

## Implementation Steps

1. Run read-only preflight and record OS, Docker 28.x/security options, cgroup mode, filesystem/free space, active listeners/firewall, nginx/certificate status, and existing service ownership. Choose safe configurable limits from measured capacity.
2. Bootstrap dedicated runtime/deploy identities, root-owned secret files, jobs/state directories, Compose/systemd unit, narrow sudoers command, and cleanup timer. Keep runtime identities non-login and deployment identity outside the public service.
3. Install an nginx server block for `cloud-harness-mcp.46-250-239-227.sslip.io`, provision/verify its certificate using existing nginx tooling, preserve Host and streaming headers, disable proxy buffering for SSE, and proxy only to loopback API.
4. Build the exact CI-tested commit with fixed Dockerfiles, record immutable image IDs/digests, and reject unapproved origins/repositories or dirty source. Production Compose maps `127.0.0.1:3100`, exposes no runner/executor port, and mounts Docker socket/jobs root only into runner.
5. Create CI-gated deploy workflow: protected `main`, `production` environment, minimal permissions, pinned actions, concurrency lock, ephemeral SSH key/known-host files, pinned host key, and invocation of the fixed root-owned deploy script with only the exact 40-hex commit SHA.
6. Make deployment atomic: turn off admissions, drain/fence operations, checkpoint and back up compatible state, build/stage, validate config, controlled restart, then keep the release unpromoted until a disposable authenticated coding workflow and cleanup pass. Promote the release pointer and admissions only after the full canary; any failure restores compatible previous images/config/state and confirms health.
7. Verify HTTPS negative cases without exposing secrets: HTTP redirect, certificate/hostname, unauthenticated 401 challenge, foreign Host/Origin 403, body/rate bounds, and no public API backend/runner/Docker port.
8. Run an authenticated MCP client through nginx for modern and 2025 flows: open public repository, inspect/read/search/edit, exec/shell/task, Git/worktree, skill/hook/memory operations, reconnect to the persistent workspace, then close it.
9. If GitHub App settings are available, repeat clone against one approved private repository and prove the token is absent from remote/config/log/result/executor; otherwise record the optional path as configuration-tested but not live-verified.
10. Test disconnect cancellation, TTL/reaper across restart, resource pressure controls/non-guarantees, secret redaction, and a forced failed deployment rollback. Separately test first-install failure: disable/remove the new nginx route, stop the unit, and restore every changed host file without requiring a prior image. Stop and investigate any boundary failure before exposure.
11. Write `mvp-verification.md` with sanitized evidence, exact commit/image digests, CI/deploy run links, test matrix, observed limits, rollback outcome, known rootful-Docker limitation, and explicit go/no-go conclusion.

## Tests and Validation

- `nginx -t`, certificate validation, loopback health, and production Compose config/image digest checks pass before reload/restart.
- External checks confirm only nginx is public; `/mcp` auth/Host/Origin/protocol behavior matches local suites over HTTPS and SSE is not buffered.
- Sanitized `docker inspect` proves executor non-root/read-only/no-network/no-socket/cap-drop/resource constraints and API has no Docker/job mounts.
- Full remote tool workflow, persistence/reconnect, 2025 compatibility, cancellation, TTL cleanup, restart reconciliation, and rollback drill pass.
- Review Actions/nginx/application logs for tokens, environment dumps, command tracing, private repository URLs, or SSH material; any occurrence blocks release and triggers rotation.

## Success Criteria

- [ ] The named HTTPS endpoint is healthy and usable by the owner with modern and 2025 Streamable HTTP clients.
- [ ] Existing nginx is the only public ingress; the application ingress is loopback-only and API/runner/executors are not publicly reachable.
- [ ] SSH deployment is gated, digest-pinned, least-privilege, repeatable, health-checked, and rollback-proven.
- [ ] Every required tool completes a live remote workflow in a persistent sandbox and cleanup leaves no orphan.
- [ ] The evidence report supports each MVP acceptance criterion without credentials or private data.

## Risk Assessment and Rollback

- Risk: VPS facts invalidate planned quotas/security flags. Mitigation: preflight gates deployment; lower concurrency/limits or stop rather than silently weaken isolation.
- Risk: nginx reload or release restart causes outage. Mitigation: validate config, stage atomic files/digests, retain prior release, and reload only after loopback health.
- Risk: SSH/deploy compromise grants excess authority. Mitigation: protected environment, pinned host key/actions, dedicated key, fixed sudo command, no arbitrary remote shell, immediate rotation procedure.
- Rollback: run the fixed rollback script to restore prior digests/config, verify loopback and HTTPS health, then disable new workspace admission while preserving evidence.

## Security Considerations

- Never put a real token/key in commands, shell history, workflow arguments, reports, or screenshots; consume protected files/stdin with tracing off.
- Rootful runner plus Docker socket remains host-root-equivalent trusted control-plane authority. Keep endpoint private to one owner and document the limit visibly.
- Do not claim hostile multi-tenant readiness until execution hosts and stronger VM/microVM/gVisor-class isolation are separately designed and reviewed.

## Next Steps

After evidence review, either approve private-owner MVP operation or block release with named remediation. Multi-tenant, billing, UI, general OAuth AS, and stronger isolation require separate plans.
