---
phase: 4
title: "Quality, CI, and Documentation"
status: in-progress
priority: P1
effort: 2d
dependencies: [2, 3]
---

# Phase 4: Quality, CI, and Documentation

## Context Links

- [Plan](./plan.md)
- [MCP implementation phase](./phase-02-mcp-core-and-tool-surface.md)
- [Sandbox implementation phase](./phase-03-sandbox-and-workspace-runtime.md)
- [MCP research](./reports/mcp-research.md)
- [Sandbox research](./reports/sandbox-deployment-research.md)

## Overview

Make the MVP reproducible and reviewable: comprehensive unit/integration/e2e coverage, least-privilege CI, image/build verification, and user/maintainer documentation that states behavior and limitations precisely.

## Requirements

- Functional: one-command local quality gate and local Compose end-to-end suite covering all public tools and advertised protocol versions.
- Functional: GitHub Actions CI for install, lint, typecheck, unit tests, real HTTP integration tests, Docker isolation tests, build, and image smoke checks.
- Documentation: setup, configuration, MCP connection/tool reference, architecture, security/threat model, development, operations, deployment, troubleshooting, and rootful Docker limitation.
- Non-functional: pinned action SHAs, minimal `GITHUB_TOKEN` permissions, no production secrets in pull-request jobs, bounded test artifacts, and deterministic lockfile/image builds.

## Architecture

Tests form four layers: pure contract/policy unit tests; API tests with the real SDK client; API-runner-Docker integration tests; and Compose end-to-end scenarios. CI runs unprivileged checks first, then Docker-backed checks on trusted repository events. Documentation links to schemas/config source instead of copying unstable values.

## Related Code Files

- Create: `test/integration/mcp-http.test.ts`, `test/integration/runner-boundary.test.ts`, `test/integration/docker-sandbox.test.ts`
- Create: `test/e2e/coding-workflow.test.ts`, `test/e2e/protocol-compatibility.test.ts`, `test/e2e/security-boundaries.test.ts`
- Create: `test/fixtures/public-repository/README.md`, `test/helpers/test-server.ts`, `test/helpers/test-workspace.ts`
- Create: `.github/workflows/ci.yml`
- Create: `docs/system-architecture.md`, `docs/mcp-api.md`, `docs/configuration.md`, `docs/security-model.md`
- Create: `docs/development.md`, `docs/operations.md`, `docs/deployment.md`, `docs/troubleshooting.md`
- Modify: `README.md`, `package.json`, `compose.yaml`
- Delete: none

## Implementation Steps

1. Establish `test:unit`, `test:integration`, `test:e2e`, `test:security`, and aggregate `verify` scripts; ensure processes, containers, ports, and temporary workspaces are cleaned after each run.
2. Cover every schema, stable error, idempotency replay/recovery, output cursor/truncation case, authorization decision, path policy, URL/ref validation, TTL/lease/fencing state transition, schema compatibility, and secret redaction rule with focused tests.
3. Use the real v2 SDK client and raw HTTP assertions for modern/2025 compatibility, headers, JSON/SSE, cancellation, parallel isolation, graceful shutdown, and negative protocol cases.
4. Run local Compose workflows that clone a real controlled public fixture, edit/search/test/Git/worktree, read skill/memory metadata, execute a hook in-container, and close/reap the workspace.
5. Add Docker abuse tests for traversal, symlinks, malicious Git config/hooks/filters, clone limits, output/fork/memory/PID pressure, soft-disk reserve behavior, no-network, credential absence, process-tree cancellation, restart reconciliation, and job isolation; skip only with an explicit local prerequisite message, never silently in CI.
6. Create least-privilege CI with dependency caching, lockfile install, compile/static gates, test separation, Docker image build/smoke, timeouts, concurrency, and sanitized failure artifacts. Pin external actions to reviewed full SHAs.
7. Expand README quick start and write linked docs for client setup, bearer handling, exact tool contracts, configuration, architecture/data flow, operator runbooks, backup/cleanup, upgrades/rollback, and troubleshooting.
8. State the threat model prominently: private single owner, replayable bearer rotation requirements, trusted rootful runner/Docker socket, shared kernel, non-enforcing soft disk ceiling, default no egress/optional weaker bridge profile, and required quota-backed storage plus microVM/VM delta before hostile multi-tenancy.

## Tests and Validation

- `npm ci && npm run verify` passes on a clean checkout and in CI.
- `docker compose build --pull=false` and the full local end-to-end suite pass without using host credentials or writing outside test roots.
- CI permissions and event filters are reviewed: untrusted PR code cannot access deployment environments, repository write tokens, SSH keys, or runtime bearer/GitHub App secrets.
- Markdown links, command examples, config names, ports, protocol versions, tool names, and stated defaults are checked against source and Compose files.

## Success Criteria

- [x] Required unit, integration, Docker, compatibility, security, and local e2e suites pass reliably.
- [ ] CI blocks merge on lint, type, test, build, image, or isolation regression and exposes no sensitive material.
- [x] A new owner can configure, run, connect, operate, and troubleshoot the service from docs alone.
- [x] Documentation distinguishes verified guarantees, configurable defaults, MVP limitations, and deferred production controls.

## Risk Assessment and Rollback

- Risk: privileged Docker tests are flaky or unsafe. Mitigation: fixed test image/roots, one concurrency group, hard timeouts, labels, and cleanup reconciliation.
- Risk: documentation drifts. Mitigation: generate/reference schemas where practical and validate commands/links in CI.
- Rollback: revert CI/docs independently; do not weaken runtime checks or mark failing security tests optional to restore green status.

## Security Considerations

- Never place real bearer, GitHub App, VPS, SSH, or registry credentials in fixtures, snapshots, logs, caches, artifacts, or docs.
- Do not use `pull_request_target` for code execution. Give CI `contents: read` unless a job has a reviewed narrower need.
- Treat test repositories and lifecycle scripts as malicious inputs; confine them to the same runner policy as production.

## Next Steps

Phase 5 deploys only an artifact/digest that passed these gates and records sanitized live evidence.
