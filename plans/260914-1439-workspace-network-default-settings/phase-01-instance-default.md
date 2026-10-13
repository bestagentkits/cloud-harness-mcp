---
phase: 1
title: "Instance default network profile"
status: pending
priority: P1
effort: "4h"
dependencies: []
---

# Phase 1: Instance default network profile

## Goal

Opening a workspace without an explicit `networkProfile` starts an executor with
GitHub-capable egress, and the operator can change or reset that instance default
without editing `.env`.

## Tasks & Steps

### Task 1.1 — Persist one instance-wide default network profile

- **Goal:** the runner's state database stores exactly one row holding the
  operator-chosen default network profile, or no row when the operator has never
  set one.
- **Target files and symbols:** `apps/runner/src/state-store.ts` — class
  `StateStore`, inside the constructor's `this.database.exec(...)` schema block
  (next to `CREATE TABLE IF NOT EXISTS preferred_workspaces` at the line that
  also declares `git_identities`), and two new public methods beside
  `setPreferredWorkspace`/`getPreferredWorkspace` (lines 734, 739).
- **Steps:**
  1. Add to the schema block:
     `CREATE TABLE IF NOT EXISTS instance_settings (id INTEGER PRIMARY KEY CHECK(id = 1), default_network_profile TEXT CHECK(default_network_profile IN ('network-none','dependency-access')), updated_at INTEGER NOT NULL);`
  2. Add `getWorkspaceDefaultNetworkProfile(): ExecutorNetworkProfile | undefined`
     reading `SELECT default_network_profile FROM instance_settings WHERE id = 1`
     and returning `undefined` for a missing row or a NULL column.
  3. Add `setWorkspaceDefaultNetworkProfile(value: ExecutorNetworkProfile | null, now: number): void`
     using `INSERT INTO instance_settings(id, default_network_profile, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET default_network_profile = excluded.default_network_profile, updated_at = excluded.updated_at`.
     Passing `null` stores SQL NULL, which means "use the runner default".
  4. Import the `ExecutorNetworkProfile` type from `@cloud-harness/contracts`.
- **Success criteria:** the table exists after a fresh `StateStore` construction
  on an existing database file, a set value survives closing and reopening the
  database, and `null` reads back as `undefined`.
- **Verify:** `npx vitest run apps/runner/test/state-store.test.ts` exits 0 after
  adding to that file a test that opens a `StateStore` on a temp path, asserts
  `getWorkspaceDefaultNetworkProfile()` is `undefined`, sets
  `'dependency-access'`, reopens a new `StateStore` on the same path, and asserts
  the value is still `'dependency-access'`.

### Task 1.2 — Resolve the effective profile: request > instance setting > runner default

- **Goal:** `workspace_open` honours a caller's explicit `networkProfile`, then
  the persisted instance setting, then the runner configuration.
- **Target files and symbols:** `apps/runner/src/workspace-service.ts` — the
  `open(...)` method, the expression `networkProfile: parsed.networkProfile ?? this.config.networkProfile`
  (currently around line 764).
- **Steps:**
  1. Replace the expression with
     `networkProfile: parsed.networkProfile ?? this.store.getWorkspaceDefaultNetworkProfile() ?? this.config.networkProfile`.
  2. Change nothing else in `open()`: `ensureProfileReady` at the existing
     `dependency-access` call site and the executor launch args must stay exactly
     as they are, so attestation still gates every egress start.
- **Success criteria:** the three precedence tiers are observable, and an
  existing workspace's stored `networkProfile` is never rewritten by a settings
  change.
- **Verify:** `npx vitest run apps/runner/test/workspace-capabilities.test.ts apps/runner/test/brokered-github-operations.test.ts` exits 0 with the new tests
  added in Task 1.4 passing.

### Task 1.3 — Ship an egress default and expose the settings operations

- **Goal:** a fresh instance defaults to `dependency-access`, and the dashboard
  can read/update/reset the instance default and probe egress readiness through
  dashboard-only internal operations.
- **Target files and symbols:**
  - `packages/contracts/src/config.ts` — `RunnerConfigSchema.networkProfile` default (line ~195).
  - `packages/contracts/src/internal-runner-api.ts` — `InternalRunnerOperationSchema`
    (line ~35) and `InternalRunnerRequestSchema` (line ~60).
  - `apps/runner/src/workspace-service.ts` — `executeInternal` (line ~3631).
  - `.env.example` — `WORKSPACE_NETWORK_PROFILE` (line ~56).
- **Steps:**
  1. In `packages/contracts/src/config.ts` change
     `networkProfile: ExecutorNetworkProfileSchema.default('network-none')` to
     `.default('dependency-access')`.
  2. In `.env.example` set `WORKSPACE_NETWORK_PROFILE=dependency-access`, keep the
     existing `dependency-access requires a Linux host firewall ...` comment, and
     add a one-line comment: the dashboard Settings page overrides this value for
     future workspaces.
  3. In `packages/contracts/src/internal-runner-api.ts` add to
     `InternalRunnerOperationSchema`: `'settings_get'`, `'settings_update'`,
     `'settings_network_check'`. Add request variants mirroring the existing
     `toolkitsListRequest` shape (`version: z.literal(2)`, `principal`,
     `operation`, `input`):
     `settings_get` → `input: z.object({}).strict()`;
     `settings_update` → `input: z.object({ defaultNetworkProfile: z.union([ExecutorNetworkProfileSchema, z.null()]) }).strict()`;
     `settings_network_check` → `input: z.object({}).strict()`.
     Add all three to the `InternalRunnerRequestSchema` discriminated union and
     import `ExecutorNetworkProfileSchema` from `./identifiers.js`.
  4. In `executeInternal`, handle the three operations before the
     `workspaceInput` type assertion (which assumes a `workspaceId`):
     `settings_get` returns `{ ok: true, message: 'Instance workspace settings', truncated: false, data: { defaultNetworkProfile: { value: <resolved default>, source: stored === undefined ? 'environment' : 'setting' } } }`
     where `<resolved default>` is `stored ?? this.config.networkProfile`;
     `settings_update` calls `this.store.setWorkspaceDefaultNetworkProfile(input.defaultNetworkProfile, Date.now())`
     and returns the same `data` shape recomputed after the write;
     `settings_network_check` calls `await this.networkProfileManager.checkAttestation()`
     and returns `{ ok: true, message: 'Network egress readiness', truncated: false, data: { ready: result.ok, reason: result.reason ?? null } }`.
- **Success criteria:** `settings_get` reports value and source; `settings_update`
  with `null` resets the source back to `'environment'`; the two tools are not
  registered as MCP tools (they are internal operations only).
- **Verify:** `npx vitest run apps/runner/test/internal-runner-operations.test.ts packages/contracts/test/contracts.test.ts` exits 0 with the new cases added.

### Task 1.4 — Report the egress default and the agent remediation

- **Goal:** an MCP caller can learn the effective default, and a subagent refusal
  explains how to proceed.
- **Target files and symbols:**
  - `packages/contracts/src/runner-api.ts` — `WorkspaceCapabilitiesSchema`, the
    `workspace` object (line ~73).
  - `apps/runner/src/workspace-service.ts` — `computeWorkspaceCapabilities`
    (line ~999), the returned `capabilities.workspace` object.
  - `apps/runner/src/agent-manager.ts` — the `agents require a network-disabled workspace`
    error (line ~225).
  - `apps/runner/src/agent-state-repository.ts` — `workspace is not eligible for agent admission` (line ~479).
- **Steps:**
  1. Add `defaultNetworkProfile: ExecutorNetworkProfileSchema` to the
     `workspace` object of `WorkspaceCapabilitiesSchema`.
  2. Populate it in `computeWorkspaceCapabilities` from
     `this.store.getWorkspaceDefaultNetworkProfile() ?? this.config.networkProfile`.
  3. Change the two subagent refusal messages to include the remediation,
     keeping the existing codes and HTTP statuses:
     `agents require a network-disabled workspace; open a separate workspace with networkProfile "network-none"`.
- **Success criteria:** `workspace_capabilities` reports the default without
  mutating anything; the agent refusals still fail with the same code and status.
  The local-mode capability producer is updated in Phase 3 Task 3.4, which owns
  `apps/api/src/local/local-workspace-backend.ts`.
- **Verify:** `npx vitest run apps/runner/test/workspace-capabilities.test.ts apps/runner/test/agent-manager.test.ts apps/runner/test/agent-state-repository.test.ts` exits 0.
- **Docker/Linux-only extra check (record as unavailable when Docker is absent):**
  a workspace created *without* an explicit profile is quarantined when attestation
  is later lost, exercised by the existing dependency-egress suite plus one case
  that omits `networkProfile` instead of proving `network-none`.

## Failure Protocol
If any Verify step does not meet its stated pass condition, STOP this phase.
Do not improvise a fix, retry blindly, or reason around the failure.
Spawn the `kongming` subagent for next-step counsel and pass:
- the phase and task id,
- what you attempted (the steps you ran),
- the exact command and its full output,
- the pass condition it failed to meet.
Apply kongming's guidance, then re-run the Verify step.
If `kongming` cannot be spawned in this environment, STOP and report the same
failure evidence to the user. Never continue by self-reasoning.

## Guardrails
- Never let a persisted setting bypass `ensureProfileReady`.
- Never fall back to `network-none` when egress is unattested; fail closed.
- Settings changes affect future opens only.
