# Phase 02 — Nested frontmatter extraction and semver validation

## Problem

The only existing frontmatter reader is a flat regex in
`worker/harness-worker.mjs` `parseSkillDocument` (~L328):

```js
const description = /^\s*description\s*:\s*(.+)$/m.exec(frontmatter);
```

That cannot see a key nested under `metadata:`:

```yaml
---
name: example
description: does a thing
metadata:
  version: 1.2.3
---
```

## Steps

1. Add a small shared parser that reads the nested value by indentation, without
   a YAML dependency:
   - locate the `metadata:` block inside the frontmatter;
   - within that block, match `version:` at a deeper indent;
   - stop at the first key at the `metadata:` indent or shallower.
   Keep it a deliberate subset — it reads one nested scalar, it is not a YAML
   implementation.
2. Add semver validation for the shape `MAJOR.MINOR.PATCH` with optional
   `-prerelease` and `+build`, per semver.org. Reject anything else.
3. Apply it in both places that read a skill document:
   - `worker/harness-worker.mjs` for the roster, where the text is
     attacker-influenceable: validate, bound the length, and degrade to absent
     rather than propagating a hostile value;
   - the runner path that turns `instructions` into a revision.
4. Decide and document the precedence when a caller supplies an explicit
   `version` **and** the `instructions` carry one. Prefer the explicit contract
   field, because that is what the operator chose deliberately.

## Verification

- Extracts `1.2.3`, `1.2.3-rc.1`, `1.2.3+build.5`.
- Ignores `version:` at top level (only `metadata.version` counts).
- Returns absent for missing `metadata`, missing `version`, or a non-mapping
  `metadata:`.
- Rejects `1.2`, `v1.2.3`, `latest`, `1.2.3.4`, empty, and a value with control
  characters or an absurd length.
- Does not confuse a deeper nested key, and stops at the end of the `metadata:`
  block.
