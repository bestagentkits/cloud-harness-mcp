---
phase: 1
title: "Contracts, Schemas & SQLite Database Migrations (TDD)"
status: pending
priority: P1
effort: "9h"
dependencies: []
---

# Phase 1: Contracts, Schemas & SQLite Database Migrations (TDD)

## Overview
Define public and internal contracts for skills.sh/SkillX registry toolkits, multi-set workspace launches, and skill provenance in `@cloud-harness/contracts`. Implement the relational database schema in `StateStore` with composite owner/source foreign keys, strict deletion rules (`ON DELETE RESTRICT`), and parent unique constraints.

## Requirements
- **Functional:**
  - Extend `ToolkitSelectionSchema` with `kind: 'registry'` supporting `skills-sh` and `skillx`.
  - Extend `workspace_open` parameters with `skillSets` (array of `{ skillSetId, expectedGeneration }`) and `skillOverrides` (mapping of `name -> revisionId`).
  - Add SQLite tables in `apps/runner/src/state-store.ts`: `skill_sources`, `skill_revisions`, `skill_sets`, `skill_set_items`, `workspace_skill_set_snapshots`, `workspace_skill_assignments`, `skill_catalog_entries`, and `skill_import_jobs`.
  - Operator-managed skill metadata lives on `skill_sources`, never on the immutable content rows: `state TEXT NOT NULL DEFAULT 'enabled' CHECK (state IN ('enabled','disabled','archived'))`, `display_name`, `description`, `tags TEXT NOT NULL DEFAULT '[]'` (validated JSON array, at most 16 tags of at most 32 characters), `generation INTEGER NOT NULL DEFAULT 1`, `updated_at INTEGER NOT NULL`.
  - `skill_revisions` records the provenance the management UI must show: `parent_revision_id` (nullable self reference), `origin TEXT NOT NULL CHECK (origin IN ('import','refresh','edit','restore','fork'))`, and `has_executable_assets INTEGER NOT NULL DEFAULT 0` derived during normalization. Restore and fork create a new immutable revision; they never mutate or repoint an existing one.
  - `skill_import_jobs` is the durable owner of asynchronous import progress, because `state-store.ts` has no generic operations table: `(owner_id, id)` primary key, `source_kind TEXT NOT NULL CHECK (source_kind IN ('skills-sh','skillx','git'))`, `source_ref`, `state TEXT NOT NULL CHECK (state IN ('queued','running','succeeded','failed','cancelled'))`, `progress_json`, `result_json`, `error_code`, `created_at`, `updated_at`, with `ON DELETE RESTRICT` from the produced `skill_revisions`.
  - Extend the internal runner operation enums in `packages/contracts/src/internal-runner-api.ts` with strict, versioned request schemas for the operations the management UI needs: `skill_list`, `skill_get`, `skill_revision_list`, `skill_revision_get`, `skill_revision_diff`, `skill_restore`, `skill_create_custom`, `skill_update`, `skill_archive`, `skill_bulk`, `skill_usage`, `skill_import_start`, `skill_import_status`, `skill_import_cancel`, `skill_search`, `skill_set_list`, `skill_set_get`, `skill_set_create`, `skill_set_update`, `skill_set_delete`, `skill_set_preview`, `toolkit_registry_list`, `toolkit_registry_update`, `toolkit_registry_refresh`.
- **Non-functional / Security:**
  - Enforce every `skill_sources.state` transition in one place so `disabled` and `archived` cannot be bypassed by a write that updates content or metadata directly.
  - Reuse the existing unique index `workspaces_owner_id_id ON workspaces(owner_id, id)` (`apps/runner/src/state-store.ts:283-284`) as the composite-foreign-key precondition. Do not add a second equivalent index.
  - Enforce composite foreign keys `(owner_id, ...)` across all tables to guarantee strict principal isolation.
  - Enforce `(owner_id, id, current_revision_id) -> skill_revisions(owner_id, skill_source_id, id)` with matching `UNIQUE(owner_id, skill_source_id, id)` to prevent same-owner cross-source revision assignment.
  - Enforce `ON DELETE RESTRICT` on workspace locks and set items so active workspace snapshots act as GC roots.

## Architecture
```text
workspaces (owner_id, id) [UNIQUE]
  ▲                  ▲
  │ (composite FK)   │ (composite FK)
  │                  │
workspace_skill_set_snapshots (owner_id, workspace_id, ordinal)
                     workspace_skill_assignments (owner_id, workspace_id, ordinal)
                       │
                       ▼ (composite FK ON DELETE RESTRICT)
skill_sources (owner_id, id) ◄───┐ (composite FK ON DELETE CASCADE)
  ▲                              │
  │ (composite FK)               │
  │                              ▼
  │                     skill_revisions (owner_id, skill_source_id, id) [UNIQUE]
  │                                      ▲
  │ (composite FK ON DELETE CASCADE)     │ (composite FK ON DELETE RESTRICT)
skill_sets (owner_id, id) ◄──────────────┴─── skill_set_items (owner_id, skill_set_id, ordinal)
```

## Related Code Files
- Modify: `packages/contracts/src/tool-schemas.ts` (`ToolkitSelectionSchema` and the `schemas.workspace_open` params object both live here)
- Modify: `packages/contracts/src/internal-runner-api.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `apps/runner/src/principal-store.ts` (owns the version 10 ladder step, including the new DDL)
- Modify: `apps/runner/src/state-store.ts` (owns the `StateStore` CRUD helpers, not the DDL)
- Create: `packages/contracts/test/registry-toolkit-schemas.test.ts`
- Create: `apps/runner/test/state-schema-skills.test.ts`

## Implementation Steps
1. **Tests-First (TDD):**
   - Write a migration test as `apps/runner/test/state-schema-v11.test.ts`, matching the existing `state-schema-v10.test.ts` pattern: open a database produced by an unmodified current base at version 10 **with knowledge-plane rows and workspaces populated**, apply the migration, and assert version 11, an empty `PRAGMA foreign_key_check`, and the pre-existing rows intact. Also assert that the same database reopened at version 11 is a no-op, and cover `downgradeStateSchemaToV10` including its data-loss refusal. This is the regression test for the ladder owning the DDL rather than the bootstrap block.
   - Write unit tests in `packages/contracts/test/registry-toolkit-schemas.test.ts` validating parsing and rejection rules for `kind: 'registry'` as the third arm of `ToolkitSelectionSchema`, plus `skillSets` and `skillOverrides` on the workspace-open params object.
   - Write unit tests in `apps/runner/test/state-schema-skills.test.ts` validating:
     - DDL execution with `PRAGMA foreign_keys = ON;`.
     - Rejection of cross-owner foreign key insertion attempts.
     - Rejection of same-owner cross-source `current_revision_id` pointing.
     - `ON DELETE RESTRICT` preventing deletion of revisions locked by active workspaces or skill sets.
     - Cascading deletion of workspaces cleaning up snapshots and assignments.
     - Rejection of an illegal `state` transition (for example `archived` back to `enabled` in one step) and rejection of a tag payload that is not a JSON array of bounded strings.
     - Rejection of an `UPDATE` that tries to change content columns of an existing `skill_revisions` row, proving restore and fork go through new rows with `origin` recorded.
     - Durability of `skill_import_jobs` across a store reopen, including a terminal `state` that is written exactly once.
2. **Contract Updates:**
   - Add a third arm to `ToolkitSelectionSchema`, which is a `z.discriminatedUnion('kind', [...])` over `preset` and `git` today, for `kind: 'registry'` with provider `skills-sh` or `skillx`.
   - Add `skillSets` and `skillOverrides` to the workspace-open params object `schemas.workspace_open` in `packages/contracts/src/tool-schemas.ts`, next to the existing `toolkits`, `allowToolkitWorkspaceChanges`, and `networkProfile` fields. There is no `WorkspaceOpenParamsSchema` and `packages/contracts/src/runner-api.ts` holds only `RunnerPrincipalSelectorSchema`, so adding the fields there would have produced dead code.
   - Export new types: `ToolkitRegistrySelection`, `SkillSetSelection`, `SkillOverrideMap`.
3. **Database Schema Migration:**
   - Add the skill management, snapshot, and `skill_import_jobs` DDL inside a new `if (version === 10)` ladder step in `apps/runner/src/principal-store.ts` that ends with `UPDATE schema_meta SET version = 11`, following the existing knowledge-plane step that reached version 10. Add `downgradeStateSchemaToV10` as its paired reverse, dropping the new tables and refusing without `allowDataLoss` when they hold rows. Do **not** add the DDL to the `StateStore` constructor's unconditional `CREATE TABLE IF NOT EXISTS` block: that block runs on every open before `migratePrincipalSchema(this.database)`, so tables added there would appear on a version 10 database without any version transition and the ladder would not own them.
   - Own the schema version bump in `apps/runner/src/principal-store.ts`, where the live migration ladder ends at `UPDATE schema_meta SET version = 10` (the knowledge plane), with `if (version !== 10) throw new Error(...)` as the guard and `downgradeStateSchemaToV9` as its paired reverse. The new migration therefore takes the store to **version 11**, not 10, and must ship a paired `downgradeStateSchemaToV10` with the same data-loss guards the rest of the ladder uses. `state-store.ts` only seeds version 1 and must not be treated as the ladder owner.
   - Implement CRUD helper methods on `StateStore` for skill sources, revisions, sets, workspace locks, and import jobs, including `setSkillState`, `listSkillUsage` (sets plus live workspace snapshots holding a revision), and a generation-fenced update that returns the new generation.
4. **Verification:**
   - Run `npm test packages/contracts/test/registry-toolkit-schemas.test.ts` and `npm test apps/runner/test/state-schema-skills.test.ts`.

## Success Criteria
- [ ] `ToolkitSelectionSchema` successfully validates `kind: 'registry'` for both `skills-sh` and `skillx` providers.
- [ ] `workspace_open` validates up to 16 `skillSets` and up to 128 `skillOverrides`.
- [ ] SQLite migrations execute cleanly with `foreign_keys = ON` on new and existing databases.
- [ ] Cross-owner insertion tests fail with `FOREIGN KEY constraint failed`.
- [ ] Same-owner cross-source revision assignment fails with `FOREIGN KEY constraint failed`.
- [ ] Deletion of revisions locked by active workspaces is blocked by `RESTRICT`.
- [ ] `skill_sources.state` moves only through allowed transitions, and an `archived` skill is excluded from resolution input while its revisions stay referenced by live workspace snapshots.
- [ ] Every content change is a new `skill_revisions` row with `parent_revision_id` and `origin` set; no existing revision row is updated in place.
- [ ] An import job survives a store reopen and reports terminal state exactly once.
- [ ] The new tables land as schema version 11, with the DDL owned by the `if (version === 10)` ladder step in `apps/runner/src/principal-store.ts` rather than the `StateStore` bootstrap block, a paired `downgradeStateSchemaToV10` exists with data-loss guards, and the composite foreign keys use the pre-existing `workspaces_owner_id_id` index rather than a duplicate.

## Risk Assessment
- **Risk:** Adding mutable `state`, `tags`, and `generation` columns to `skill_sources` while content stays immutable invites in-place content edits.
- **Mitigation:** Keep content exclusively in `skill_revisions`, and cover the separation with a test that rejects an in-place UPDATE of revision content columns.
- **Risk:** SQLite table migration order and foreign key creation order on existing databases with legacy data.
- **Mitigation:** Ensure tables are created in dependency order (`skill_sources`, then `skill_revisions`, then `skill_sets`, `skill_set_items`, `workspace_skill_set_snapshots`, `workspace_skill_assignments`, then `skill_import_jobs`), reusing the existing `workspaces_owner_id_id` index rather than creating another, and using `DEFERRABLE INITIALLY DEFERRED` on cyclic foreign keys between `skill_sources` and `skill_revisions`.

## Plan Corrections (verified against the working tree before implementation)
Three statements in the original phase text did not match the repository. Each was checked against the file and corrected in place; none changes the phase's outcome.

1. **`WorkspaceOpenParamsSchema` does not exist.** `packages/contracts/src/runner-api.ts` exports `RunnerPrincipalSelectorSchema` and no workspace-open params schema, so the instructed edit would have written dead code. The real owner is the `schemas.workspace_open` entry in `packages/contracts/src/tool-schemas.ts:264`, next to `toolkits`, `allowToolkitWorkspaceChanges`, and `networkProfile`. Contract updates and tests now name that object.
2. **`ToolkitSelectionSchema` gains a third arm, not a `kind` value.** It is a `z.discriminatedUnion('kind', [...])` over `preset` and `git` at `packages/contracts/src/tool-schemas.ts:34-59`, so `kind: 'registry'` is a new union member with its own provider enum rather than an added field.
3. **The new DDL belongs in the migration ladder, not the `StateStore` bootstrap block.** `StateStore`'s constructor runs one unconditional `CREATE TABLE IF NOT EXISTS` block and then calls `migratePrincipalSchema(this.database)`; the ladder's live head is `if (version === 9)` in `apps/runner/src/principal-store.ts:546`, which creates `model_provider_credential_versions` and ends at `UPDATE schema_meta SET version = 9`, with `if (version !== 9) throw new Error('unsupported state schema version ...')` as the guard. Adding the skill tables to the bootstrap block would have created them on a version 9 database with no version transition and left the ladder without ownership of its own DDL. The phase now puts the DDL in a new `if (version === 10)` step ending at version 11, and keeps only the `StateStore` CRUD helpers in `state-store.ts`.

4. **Superseded by the rebase onto `origin/main` — target version 11, not 10.** The statements above were verified against the pre-rebase tree. After rebasing onto `origin/main` (v0.48.0, `cbb18d1`), the ladder already ends at version 10: `principal-store.ts:756` sets it, `:760` guards it, `:763` is `downgradeStateSchemaToV9`, and `apps/runner/test/state-schema-v10.test.ts` covers it. The skill tables must therefore take the store to **version 11** with a paired `downgradeStateSchemaToV10` and a `state-schema-v11.test.ts`. Every other anchor in this phase was re-checked after the rebase: `WorkspaceOpenParamsSchema` is still absent, `ToolkitSelectionSchema` still gains a third arm, and the `StateStore` constructor still runs its DDL block before the ladder.
