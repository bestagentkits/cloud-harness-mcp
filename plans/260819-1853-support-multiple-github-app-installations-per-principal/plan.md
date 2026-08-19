---
title: "Support multiple GitHub App installations per principal"
description: "Redesign the installation store, SQLite schema, token broker, binding service, dashboard BFF, and UI to support multiple concurrent GitHub App installations (personal account + multiple orgs) per principal."
status: completed
priority: P1
effort: "6h"
tags: ["github-app", "multi-installation", "sqlite-migration", "dashboard", "token-broker", "tdd"]
created: 2026-08-19
issue: 54
---

# Support multiple GitHub App installations per principal

## Overview

Cloud Harness MCP previously bound exactly one GitHub App installation per principal using `principal_id` as the primary key of `github_installations`. Connecting a second account or organization overwrote the previous installation and wiped existing repository grants during reconciliation.

This implementation redesigns the GitHub App integration so that a single principal can hold multiple concurrent installations (e.g. personal account `mrgoonie` alongside organizations `bestagentkits` and `nextlevelbuilder`). The runner selectively mints installation tokens matching the owner of each requested repository, preserving single-principal isolation and least-privilege token minting.

## Architecture and Key Invariants

1. **Schema & Storage (`apps/runner/src/github-installation-sqlite-store.ts`):**
   - `github_installations` primary key changed to `(principal_id, installation_id)`.
   - `UNIQUE(principal_id, account_id)` prevents duplicate installations for the same account under one principal.
   - Global `UNIQUE(installation_id)` ensures an installation cannot be bound across multiple principals (409 Conflict).
   - In-place SQLite migration transforms existing single-installation tables without data loss.
   - Grant reconciliation during `replaceVerified` is scoped strictly to matching `installation_id`.

2. **Store Interface (`apps/runner/src/github-installation-store.ts`):**
   - `replaceVerified`: Adds or updates a single installation and reconciles grants for that installation only.
   - `markUninstalled`: Marks a specific installation (by `installationId`) as uninstalled and its grants removed.
   - `removeInstallation`: Disconnects/removes an installation and removes associated grants.
   - `getInstallation`: Retrieves installation by `principalId` and `installationId` (or single lookup helper).
   - `listInstallations`: Returns all installations bound to a principal.
   - `getRepositoryGrant`: Resolves the active grant for `(principalId, owner, repository)`.
   - `listRepositoryGrants`: Returns repository grants for a principal (optionally filtered by `installationId`).

3. **Token Broker (`apps/runner/src/github-app-broker.ts`):**
   - `mintPrincipalRepositoryToken` resolves the grant for `(principalId, owner, repository)`, locates the specific installation via `grant.installationId`, verifies `status === 'active'` and matching `appId`, and mints the repository-scoped token.
   - Decoupled from any single-installation assumption.

4. **Binding & Reconciliation Service (`apps/runner/src/github-binding-service.ts`):**
   - `completeSetup` verifies and adds/updates an individual installation without wiping other installations.
   - `reconcile` iterates all active installations for the principal, verifying each against GitHub API, marking missing installations as uninstalled, and detecting identity conflicts per installation.
   - `disconnect` removes an installation and its associated repository grants.

5. **Dashboard BFF & UI (`apps/api/src/`, `apps/api/dashboard/`):**
   - `github_status` returns `installations: [...]` and `repositories: [...]`.
   - Dashboard renders cards for each connected installation with per-installation "Reconcile" and "Disconnect" actions.
   - Supports connecting additional accounts/organizations via the setup flow.

## Goals & Acceptance Criteria

| # | Goal | Priority |
|---|------|----------|
| 1 | Multi-installation schema migration with backwards compatibility | P1 |
| 2 | Scoped store methods and grant reconciliation without cross-installation wipes | P1 |
| 3 | Owner-to-installation token broker resolution | P1 |
| 4 | Multi-installation setup, reconciliation, and disconnect service | P1 |
| 5 | Dashboard API contracts and responsive UI for multiple installations | P1 |
| 6 | Comprehensive unit, integration, and security regression tests | P1 |

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Phase 1: Contracts and Schema Migration](./phase-01-start.md) | Completed |
| 2 | [Phase 2: Broker and Binding Service](./phase-02-broker-and-binding-service.md) | Completed |
| 3 | [Phase 3: Dashboard BFF and Public Contracts](./phase-03-dashboard-bff-and-public-contracts.md) | Completed |
| 4 | [Phase 4: Dashboard UI and Rendering](./phase-04-dashboard-ui-and-rendering.md) | Completed |
| 5 | [Phase 5: Documentation and Regression Verification](./phase-05-documentation-and-regression-verification.md) | Completed |

## Success Criteria

- [x] Existing single-row SQLite databases migrate seamlessly to `(principal_id, installation_id)` PK without manual intervention.
- [x] A principal can bind multiple active installations across different GitHub accounts/orgs simultaneously.
- [x] Binding or reconciling one installation does not purge repository grants of other installations.
- [x] `mintPrincipalRepositoryToken` successfully authorizes and mints tokens for repos belonging to any bound installation of the principal.
- [x] Cross-principal binding attempts for the same `installation_id` fail with 409 Conflict.
- [x] Dashboard displays all connected installations and allows connecting additional accounts, reconciling individual installations, and disconnecting specific installations.
- [x] Full test suite (`npm test`) passes with 100% coverage on new and updated paths.
- [x] All security invariants are preserved: no credentials leaked into state, remotes, logs, or MCP envelopes.
<!-- slug: support-multiple-github-app-installations-per-principal -->
