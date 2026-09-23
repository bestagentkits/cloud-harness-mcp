---
phase: 1
title: "Runner operation validates an archive and creates one skill per entry"
status: pending
priority: P1
effort: "4-5h"
dependencies: []
---

# Phase 01 — Runner operation

## Deliverable

A new runner operation that accepts a skill archive, validates it under the plan's caps, and creates
one skill per qualifying entry, returning a per-item result.

## Owners to inspect first

- `packages/contracts/src/internal-runner-api.ts` — the operation inputs, including the two
  `.strict()` skill inputs at `skill_revision_create` and `skill_create_custom`.
- `apps/runner/src/dashboard-control-service.ts` — the handler dispatch and the existing
  `skill_create_custom` path to reuse rather than duplicate.
- `apps/runner/src/state-store.ts` — `createSkillSource` and `addSkillRevision`, already used by the
  custom-skill path.
- `worker/harness-worker.mjs` — `parseSkillDocument` and the flat frontmatter regex the roster uses.

## Steps

1. Add the operation input to the internal contract: the archive payload, and an optional expected
   generation consistent with the surrounding ops. Keep it `.strict()`.
2. Write the archive reader. It must:
   - enumerate entries and refuse a count above the cap before reading any content;
   - resolve each entry path against the extraction root and refuse anything that escapes it,
     including absolute paths, `..` segments, and drive-style prefixes;
   - decompress each entry while accumulating a running total, refusing when either the per-entry or
     the total cap is exceeded, so a zip bomb fails on the stream rather than after it.
3. Select qualifying entries (a `SKILL.md` at any depth), parse each one's frontmatter for the slug,
   display name and instructions, and validate them with the same rules the single-skill path uses.
4. Create skills second, after every entry has validated, using the existing
   `createSkillSource` / `addSkillRevision` pair so a version declared in the frontmatter is stored
   exactly as the single-skill path stores it.
5. Return per-item results shaped like `skill_bulk`: one row per entry with an outcome and, for a
   non-created row, the reason.

## Acceptance

- An archive whose entries all validate creates one skill per entry.
- An entry count above the cap, a total or per-entry size above the cap, and an escaping path each
  reject the archive with no skill created.
- A malformed entry is reported per item and does not prevent the other entries from being created.
- An entry whose slug already exists is reported as a conflict, not as a failure of the upload.

## Tests

`apps/runner/test/skill-archive.test.ts`, proving each cap and the traversal guard, plus the
per-item outcome shapes. Fixtures are built in the test rather than committed as binaries.
