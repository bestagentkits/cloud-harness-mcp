---
phase: 1
title: "Contracts and Schema Migration"
status: completed
priority: P1
effort: "1.5h"
dependencies: []
---

# Phase 1: Contracts and Schema Migration

## Overview
Redesign the `GitHubInstallationStore` interface and `SqliteGitHubInstallationStore` implementation to support multiple installations per principal. Rebuild the `github_installations` SQLite table with compound primary key `(principal_id, installation_id)`, add account and global installation uniqueness constraints, implement in-place schema migration from single-installation databases, and scope grant reconciliation per installation.

## Requirements
- Functional:
  - `GitHubInstallationStore` interface supports `listInstallations(principalId)`, `getInstallation(principalId, installationId?)`, `markUninstalled(principalId, installationId, checkedAt, audit?)`, and `removeInstallation(principalId, installationId, checkedAt, audit?)`.
  - SQLite table `github_installations` schema updated: Primary Key is `(principal_id, installation_id)`.
  - Unique index `github_installations_principal_account` on `(principal_id, account_id)`.
  - Global unique index `github_installations_installation_identity` on `(installation_id)`.
  - Schema migration detects old `github_installations` table (where `principal_id` was PK) and migrates rows into new schema without data loss.
  - `replaceVerified` updates or inserts the specific installation and updates grants for that installation only; existing grants from other installations of the same principal remain untouched.
  - `markUninstalled` sets `status = 'uninstalled'` on the specific installation and marks its grants as `removed`.
  - `removeInstallation` deletes or marks removed the specific installation and associated repository grants.
  - `InMemoryGitHubInstallationStore` updated to match the interface and multi-installation behavior.
- Non-functional:
  - Atomic transactions (`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`).
  - Zero downtime / zero manual SQL intervention on existing deployed databases.

## Architecture
- Table schema:
  ```sql
  CREATE TABLE IF NOT EXISTS github_installations (
    principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
    app_id TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    account_login TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active','suspended','uninstalled')),
    generation INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    checked_at INTEGER NOT NULL,
    PRIMARY KEY(principal_id, installation_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS github_installations_principal_account
    ON github_installations(principal_id, account_id);
  CREATE UNIQUE INDEX IF NOT EXISTS github_installations_installation_identity
    ON github_installations(installation_id);
  ```
- Migration logic:
  - Check if `github_installations` exists and if its table info has `pk=1` for `principal_id` only.
  - If legacy schema detected: rename to `github_installations_old`, create new table and indexes, copy data `INSERT INTO github_installations SELECT * FROM github_installations_old`, drop `github_installations_old`.

## Related Code Files
- Modify: `apps/runner/src/github-installation-store.ts`
- Modify: `apps/runner/src/github-installation-sqlite-store.ts`
- Modify: `apps/runner/test/github-installation-sqlite-store.test.ts`
- Modify: `packages/contracts/src/internal-runner-api.ts` (if operations/inputs need extension)

## Implementation Steps (TDD)
1. **Tests First:**
   - In `apps/runner/test/github-installation-sqlite-store.test.ts`:
     - Test storing multiple active installations under the same principal (e.g. personal account `mrgoonie` and org `bestagentkits`).
     - Test that calling `replaceVerified` for org B does NOT remove or modify repository grants for org A.
     - Test `listInstallations(principalId)` returns all installations.
     - Test `getInstallation(principalId, installationId)` returns the specific installation.
     - Test `markUninstalled(principalId, installationId)` updates only the specified installation.
     - Test `removeInstallation(principalId, installationId)` removes the installation and its grants.
     - Test uniqueness: binding the same `installation_id` to `principalB` fails with 409 Conflict.
     - Test uniqueness: binding a second installation for the same `account_id` under the same principal updates/replaces that account's installation.
     - Test database migration: create a SQLite database with legacy single-row schema and populated grants, run migration, verify data integrity, compound PK, and subsequent multi-installation additions.
2. **Implement `github-installation-store.ts`:**
   - Update types and `GitHubInstallationStore` interface.
   - Update `InMemoryGitHubInstallationStore`.
3. **Implement `github-installation-sqlite-store.ts`:**
   - Implement table migration in `migrateGitHubInstallationSchema`.
   - Update `SqliteGitHubInstallationStore` methods.
4. **Run and Verify Tests:**
   - `npx vitest run apps/runner/test/github-installation-sqlite-store.test.ts` passes.

## Success Criteria
- [x] Multiple installations can be persisted and listed per principal in both InMemory and SQLite stores.
- [x] Adding/reconciling an installation does not purge repository grants of other installations.
- [x] Legacy SQLite database with existing single-installation schema migrates cleanly without data loss.
- [x] All unit tests in `apps/runner/test/github-installation-sqlite-store.test.ts` pass.

## Risk Assessment
- *Risk:* SQLite table recreation could fail if foreign keys or triggers interfere.
  *Signal:* Migration error during table rebuild or data copy.
  *Mitigation:* Run migration inside transaction, verify `PRAGMA foreign_keys` handling, and test with pre-existing data fixtures.
