# Skill sets

Use `skillSets` on `workspace_open` to give a workspace the skills an owner uploaded to the Dashboard
skill library. `skillSets` is a list of at most 16 `{ skillSetId, expectedGeneration }` entries; both
values come from the Dashboard, so ask the operator rather than guessing them.

## What a launch does

- Each set member is projected, at the revision the set pinned (not the skill's newest revision), into
  the `owner` tier, beside `owner`-scoped toolkit skills. `skills_list` and `skills_read` then return it
  with source `owner`, and report its library `revisionId`.
- The selection is resolved before any workspace record, clone, or container exists, and is part of the
  idempotency fingerprint: replaying a key with a different selection is a `CONFLICT`.

## Refusals (fail closed)

| Condition | Error |
| --- | --- |
| Unknown set, or a pinned revision or bundle that is gone | `NOT_FOUND` |
| Set changed since the operator chose it (`expectedGeneration` moved) | `STALE_GENERATION` (409) |
| A member skill is disabled or archived | `CONFLICT` (409) |
| Two members, or a member and an `owner` toolkit, define one skill name with different content | `CONFLICT` (409) |

Do not retry a stale generation with a guessed number: re-read the set in the Dashboard and ask.

## Settling a name conflict

Pass `skillOverrides: { "<skill name>": "<identity>" }`. The identity is the member's `skrev_` revision
id for a library skill, or the 64-character lowercase hex content digest for a toolkit skill.
`skillOverrides` needs at least one `skillSets` or `toolkits` entry. An override that names no
candidate does nothing.

A name-collision refusal happens after the workspace record exists, so retry with `skillOverrides` under a
new `idempotencyKey`; the old key replays the refused open. The error lists the identities to pin.
