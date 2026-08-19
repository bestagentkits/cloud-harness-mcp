---
phase: 2
title: "Broker and Binding Service"
status: completed
priority: P1
effort: "1.5h"
dependencies: [1]
---

# Phase 2: Broker and Binding Service

## Overview
Update `mintPrincipalRepositoryToken` in `github-app-broker.ts` to locate the correct installation via the repository grant's `installationId` instead of assuming a single global installation per principal. Update `GitHubBindingService` in `github-binding-service.ts` to support multi-installation setup completion, multi-installation reconciliation, and installation disconnection.

## Requirements
- Functional:
  - `mintPrincipalRepositoryToken`:
    - Lookup repository grant for `(principalId, owner, repository)`.
    - Verify grant status is `granted` and contents permission satisfies `requiredPermission`.
    - Lookup the installation matching `grant.installationId` for `principalId`.
    - Verify installation status is `active` and `appId` matches runner configuration.
    - Mint repository token via `mintForInstallation` with `grant.installationId`.
    - Deny requests with 403 FORBIDDEN if grant missing/removed/insufficient, installation missing/suspended/uninstalled, or wrong app.
  - `GitHubBindingService`:
    - `completeSetup`: consumes setup state token, calls `verifier.verifyInstallation`, enforces constraints, and calls `installations.replaceVerified`.
    - `reconcile`: iterates all active installations for the principal via `installations.listInstallations(principalId)`. For each:
      - Verifies with `verifier.verifyInstallation`.
      - If provider returns 404 NOT_FOUND: marks that installation `uninstalled` and removes its grants.
      - If provider returns mismatch in `appId` or `accountId`: throws 409 CONFLICT or marks installation in conflict.
      - If verification succeeds: calls `replaceVerified`.
      - Returns list or summary of reconciled installations.
    - `disconnect`: removes or marks uninstalled a specific installation.
- Non-functional:
  - Preserves credential isolation: tokens minted on demand only; no token or private key persisted.

## Architecture
- Broker Resolution Flow:
  ```
  (principalId, repositoryUrl)
       │
       ▼
  getRepositoryGrant(principalId, owner, repo)
       │ (checks status === 'granted', permission)
       ▼
  getInstallation(principalId, grant.installationId)
       │ (checks status === 'active', appId match)
       ▼
  mintForInstallation(githubApp, grant.installationId, repo)
  ```
- Reconciliation Flow:
  ```
  listInstallations(principalId)
       │
       ├─► Installation 1 ──► verifyInstallation(1) ──► replaceVerified(1)
       ├─► Installation 2 ──► verifyInstallation(2) ──► 404 ──► markUninstalled(2)
       └─► Installation 3 ──► verifyInstallation(3) ──► replaceVerified(3)
  ```

## Related Code Files
- Modify: `apps/runner/src/github-app-broker.ts`
- Modify: `apps/runner/src/github-binding-service.ts`
- Modify: `apps/runner/test/github-app-broker.test.ts`
- Modify: `apps/runner/test/github-binding-service.test.ts`
- Modify: `apps/runner/test/github-app-leak.test.ts`

## Implementation Steps (TDD)
1. **Tests First:**
   - In `apps/runner/test/github-app-broker.test.ts`:
     - Test minting tokens for repos belonging to distinct installations (e.g. `ownerA/repoA` on `installation1` and `ownerB/repoB` on `installation2`) under the same principal.
     - Test token minting failure when one installation is suspended or uninstalled while another remains active.
     - Test wrong-owner rejection and cross-principal rejection.
   - In `apps/runner/test/github-binding-service.test.ts`:
     - Test adding a second installation via `completeSetup` without purging first installation's grants.
     - Test `reconcile` reconciling multiple installations in sequence.
     - Test `reconcile` handling 404 NOT_FOUND for one installation (marking it uninstalled) while keeping other installations active.
     - Test disconnecting an installation.
2. **Implement Broker Changes:**
   - Update `mintPrincipalRepositoryToken` in `apps/runner/src/github-app-broker.ts`.
3. **Implement Binding Service Changes:**
   - Update `GitHubBindingService` in `apps/runner/src/github-binding-service.ts`.
4. **Run and Verify Tests:**
   - `npx vitest run apps/runner/test/github-app-broker.test.ts apps/runner/test/github-binding-service.test.ts apps/runner/test/github-app-leak.test.ts`

## Success Criteria
- [x] Principal can access private repositories across personal and organization accounts concurrently.
- [x] Token broker mints repository tokens against the correct installation ID.
- [x] Binding service reconciles all installations and marks uninstalled accounts appropriately.
- [x] All broker and binding service tests pass cleanly.

## Risk Assessment
- *Risk:* Cross-installation grant collision if two orgs have identically named repositories.
  *Signal:* Grant lookup ambiguity.
  *Mitigation:* Grants are keyed by `(principal_id, owner, repository)` where `owner` is lowercase GitHub account/org login. Since GitHub repository paths `owner/repo` are unique on GitHub, no collision is possible.
