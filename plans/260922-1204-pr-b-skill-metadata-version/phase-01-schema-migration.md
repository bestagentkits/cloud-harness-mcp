---
phase: 1
title: "Principal schema migration v11 → v12"
status: completed
priority: P1
effort: "2-3h"
dependencies: []
---

# Phase 01 — Principal schema migration v11 → v12

## Owner

`apps/runner/src/principal-store.ts` → `migratePrincipalSchema()`.

## Steps

1. Add the next sequential guard after the `if (version === 11)` block, following
   the file's existing pattern (`transaction(database, () => { … })`, then
   `UPDATE schema_meta SET version = 12;`).
2. Inside it, add the column additively:
   `ALTER TABLE skill_revisions ADD COLUMN version TEXT;`
   Nullable, no default, no `CHECK` on the value — semver shape is enforced at
   the contract and parser boundary so a future format change does not require a
   table rebuild.
3. Recreate the immutability trigger with `version` included, because SQLite
   cannot `ALTER` a trigger:
   `DROP TRIGGER IF EXISTS skill_revisions_immutable;` then `CREATE TRIGGER`
   with the existing WHEN clause plus `OR OLD.version IS NOT NEW.version`.
4. Keep the existing guards untouched; do not renumber or rewrite earlier
   migrations.

## Notes

- `ALTER TABLE … ADD COLUMN` is safe on a populated table and preserves existing
  rows as `NULL`.
- The trigger body must otherwise stay byte-identical in behaviour: same
  `RAISE(ABORT, 'skill revisions are immutable; create a new revision')` message.

## Verification

- Reopening a database created at v11 applies v12 once and is idempotent on the
  next open.
- A row inserted before the migration reads back with `version = NULL`.
- An `UPDATE` that changes only `version` aborts with the immutability message.
- An `UPDATE` that changes nothing on an existing revision still succeeds.
