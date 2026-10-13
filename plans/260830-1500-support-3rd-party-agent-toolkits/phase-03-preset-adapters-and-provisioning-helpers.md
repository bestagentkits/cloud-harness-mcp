---
phase: 3
title: "Preset Adapters & Disposable Provisioning Helpers"
status: pending
priority: P1
effort: "3d"
dependencies: ["phase-02-runner-cas-cache-manager-and-state-schema.md"]
---

# Phase 3: Preset Adapters & Disposable Provisioning Helpers

## Overview
Implement the toolkit catalog, provider adapters (`mattpocock/skills`, `obra/superpowers`, `bestagentkits/agentkit`, declarative Git), the dual-homed `provisioning-proxy` service, and parameterize `RepositoryCacheManager` so that **all** toolkit clone and export helper containers run attached strictly to the `internal: true` provisioning network.

<!-- red-team-applied: Findings 1, 2, 4, 5, 6, 9, 12, 13, 16, 17 -->

## Requirements
- Functional:
  - Implement `provisioning-proxy` service and config in `compose.yaml` and `deploy/provisioning-proxy.mjs`:
    - Dual-homed service connected to `provisioning` (`internal: true`) and `runner-egress` (`driver: bridge`).
    - Enforces destination allowlist (`allowedGitHosts` + `agentkit.best`, `releases.agentkit.best`); strictly blocks loopback, RFC1918 subnets, and cloud metadata (`169.254.169.254`).
  - **Universal Helper Network Containment**:
    - **ALL** toolkit helper containers (Git-based and AgentKit) must launch attached strictly to the `internal: true` provisioning network (`config.provisioningNetwork`) with no default gateway.
    - Extend `RepositoryCacheManager` (`apps/runner/src/repository-cache-manager.ts`) to support `acquireToolkitCacheMirror(ownerId, url, ref, options)` passing:
      ```typescript
      '--network', this.config.provisioningNetwork,
      '--env', `HTTP_PROXY=http://provisioning-proxy:3128`,
      '--env', `HTTPS_PROXY=http://provisioning-proxy:3128`,
      '--env', 'NO_PROXY=localhost,127.0.0.1',
      ```
    - Direct internet IP/TCP sockets from any clone or export helper fail at the kernel level (`ENETUNREACH`).
  - Implement `ToolkitService` and catalog in `apps/runner/src/toolkit-service.ts`:
    - **`MattPocockAdapter`**: Clones via `RepositoryCacheManager.acquireToolkitCacheMirror()` on internal network; recursively scans categorized directories (`skills/<category>/<skill>/SKILL.md`) and normalizes into flat immediate-child skill bundles (`skills/<skill-name>/SKILL.md`).
    - **`SuperpowersAdapter`**: Clones via `acquireToolkitCacheMirror()` on internal network; extracts `skills/` children and prepares `using-superpowers` context instructions artifact.
    - **`AgentKitAdapter`** (Gated on Phase 0 Proofs): Uses `consumeProvisioningSecret()` to obtain key in memory; spawns helper on `internal: true` provisioning network with standard reaper labels; pipes key via stdin into isolated wrapper; routes egress traffic through `provisioning-proxy`; executes `ak kit init <kit> --target portable --out /staging`; applies strict allowlist filtering; computes full-tree SHA-256 digest.
    - **`DeclarativeGitAdapter`**: Calls `validateRepositoryUrl(url, allowedGitHosts)` immediately before clone; clones via `acquireToolkitCacheMirror()` on internal network; validates declared `skillRoots` (supporting 40-char SHA-1 and 64-char SHA-256 object IDs); rejects symlink escapes.
  - Resource bounds: Enforce streaming byte limits (64MB tmpfs ceiling, memory limit 512MB, PID limit 64, 120s timeout) on all helpers.
  - Enforce operator policy: fail with `TOOLKIT_NOT_CACHED` when `toolkitNetworkPolicy: "cache-only"` on cache miss.
- Non-functional:
  - Zero execution of arbitrary `install.sh`, npm lifecycle hooks, or package scripts during provisioning.
  - Helper containers carry standard lifecycle labels so the unified reaper recovers orphaned containers on restart.

## Architecture
```text
Universal Helper Network Firewall Topology (All Toolkits):
  ┌────────────────────────────────────────────────────────┐
  │  cloud-harness-provisioning (internal: true)           │
  │                                                        │
  │  ┌─────────────────────────┐                           │
  │  │ Git Clone Helper        │ ──┐                       │
  │  │ (Matt, Superpowers, Git)│   │  HTTP_PROXY           │
  │  ├─────────────────────────┤   ├──────────────┐        │
  │  │ AgentKit Export Helper  │   │              │        │
  │  │ (ak kit init)           │ ──┘              ▼        │
  │  │ Raw sockets: ENETUNREACH        ┌─────────────────┐ │
  │  └─────────────────────────┘       │provisioning-proxy─┘
  └────────────────────────────────────┤(Dual-Homed)     │
                                       └────────┬────────┘
                                                │
                                       ┌────────┴────────┐
                                       │ runner-egress   │
                                       │ (driver: bridge)│
                                       └────────┬────────┘
                                                ▼
                                    Allowlisted Repos & Endpoints
```

## Related Code Files
- Create: `deploy/provisioning-proxy.mjs`
- Modify: `compose.yaml` and `compose.production.yaml` (add `provisioning` network & `provisioning-proxy`)
- Modify: `scripts/verify-compose-boundaries.mjs` (assert `provisioning` network is `internal: true`)
- Modify: `packages/contracts/src/config.ts` (add `toolkitEgressProxy`, `provisioningNetwork`)
- Modify: `apps/runner/src/config.ts` (add `toolkitEgressProxy`, `provisioningNetwork`)
- Modify: `apps/runner/src/repository-cache-manager.ts` (add `acquireToolkitCacheMirror` with internal network + proxy)
- Create: `apps/runner/src/toolkit-service.ts`
- Create: `apps/runner/src/adapters/mattpocock-adapter.ts`
- Create: `apps/runner/src/adapters/superpowers-adapter.ts`
- Create: `apps/runner/src/adapters/agentkit-adapter.ts`
- Create: `apps/runner/src/adapters/git-adapter.ts`
- Create: `apps/runner/test/toolkit-adapters.test.ts`
- Create: `apps/runner/test/agentkit-provisioner.test.ts`
- Create: `apps/runner/test/egress-proxy.test.ts`

## Implementation Steps
1. Create `deploy/provisioning-proxy.mjs`:
   - Forward HTTP/HTTPS CONNECT proxy on port 3128.
   - Intercept target hostname; check against allowlist regex (`allowedGitHosts` + `agentkit.best`, `releases.agentkit.best`).
   - Resolve DNS; drop connections resolving to 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, or 169.254.169.254.
2. In `compose.yaml` and `compose.production.yaml`:
   - Add `provisioning` network with `internal: true`.
   - Add `provisioning-proxy` service connected to `[provisioning, runner-egress]`.
3. In `apps/runner/src/repository-cache-manager.ts`:
   - Implement `acquireToolkitCacheMirror(ownerId, repositoryUrl, ref, options)`:
     - Launches clone helper container with `--network ${this.config.provisioningNetwork}` and proxy env (`HTTP_PROXY`, `HTTPS_PROXY`).
4. Implement `ToolkitService` in `apps/runner/src/toolkit-service.ts` coordinating catalog resolution, cache lookups, and adapter execution.
5. Implement `MattPocockAdapter` and `SuperpowersAdapter` using `acquireToolkitCacheMirror()`.
6. Implement `AgentKitAdapter`:
   - Launch helper attached to the internal network with proxy env.
   - Stream key via stdin to entrypoint wrapper; run `ak kit init <kit> --target portable --out /tmp/staging`.
   - Parse with strict allowlist; scan bytes for canary key; compute full-tree SHA-256.
7. Implement `DeclarativeGitAdapter` using `acquireToolkitCacheMirror()`.
8. Write test suite in `apps/runner/test/toolkit-adapters.test.ts`, `apps/runner/test/agentkit-provisioner.test.ts`, and `apps/runner/test/egress-proxy.test.ts`:
   - Test that direct raw TCP socket from Git clone helper fails with `ENETUNREACH`.
   - Test that direct raw TCP socket from AgentKit helper fails with `ENETUNREACH`.
   - Test that proxy allowlists approved hosts and blocks private/metadata IPs across both Git and AgentKit paths.
   - Test recursive flattening on Matt Pocock fixtures.
   - Test Superpowers bootstrap context generation.

## Success Criteria
- [ ] Direct raw socket connections from Git clone helpers and AgentKit helpers fail at the Docker network layer (`ENETUNREACH`).
- [ ] `provisioning-proxy` enforces destination allowlist across all toolkit acquisition paths and passes `apps/runner/test/egress-proxy.test.ts`.
- [ ] Compose boundary checks pass (`npm run verify:compose`).
- [ ] All 4 adapters pass unit and fixture tests.

## Risk Assessment
- *Risk:* Provisioning proxy container fails to start.
  - *Mitigation:* Include healthcheck on `provisioning-proxy` in `compose.yaml`; runner checks proxy readiness before launching helper containers.
