---
title: "Multi-skill archive upload for the Skills library"
description: "Add one runner-side archive import that creates many skills from a single .zip, with path-traversal rejection, entry-count and decompressed-size caps enforced on the decompressed stream, and per-item results."
status: pending
priority: P2
effort: "1d, single PR"
tags: [dashboard, skills, runner, security, upload]
created: 2026-09-23
branch: skill-archive-upload
---

# PR C — Multi-skill archive upload

## Context

The Skills library can create one custom skill at a time (`skill_create_custom`) and import one
source per job (`skill_import_start`). An operator holding a directory of skills has to repeat the
single-skill flow once per skill. This plan adds one archive upload that creates many skills from a
single `.zip`, validating every entry before anything is written.

## Why the unpack is runner-side

The skills package cache and the skill tables both live behind the runner. The API is forbidden from
receiving the runner's state or job mounts, so it cannot drop a file where the runner would find it;
the bytes have to travel over the API-to-runner call. The runner is therefore the only place that can
validate an archive and create its skills in one place, and it is the right place to own the caps.

## Scope

- One new runner operation that accepts an archive, validates it, and creates skills per entry.
- One API route that accepts the upload under a hard body limit and forwards it.
- Dashboard upload control on the Skills page.
- Dedicated tests that prove every cap and the traversal guard fail closed.

## Non-goals

- No archive export, no "download these skills as a zip".
- No overwrite of an existing skill: an entry whose slug already exists is reported as a per-item
  conflict, matching `skill_bulk`'s per-item results rather than failing the whole upload.
- No new storage layer. The archive is validated in memory and never written before validation.
- No change to the public MCP tool surface: this is an internal API-to-runner contract plus a
  dashboard route.

## Caps (all enforced runner-side, mirrored as early rejection API-side)

| Limit | Value | Why |
| --- | --- | --- |
| Archive bytes | 8 MiB | Bounds what the API buffers and forwards. |
| Entries considered | 200 | Bounds the number of skills one upload can create. |
| Per-entry decompressed | 2 MiB | One skill document is small; a large entry is a red flag. |
| Total decompressed | 32 MiB | Defeats a zip bomb whose entries are individually small. |

A limit that is exceeded rejects the archive rather than truncating it: a partially unpacked archive
would create some skills and silently drop others, which the operator cannot distinguish from a
successful upload of fewer skills.

## Invariants

- **Path traversal is rejected, not sanitised.** An entry whose resolved path escapes the extraction
  root is refused. Sanitising would silently rename an entry into a skill the operator did not author.
- **Every entry is validated before any skill is created**, so a malformed archive cannot leave a
  half-created library. The archive is parsed and all entries checked first; creation runs second.
- **Per-item results, never an all-or-nothing failure.** Each entry reports `created`, `skipped` with a
  reason, or `failed` with a message, so one bad skill does not discard the good ones. This mirrors
  `skill_bulk`.
- **The caps are enforced on the decompressed stream, not on the archive's declared sizes.** A
  declared size is attacker-controlled and cannot be trusted.

## Phases

1. `phase-01-runner-operation.md` — the archive validator and the creating operation.
2. `phase-02-api-route.md` — the upload route, its body limit, and the forwarding call.
3. `phase-03-dashboard.md` — the upload control and its per-item result reporting.
4. `phase-04-tests-docs-ship.md` — the security tests, the docs, and the ship.

## Open questions to settle in phase 01

- Whether the internal contract carries the archive as base64 inside the existing JSON envelope or as
  a binary body. Base64 is simpler and matches the surrounding contract; it costs 33% inflation,
  which the 8 MiB cap already accounts for.
- Which entries count as a skill. The narrow rule is a `SKILL.md` at any depth; a looser rule risks
  treating a nested resource file as a skill.
