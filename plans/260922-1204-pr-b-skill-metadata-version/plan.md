---
title: "Version control for skills via metadata.version"
description: "Give every skill revision a declared version read from metadata.version in the SKILL.md frontmatter: validate it as semver, store it on the revision, warn on drift without ever blocking a revision, and surface it in the dashboard."
status: completed
priority: P2
effort: "1d, single PR"
tags: [runner, skills, dashboard, contracts, schema]
created: 2026-09-22
branch: skill-metadata-version
---

# PR B — version control for skills via `metadata.version`

## Goal

Give every skill revision a declared version, taken from the `version` key
nested under `metadata:` in the skill's `SKILL.md` YAML frontmatter, and make it
visible to operators.

## Accepted semantics (owner decisions)

| Case | Behaviour |
| --- | --- |
| Version present and valid semver | store it on the revision, display it |
| Version absent | allowed; revision version stays `NULL` |
| Version malformed | **reject** with `INVALID_INPUT` |
| New revision does not bump the previous version | **warn (advisory) only — never reject** |

The "never reject for drift" rule is the point of the feature: a version is a
declaration, not an enforced gate. Malformed input is a different failure — it
cannot be stored meaningfully, so it is refused.

## Why this shape

- **Storage is the runner's principal store, not the metadata database.** Skill
  sources and revisions live in `skill_sources` / `skill_revisions`, created by
  `migratePrincipalSchema()` in `apps/runner/src/principal-store.ts` (currently
  `schema_meta.version = 11`). The metadata schema (`metadata-schema.ts`,
  version 6) holds projects, secrets, API keys and MCP gateway tables — it has no
  skill tables. An earlier note claiming a metadata-schema migration was wrong.
- **The column is additive and nullable**, so an older release reading a newer
  database keeps working and a code-only rollback is safe. The repo's only
  down-migration scripts (`metadata-schema-down*.ts`) target the metadata
  database; the principal schema has no down path, so the migration must not
  require one.
- **The existing `skill_revisions_immutable` trigger must be extended.** It
  aborts any `UPDATE` touching `owner_id`, `id`, `skill_source_id`,
  `parent_revision_id`, `origin`, `bundle_sha256`, `content_sha256` or
  `has_executable_assets`. If `version` is added but omitted from that trigger,
  a revision's declared version becomes the one field on an otherwise immutable
  row that can be silently rewritten — falsifying the append-only guarantee the
  trigger exists to protect.

## Executable owners to touch

| Concern | Owner |
| --- | --- |
| Schema + trigger | `apps/runner/src/principal-store.ts` (`migratePrincipalSchema`) |
| Frontmatter parsing | `worker/harness-worker.mjs` `parseSkillDocument` (~L320) and a new runner module |
| Persistence | `apps/runner/src/state-store.ts` (`createSkillSource`, `addSkillRevision`, revision mapping) |
| Contract inputs | `packages/contracts/src/internal-runner-api.ts` (`skill_revision_create` L392, `skill_create_custom` L400) |
| Response projection | `apps/runner/src/dashboard-response.ts` |
| Operator UI | `apps/api/dashboard/` + `apps/api/test/dashboard-ui-contract.test.ts` |
| Guidance | `docs/`, `docs-site/dashboard/skills.md`, `.agents/skills/cloudharness/` |

## Constraints

- Both contract inputs are `.strict()` objects, so `version` is added as an
  explicit optional field rather than passed through.
- Roster text is attacker-influenceable when a repository ships skills, so the
  parsed version is validated and bounded before it reaches any roster output —
  never trusted because it came from frontmatter.
- No new runtime dependency for YAML unless the runner already has one; the
  nested `metadata.version` form needs a small indentation-aware subset parser,
  not a full YAML implementation.

## Phases

1. `phase-01-schema-migration.md` — principal schema v11 → v12, trigger extension
2. `phase-02-version-parsing.md` — nested frontmatter extraction + semver validation
3. `phase-03-contracts-and-persistence.md` — contract fields, store writes, projections
4. `phase-04-dashboard.md` — library column, revision list, drift warning
5. `phase-05-verification-and-ship.md` — tests, docs, skill guidance, gate, ship

## Acceptance criteria

- A malformed `metadata.version` is refused with `INVALID_INPUT`; an absent one
  is accepted and stored as `NULL`.
- A non-bumping version produces an advisory warning and the revision is still
  created.
- Existing rows with `NULL` version continue to load and display.
- The immutability trigger rejects an `UPDATE` that changes `version`.
- Migration is additive; a database at v12 read by pre-change code still works.
- `npm run verify`, `npm run verify:compose`, `npm run docs:reference`,
  `npm run docs:check`, `npm run docs:build` and `npm run plugin:sync` all pass.

## Out of scope

- Enforcing monotonic versions, and any semver range/constraint resolution.
- Backfilling versions for existing revisions (they stay `NULL`).
