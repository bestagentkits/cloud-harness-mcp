# Phase 03 — Contracts and persistence

## Contract changes

`packages/contracts/src/internal-runner-api.ts` — both objects are `.strict()`,
so each needs the field added explicitly:

- `skill_revision_create` (L392): add `version` as an optional validated semver
  string.
- `skill_create_custom` (L400): add the same optional field.

Define the semver schema once and reuse it in both, rather than repeating the
regex — the parser and the contract must not drift apart.

## Persistence

`apps/runner/src/state-store.ts`:

1. `createSkillSource` and the revision-insert path accept an optional version
   and write it to `skill_revisions.version`.
2. Extend the revision row mapping so `version` round-trips.
3. Keep `NULL` for a revision whose document and caller both omit a version.

## Response projection

`apps/runner/src/dashboard-response.ts`: include `version` in the skill and
revision projections so `skill_list`, `skill_get` and `skill_revision_list`
expose it. Add it to whatever allowlist already governs those payloads rather
than spreading a new shape.

## Drift warning

When a revision is created, compare its version against the current revision's
version. If the new one is not a bump, attach an advisory warning to the
response — same channel the operation already uses for non-fatal notices. It
must not change the outcome, the stored row, or the status code.

## Verification

- Omitting `version` still creates a revision (stored `NULL`).
- A malformed version is refused before any row is written.
- A non-bumping version creates the revision and reports the warning.
- Round-trip: a stored version is returned by `skill_revision_list`.
- `skill_create_custom` and `skill_revision_create` reject unknown fields, so the
  new field must be declared rather than silently ignored.
