# Phase 3: Runner NetworkProfileManager, WorkspaceService & State Migration

## Context Links
- `apps/runner/src/workspace-service.ts`
- `apps/runner/src/state-store.ts`
- `apps/runner/src/config.ts`
- `apps/runner/src/network-profile-manager.ts` (new)

## Requirements
1. **NetworkProfileManager in Runner:**
   - Implements `ensureProfileReady(profile: ExecutorNetworkProfile): Promise<void>`.
   - For `network-none`: returns immediately.
   - For `dependency-access`: checks Docker network inspect + runs `HostFirewallAttestor.verify()`. If failed, throws non-retryable `DEPENDENCY_EGRESS_UNAVAILABLE` (503).
   - Maps profile to Docker container launch flags:
     - `network-none` -> `['--network', 'none']`
     - `dependency-access` -> `['--network', 'cloud-harness-dependency-access', '--label', 'cloud-harness.network-profile=dependency-access']`
2. **Apply to All Launch Paths in WorkspaceService:**
   - Standard executor container creation (`createExecutor`).
   - Approved root ephemeral execution (`runPrivilegedEphemeralExec`).
   - Container recovery on startup (`reconcileRunningExecutors`).
   - Keep clone and git transfer helpers on runner-controlled network boundaries.
3. **State Schema Migration (v4 -> v5):**
   - In `StateStore.migrateSchema()`:
     - Migrate column `network_mode` to `network_profile`.
     - Value mapping: `'none'` -> `'network-none'`, `'bridge'` -> `'dependency-access'`.
     - Update SQLite table schema to add `CHECK(network_profile IN ('network-none', 'dependency-access'))`.
4. **Drift Detection & Quarantine Loop:**
   - In periodic reaper loop: if `dependency-access` workspaces exist, run attestation. If rules are missing, quarantine running containers and record audit event.

## Tests
- `npm test apps/runner/test/state-store.test.ts`
- `npm test apps/runner/test/workspace-capabilities.test.ts`
